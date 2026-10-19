import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { ClaudeError } from './errors.mjs';
import { ClaudeClient } from './http.mjs';
import { createProfile, nativeHeaders, verificationHeaders, API_ORIGIN } from './client-profile.mjs';
import { readState, saveState, removeState, withStateLock } from './state.mjs';
import {normalizeEmail,sendMagicLinkRequest,parseSendMagicLinkResponse,parseVerifyResponse} from './auth-protocol.mjs';
import {webVerifyMagicLinkRequest,WEB_VERIFICATION_KEYS} from './web-auth-protocol.mjs';
import {findVerificationTunnel,startBrowserVerification,browserVerificationStatus,takeBrowserVerification,stopBrowserVerification,removeBrowserVerification} from './verification-client.mjs';

const fail=(code,message,details)=>{throw new ClaudeError(code,message,details);};
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value??'');
const binding=session=>session?createHash('sha256').update(JSON.stringify([session.account?.uuid,session.profile?.deviceId,session.generation])).digest('hex'):null;
const masked=email=>email.replace(/^(.).*(@.*)$/,'$1***$2');
function accountSummary(account){return {id:account.uuid,email:account.email_address,name:account.display_name||account.full_name||null};}
function publicPending(pending){return {loginId:pending.id,status:pending.phase,email:masked(pending.email),localExpiresAt:pending.localExpiresAt,...(pending.challenge?{challenge:pending.challenge}:{}),...(pending.verificationKind?{verificationKind:pending.verificationKind}:{}),...(pending.approvalUrl?{approvalUrl:pending.approvalUrl}:{}),...(pending.verification?.httpStatus>=400?{verificationHttpStatus:pending.verification.httpStatus}:{})};}
async function request(client,operation){
 const response=await client.request(operation.url,{...operation,responseType:'response'});
 let payload;try{payload=JSON.parse(response.text);}catch{payload=null;}
 return {httpStatus:response.status,payload,...(payload===null?{bodyText:response.text}:{}),headers:Object.fromEntries(response.headers),receivedAt:new Date().toISOString(),cookies:client.jar.cookies};
}
function successful(result,code,message){if(result?.httpStatus!==200)fail(code,message,{httpStatus:result?.httpStatus??null});}
function parseAccount(payload){
 if(!payload||!uuid(payload.uuid)||typeof payload.email_address!=='string')fail('ACCOUNT_NOT_VALIDATED','Claude did not independently return an account.');
 normalizeEmail(payload.email_address);return payload;
}
function checkBinding(pending,session){if(binding(session)!==pending.previousBinding&&binding(session)!==pending.committedBinding)fail('SESSION_CHANGED','The saved account changed during login. Its credentials were preserved.');}
export async function login({email,replace=false}={}){
 return withStateLock(async()=>{
  const session=await readState('session');
  if(session&&!replace)return {status:'authenticated',account:accountSummary(session.account),validatedAt:session.validatedAt};
  const previous=await readState('pending-login');
  if(previous&&(previous.phase!=='code_required'||Date.parse(previous.localExpiresAt)>Date.now()))return publicPending(previous);
  email=normalizeEmail(email);
  const pending={id:randomUUID(),email,profile:createProfile(),previousBinding:binding(session),phase:'delivery_pending',localExpiresAt:new Date(Date.now()+30*60000).toISOString()};
  const operation=sendMagicLinkRequest({email,utcOffset:-new Date().getTimezoneOffset(),issuedAt:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64')});
  await saveState('pending-login',pending);
  const client=new ClaudeClient({headers:nativeHeaders(pending.profile)});
  pending.delivery=await request(client,operation);pending.phase='delivery_received';await saveState('pending-login',pending);
  return finishDelivery(pending);
 });
}
async function finishDelivery(pending){
 successful(pending.delivery,'LOGIN_DELIVERY_REJECTED','Claude did not accept the sign-in email request. No request was automatically retried.');
 const result=parseSendMagicLinkResponse(pending.delivery.payload);
 if(result.status!=='email_sent'){
  pending.phase='additional_verification_required';pending.verificationKind=result.status;await saveState('pending-login',pending);
  return {...publicPending(pending),...(result.url?{approvalUrl:result.url}:{})};
 }
 pending.challenge={channel:'email',codeLength:result.codeConfiguration?.length??null,charset:result.codeConfiguration?.charset??null};
 pending.phase='code_required';await saveState('pending-login',pending);return publicPending(pending);
}
export async function completeLogin({loginId,code,magicLink,deferVerificationCleanup=false}={}){
 let completedVerification;
 const result=await withStateLock(async()=>{
  const pending=await readState('pending-login');
  if(!pending||pending.id!==loginId)fail('LOGIN_NOT_FOUND','Use the loginId returned by login.');
  checkBinding(pending,await readState('session'));
  if(pending.phase==='delivery_received')return finishDelivery(pending);
  const phases=['code_required','verification_starting','verification_waiting','verification_received','validation_pending','validation_received','commit_pending'];
  if(!phases.includes(pending.phase))fail('LOGIN_OUTCOME_UNKNOWN','A previous login step has an uncertain outcome and was not repeated. Inspect auth status before starting again.');
  if(pending.phase==='code_required'){
   if(Date.parse(pending.localExpiresAt)<=Date.now())fail('LOGIN_EXPIRED','This local login attempt expired. Cancel it and start another.');
   if((code!==undefined)===(magicLink!==undefined))fail('INVALID_ARGUMENT','Provide either an email code or the official magic link from that same sign-in email.');
   if(code!==undefined&&pending.challenge?.codeLength&&code.length!==pending.challenge.codeLength)fail('INVALID_ARGUMENT','The code length does not match the sign-in email challenge.');
   // Validate credentials before creating a helper or consuming any proof.
   webVerifyMagicLinkRequest({email:pending.email,code,magicLink,token:'local-validation-only-never-submitted'});
   pending.verificationInput=magicLink!==undefined?{magicLink}:{code};
   pending.phase='verification_starting';await saveState('pending-login',pending);
  }
  if(pending.phase==='verification_starting'){
   const executable=await findVerificationTunnel();
   pending.browserVerification=await startBrowserVerification(pending.id,{publicKey:WEB_VERIFICATION_KEYS.verify},executable);
   const status=await browserVerificationStatus(pending.browserVerification);
   pending.approvalUrl=status?.url;pending.phase='verification_waiting';await saveState('pending-login',pending);
   return publicPending(pending);
  }
  if(pending.phase==='verification_waiting'){
   const status=await browserVerificationStatus(pending.browserVerification);
   if(status?.status==='waiting')return publicPending(pending);
   if(status?.status!=='completed')fail('VERIFICATION_REQUIRED','The official browser verification did not complete. Cancel this login and start again.',{verificationStatus:status?.status??'missing'});
   const token=await takeBrowserVerification(pending.browserVerification,WEB_VERIFICATION_KEYS.verify);
   const operation=webVerifyMagicLinkRequest({email:pending.email,...pending.verificationInput,token});
   pending.phase='verification_pending';await saveState('pending-login',pending);
   const client=new ClaudeClient({cookies:pending.delivery.cookies,headers:verificationHeaders(pending.profile)});
   pending.verification=await request(client,operation);pending.phase='verification_received';await saveState('pending-login',pending);
  }
  if(pending.phase==='verification_received'){
   successful(pending.verification,'LOGIN_VERIFICATION_REJECTED','Claude did not accept this verification. Any saved account was preserved.');
   const verified=parseVerifyResponse(pending.verification.payload);
   if(verified.status!=='authenticated'){
    pending.phase='additional_verification_required';pending.verificationKind=verified.status;await saveState('pending-login',pending);return publicPending(pending);
   }
   if(verified.email.toLowerCase()!==pending.email.toLowerCase())fail('ACCOUNT_MISMATCH','Claude returned a different account email. The saved account was preserved.');
   if(!pending.verification.cookies.some(cookie=>cookie.name==='sessionKey'&&cookie.value))fail('SESSION_COOKIE_MISSING','Claude returned no session cookie. The account was not saved.');
   pending.candidate={profile:pending.profile,account:verified.account,cookies:pending.verification.cookies,generation:pending.id};
   pending.phase='validation_pending';await saveState('pending-login',pending);
  }
  if(pending.phase==='validation_pending'){
   const client=new ClaudeClient({cookies:pending.candidate.cookies,headers:nativeHeaders(pending.profile)});
   pending.validation=await request(client,{url:`${API_ORIGIN}/api/account`,method:'GET'});pending.phase='validation_received';await saveState('pending-login',pending);
  }
  if(pending.phase==='validation_received'){
   successful(pending.validation,'ACCOUNT_NOT_VALIDATED','Claude did not independently validate the new session. The saved account was preserved.');
   const account=parseAccount(pending.validation.payload);
   if(account.uuid!==pending.candidate.account.uuid||account.email_address.toLowerCase()!==pending.email.toLowerCase())fail('ACCOUNT_MISMATCH','Independent account validation returned a different identity.');
   pending.completedSession={...pending.candidate,account,cookies:pending.validation.cookies,validatedAt:pending.validation.receivedAt};
   pending.completedSession.authType='session_cookie';
   pending.committedBinding=binding(pending.completedSession);pending.phase='commit_pending';await saveState('pending-login',pending);
  }
  checkBinding(pending,await readState('session'));
  if(binding(pending.completedSession)!==pending.committedBinding)fail('INVALID_LOGIN_STATE','The saved login result is incomplete.');
  await saveState('session',pending.completedSession);await removeState('pending-login');
  completedVerification=pending.browserVerification;
  return {status:'authenticated',account:accountSummary(pending.completedSession.account),validation:'independent_account_read'};
 });
 if(completedVerification&&!deferVerificationCleanup)await removeBrowserVerification(completedVerification);
 return result;
}
export async function authStatus(){return withStateLock(async()=>{
 const session=await readState('session'),pending=await readState('pending-login');
 const verification=pending?.browserVerification?await browserVerificationStatus(pending.browserVerification):null;
 return {authenticated:!!session,account:session?accountSummary(session.account):null,authType:session?.authType??(session?'session_cookie':null),validatedAt:session?.validatedAt??null,pending:pending?{...publicPending(pending),...(verification?{verification}:{})}:null};
});}
export async function cancelLogin({loginId}={}){let verification;const result=await withStateLock(async()=>{
 for(const record of ['pending-login']){const pending=await readState(record);if(pending?.id===loginId){verification=pending.browserVerification;await stopBrowserVerification(verification);await removeState(record);return {status:'cancelled'};}}
 fail('LOGIN_NOT_FOUND','Use the current loginId.');
});if(verification)await removeBrowserVerification(verification);return result;}
export async function logout(){let verification;const result=await withStateLock(async()=>{const pending=await readState('pending-login');verification=pending?.browserVerification;await stopBrowserVerification(verification);await removeState('session');await removeState('pending-login');return {status:'logged_out'};});if(verification)await removeBrowserVerification(verification);return result;}
export async function withClient(operation,{authenticated=true}={}){
 return withStateLock(async()=>{
  const session=await readState('session');if(authenticated&&!session)fail('LOGIN_REQUIRED','Use claude-chat login with your existing account email.');
  const client=new ClaudeClient({cookies:session?.cookies,headers:session?nativeHeaders(session.profile):{}});
  try{return await operation(client,session);}finally{if(session)await saveState('session',{...session,cookies:client.jar.cookies});}
 });
}
export const sessionBinding=binding;
