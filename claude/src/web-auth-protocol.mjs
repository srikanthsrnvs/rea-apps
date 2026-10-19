import {normalizeEmail} from './auth-protocol.mjs';
import {ClaudeError} from './errors.mjs';
export const WEB_VERIFICATION_KEYS={send:'f1b21a9c-9100-4022-a928-8d5c29de2e6a',verify:'a8086506-2036-46f4-ae50-00d8be805efa'};
const fail=message=>{throw new ClaudeError('INVALID_ARGUMENT',message);};
const request=(action,json)=>({url:`https://claude.ai/api/auth/${action}`,method:'POST',json:{...json,source:'claude'}});
function text(value,label,max=8192){if(typeof value!=='string'||!value||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(`Invalid ${label}.`);return value;}
export function parseOfficialMagicLink(value){
 let url;try{url=new URL(text(value,'magic link',16384));}catch{fail('Expected an official Claude magic link.');}
 if(url.origin!=='https://claude.ai'||!['/magic-link','/magic-link/android'].includes(url.pathname)||url.username||url.password)fail('Expected an official Claude magic link.');
 let parts;try{parts=decodeURIComponent(url.hash.slice(1)).split(':');}catch{fail('Invalid magic link credentials.');}
 if(parts.length!==2)fail('Invalid magic link credentials.');
 return {nonce:text(parts[0],'nonce'),encoded_email_address:text(parts[1],'encoded email address')};
}
export function webSendMagicLinkRequest({email,utcOffsetMinutes=new Date().getTimezoneOffset(),token}={}){
 if(!Number.isInteger(utcOffsetMinutes)||Math.abs(utcOffsetMinutes)>1440)fail('Invalid UTC offset in minutes.');
 return request('send_magic_link',{email_address:normalizeEmail(email),utc_offset:utcOffsetMinutes,login_intent:null,return_to:null,client_attestation:{hcaptcha_token:text(token,'browser verification token',20000)}});
}
export function webVerifyMagicLinkRequest({magicLink,email,code,token}={}){
 if((magicLink!==undefined)===(code!==undefined))fail('Provide exactly one email code or magic link.');
 let credentials;
 if(magicLink!==undefined)credentials={method:'nonce',...parseOfficialMagicLink(magicLink)};
 else{code=text(code,'email code',128).trim();if(!/^[A-Za-z0-9]+$/.test(code))fail('Invalid email code.');credentials={method:'code',email_address:normalizeEmail(email),code};}
 return request('verify_magic_link',{credentials,client_attestation:{hcaptcha_token:text(token,'browser verification token',20000)}});
}
export function exchangeNonceForCodeRequest(magicLink){return request('exchange_nonce_for_code',parseOfficialMagicLink(magicLink));}
