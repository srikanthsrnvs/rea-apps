import test from 'node:test';
import assert from 'node:assert/strict';
import {createContext,pkceChallenge} from '../src/protocol.mjs';
import {startLogin,completeLogin,pollLogin,validateLogin,cancelLogin,logout} from '../src/auth.mjs';

const time = 1_700_000_000_000;
const operationKey = 'operation-11111111-1111-4111-8111-111111111111';
const otherLoginId = '22222222-2222-4222-8222-222222222222';
const clone = value => value === undefined ? undefined : structuredClone(value);
const error = (code,status) => Object.assign(new Error('Synthetic request failure'),{code,status});
const smsForm = {flowType:'INITIAL',screens:[{screenType:'PHONE_OTP',eventType:'TypeSMSOTP',fields:[
  {fieldType:'PHONE_SMS_OTP',otpWidth:4,hintValue:'•••0100'},
]}]};
const emailForm = {flowType:'SIGN_IN',screens:[{screenType:'EMAIL_OTP_CODE',eventType:'TypeEmailOTP',fields:[
  {fieldType:'EMAIL_OTP_CODE',otpWidth:6,hintValue:'t•••@example.test'},
]}]};
const initial = {inAuthSessionID:'initial-session',form:{flowType:'INITIAL',screens:[
  {screenType:'SOCIAL',eventType:'TypeFacebookAuthCode',fields:[{fieldType:'FACEBOOK_AUTH_CODE'}]},
]},alternateForms:[smsForm]};
const nextCode = {inAuthSessionID:'second-session',form:{flowType:'SIGN_IN',screens:[
  {screenType:'SECONDARY_PHONE_OTP',eventType:'TypeSecondarySMSOTP',fields:[{fieldType:'SECONDARY_PHONE_SMS_OTP'}]},
]},alternateForms:[emailForm]};
const verification = {inAuthSessionID:'verification-session',form:{flowType:'SIGN_IN',screens:[
  {screenType:'SESSION_VERIFICATION',eventType:'TypeVerifySession',fields:[
    {fieldType:'SESSION_VERIFICATION_CODE',authCode:'synthetic-auth-code'},
    {fieldType:'CODE_VERIFIER'},
  ]},
]}};
const oauth = {oAuthInfo:{accessToken:'synthetic-access-token',refreshToken:'synthetic-refresh-token',
  expiresIn:{high:0,low:3600,unsigned:false},refreshTokenExpiresIn:{high:0,low:7200,unsigned:false}},
userUUID:'synthetic-rider',apiToken:'synthetic-api-token',authSessionID:'synthetic-auth-session'};

function memory(seed) {
  const values = new Map(Object.entries(seed).map(([key,value]) => [key,clone(value)]));
  const writes = [];
  let tail = Promise.resolve();
  const store = {
    locked:false,
    async readState(key) { return clone(values.get(key) ?? null); },
    async saveState(key,value) { values.set(key,clone(value)); writes.push({key,value:clone(value)}); },
    async removeState(key) { values.delete(key); },
    async withStateLock(operation) {
      const run = tail.then(async () => { store.locked = true; try { return await operation(); } finally { store.locked = false; } });
      tail = run.catch(() => {});
      return run;
    },
  };
  return {store,values,writes};
}

function fixture({twoSteps=false,intercept} = {}) {
  const context = createContext();
  const priorSession = {accessToken:'prior-synthetic-token',context,validatedAt:time-1000};
  const journal = {state:'unknown',kind:'booking',context:{userUUID:'prior-synthetic-rider'}};
  const {store,values,writes} = memory({context,session:priorSession,[operationKey]:journal});
  let clock = time;
  const calls = [];
  async function send(sentContext,endpoint,body,token,options) {
    assert.equal(store.locked,true,'authentication requests must run under the state mutex');
    const event = body.formContainerAnswer?.formAnswer?.screenAnswers?.[0]?.eventType;
    const stage = endpoint.endsWith('prepare-field') ? 'prepare' : endpoint.endsWith('devices/exemption') ? 'exemption'
      : endpoint.endsWith('riders/me/status') ? 'status' : event === 'TypeInputMobile' ? 'initial'
        : event === 'TypeVerifySession' ? 'exchange' : 'code';
    const call = {stage,endpoint,body:clone(body),token,options:clone(options),context:clone(sentContext)};
    calls.push(call);
    const override = await intercept?.(call,{store,values,calls});
    if (override !== undefined) return clone(override);
    if (stage === 'initial') return clone(initial);
    if (stage === 'prepare') return {success:true,formContainer:{
      inAuthSessionID:body.request.fieldType === 'EMAIL_OTP_CODE' ? 'prepared-email-session' : 'prepared-sms-session',
      form:clone(body.request.fieldType === 'EMAIL_OTP_CODE' ? emailForm : smsForm),alternateForms:[],
    }};
    if (stage === 'code') return clone(twoSteps && event === 'TypeSMSOTP' ? nextCode : verification);
    if (stage === 'exchange') return clone(oauth);
    if (stage === 'exemption') return {token:'synthetic-integrity-token',metadata:{expiry:Math.floor(clock/1000)+600}};
    if (stage === 'status') return {riderAppOrdersResponse:{orders:[]}};
    assert.fail(`Unexpected synthetic endpoint ${endpoint}`);
  }
  return {store,values,writes,calls,priorSession,journal,options:{store,send,now:() => clock},advance(ms) {clock += ms;}};
}

test('repeating the same normalized phone, including concurrent starts, reuses its code without another SMS', async () => {
  const f = fixture();
  const [first,second] = await Promise.all([
    startLogin({phone:'4155550100'},f.options),
    startLogin({phone:'+1 (415) 555-0100'},f.options),
  ]);
  assert.equal(first.status,'waiting_for_code');
  assert.equal(first.loginId,second.loginId);
  assert.deepEqual(f.calls.map(call => call.stage),['initial','prepare']);
  assert.equal((await pollLogin({loginId:first.loginId},f.options)).status,'waiting_for_code');
  await assert.rejects(startLogin({phone:'4155550101'},f.options),{code:'LOGIN_PENDING'});
  assert.equal(f.calls.length,2);
  assert.deepEqual(await f.store.readState('session'),f.priorSession);
});

test('two server-requested codes exchange one PKCE session and promote only after exemption and valid rider status', async () => {
  const f = fixture({twoSteps:true,intercept:async ({stage},{store}) => {
    if (stage === 'exemption' || stage === 'status') assert.deepEqual(await store.readState('session'),f.priorSession);
  }});
  const started = await startLogin({phone:'4155550100'},f.options);
  const afterSms = await completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options);
  assert.equal(afterSms.status,'waiting_for_code');
  assert.equal(afterSms.challenge.channel,'email');
  assert.equal(afterSms.challenge.codeLength,6);
  assert.notEqual(afterSms.challenge.id,started.challenge.id);
  assert.deepEqual(await f.store.readState('session'),f.priorSession);
  const done = await completeLogin({loginId:started.loginId,challengeId:afterSms.challenge.id,code:'000123'},f.options);
  assert.equal(done.status,'authenticated');
  assert.equal(done.loggedIn,true);
  assert.deepEqual(f.calls.map(call => call.stage),['initial','prepare','code','prepare','code','exchange','exemption','status']);
  const initialBody = f.calls[0].body.formContainerAnswer.formAnswer;
  const exchange = f.calls.find(call => call.stage === 'exchange').body.formContainerAnswer;
  const verifier = exchange.formAnswer.screenAnswers[0].fieldAnswers.find(field => field.fieldType === 'CODE_VERIFIER').codeVerifier;
  assert.equal(initialBody.codeChallenge,pkceChallenge(verifier));
  assert.equal(exchange.inAuthSessionID,'verification-session');
  assert.equal(exchange.formAnswer.screenAnswers[0].fieldAnswers[0].sessionVerificationCode,'synthetic-auth-code');
  for (const call of f.calls.filter(call => call.stage === 'code')) {
    assert.equal(call.body.formContainerAnswer.formAnswer.codeChallenge,initialBody.codeChallenge);
    assert.equal(Object.hasOwn(call.body.formContainerAnswer.formAnswer,'appContext'),false);
  }
  const statusCall = f.calls.find(call => call.stage === 'status');
  assert.equal(statusCall.token,'synthetic-access-token');
  assert.equal(statusCall.options.integrityToken,'synthetic-integrity-token');
  assert.equal((await f.store.readState('session')).accessToken,'synthetic-access-token');
  assert.equal((await f.store.readState('integrity')).contextDeviceId,f.calls[0].context.deviceId);
  assert.equal(await f.store.readState('candidate-session'),null);
  assert.deepEqual(await f.store.readState(operationKey),f.journal);
  assert.equal(JSON.stringify(done).includes('synthetic-access-token'),false);
});

test('concurrent completion calls cannot submit an old SMS code to the subsequent email challenge', async () => {
  const f = fixture({twoSteps:true,intercept:({stage,body}) => {
    if (stage === 'prepare' && body.request.fieldType === 'EMAIL_OTP_CODE') {
      const form = clone(emailForm);
      form.screens[0].fields[0].otpWidth = 4;
      return {success:true,formContainer:{inAuthSessionID:'prepared-email-session',form,alternateForms:[]}};
    }
  }});
  const started = await startLogin({phone:'4155550100'},f.options);
  const answer = {loginId:started.loginId,challengeId:started.challenge.id,code:'0012'};
  const [accepted,duplicate] = await Promise.allSettled([
    completeLogin(answer,f.options),completeLogin(answer,f.options),
  ]);
  assert.equal(accepted.status,'fulfilled');
  assert.equal(accepted.value.challenge.channel,'email');
  assert.equal(accepted.value.challenge.codeLength,4);
  assert.notEqual(accepted.value.challenge.id,started.challenge.id);
  assert.equal(duplicate.status,'rejected');
  assert.equal(duplicate.reason.code,'LOGIN_CHALLENGE_MISMATCH');
  assert.deepEqual(f.calls.map(call => call.stage),['initial','prepare','code','prepare']);
  const submitted = f.calls.filter(call => call.stage === 'code');
  assert.equal(submitted.length,1);
  assert.equal(submitted[0].body.formContainerAnswer.formAnswer.screenAnswers[0].eventType,'TypeSMSOTP');
});

test('a definitely rejected wrong code retains the challenge and permits corrected submission without resend', async () => {
  let wrong = true;
  const f = fixture({intercept:({stage}) => {if (stage === 'code' && wrong) {wrong = false; throw error('SMS_OTP_INCORRECT',400);}}});
  const started = await startLogin({phone:'4155550100'},f.options);
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'1111'},f.options),{code:'SMS_OTP_INCORRECT'});
  assert.equal((await pollLogin({},f.options)).status,'waiting_for_code');
  const done = await completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options);
  assert.equal(done.status,'authenticated');
  assert.equal(f.calls.filter(call => call.stage === 'prepare').length,1);
  assert.equal(f.calls.filter(call => call.stage === 'code').length,2);
  assert.equal(f.calls.filter(call => call.stage === 'exchange').length,1);
});

test('a server error labeled as an incorrect code remains uncertain and cannot permit implicit resubmission', async () => {
  const f = fixture({intercept:({stage}) => {if (stage === 'code') throw error('SMS_OTP_INCORRECT',503);}});
  const started = await startLogin({phone:'4155550100'},f.options);
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options),{code:'SMS_OTP_INCORRECT'});
  const count = f.calls.length;
  assert.equal((await pollLogin({},f.options)).status,'outcome_unknown');
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options),{code:'LOGIN_CODE_NOT_EXPECTED'});
  assert.equal(f.calls.length,count);
});

test('uncertain request failures become terminal unknown outcomes and are never implicitly replayed', async t => {
  for (const failStage of ['initial','prepare','code','exchange']) await t.test(failStage,async () => {
    const f = fixture({intercept:({stage}) => {if (stage === failStage) throw error('network_error');}});
    let started;
    if (failStage === 'initial' || failStage === 'prepare') await assert.rejects(startLogin({phone:'4155550100'},f.options),{code:'network_error'});
    else {
      started = await startLogin({phone:'4155550100'},f.options);
      await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options),{code:'network_error'});
    }
    const count = f.calls.length;
    assert.equal((await pollLogin({},f.options)).status,'outcome_unknown');
    await assert.rejects(startLogin({phone:'4155550100'},f.options),{code:'LOGIN_OUTCOME_UNKNOWN'});
    await assert.rejects(completeLogin({code:'0012'},f.options),{code:'LOGIN_CODE_NOT_EXPECTED'});
    assert.equal(f.calls.length,count);
    assert.deepEqual(await f.store.readState('session'),f.priorSession);
  });
});

test('a crashed busy record is recovered locally without resending code or exchanging OAuth', async t => {
  for (const status of ['starting','preparing','submitting','exchanging']) await t.test(status,async () => {
    const f = fixture();
    const started = await startLogin({phone:'4155550100'},f.options);
    const pending = await f.store.readState('login');
    await f.store.saveState('login',{...pending,status});
    const count = f.calls.length;
    assert.equal((await pollLogin({loginId:started.loginId},f.options)).status,'outcome_unknown');
    await assert.rejects(startLogin({phone:'4155550100'},f.options),{code:'LOGIN_OUTCOME_UNKNOWN'});
    assert.equal(f.calls.length,count);
    assert.deepEqual(await f.store.readState('session'),f.priorSession);
  });
});

test('stale IDs, expired attempts and malformed codes are rejected before an API request', async () => {
  const f = fixture();
  const started = await startLogin({phone:'4155550100'},f.options);
  const count = f.calls.length;
  for (const operation of [completeLogin,validateLogin,pollLogin,cancelLogin]) {
    await assert.rejects(operation({loginId:otherLoginId,code:'0012'},f.options),{code:'LOGIN_ID_MISMATCH'});
  }
  await assert.rejects(completeLogin({loginId:started.loginId,code:'0012'},f.options),{code:'LOGIN_CHALLENGE_MISMATCH'});
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:otherLoginId,code:'0012'},f.options),{code:'LOGIN_CHALLENGE_MISMATCH'});
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'abc1'},f.options),{code:'INVALID_CODE'});
  assert.equal(f.calls.length,count);
  f.advance(15*60*1000+1);
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options),{code:'LOGIN_CODE_NOT_EXPECTED'});
  assert.equal((await pollLogin({},f.options)).status,'expired');
  assert.equal(f.calls.length,count);
  assert.deepEqual(await f.store.readState('session'),f.priorSession);
});

test('candidate validation can retry without repeating the successful OAuth exchange or replacing a prior session early', async t => {
  for (const failStage of ['exemption','status']) await t.test(failStage,async () => {
    let fail = true;
    const f = fixture({intercept:async ({stage},{store}) => {
      if (stage === 'exemption' || stage === 'status') assert.deepEqual(await store.readState('session'),f.priorSession);
      if (stage === failStage && fail) {fail = false; throw error('network_error');}
    }});
    const started = await startLogin({phone:'4155550100'},f.options);
    await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options),{code:'network_error'});
    assert.equal((await pollLogin({},f.options)).status,'validation_pending');
    assert.equal((await f.store.readState('candidate-session')).accessToken,'synthetic-access-token');
    assert.deepEqual(await f.store.readState('session'),f.priorSession);
    await assert.rejects(completeLogin({code:'0012'},f.options),{code:'LOGIN_CODE_NOT_EXPECTED'});
    const done = await validateLogin({loginId:started.loginId},f.options);
    assert.equal(done.status,'authenticated');
    assert.equal(f.calls.filter(call => call.stage === 'exchange').length,1);
    assert.equal(f.calls.filter(call => call.stage === 'code').length,1);
  });
});

test('a crash after candidate persistence resumes validation and never repeats the OAuth exchange', async () => {
  let failValidation = true;
  const f = fixture({intercept:({stage}) => {
    if (stage === 'exemption' && failValidation) {failValidation = false; throw error('network_error');}
  }});
  const started = await startLogin({phone:'4155550100'},f.options);
  const awaitingCode = await f.store.readState('login');
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options),{code:'network_error'});
  assert.ok(await f.store.readState('candidate-session'));
  // Simulate the durable ordering window: candidate written, but the next
  // login-state write did not complete before the process exited.
  await f.store.saveState('login',{...awaitingCode,status:'exchanging'});
  const count = f.calls.length;
  assert.equal((await pollLogin({loginId:started.loginId},f.options)).status,'validation_pending');
  assert.equal(f.calls.length,count);
  assert.deepEqual(await f.store.readState('session'),f.priorSession);
  const done = await validateLogin({loginId:started.loginId},f.options);
  assert.equal(done.status,'authenticated');
  assert.equal(f.calls.filter(call => call.stage === 'exchange').length,1);
  assert.equal(f.calls.filter(call => call.stage === 'code').length,1);
});

test('HTTP success with an expired exemption or unrecognized rider-status body never promotes the candidate', async t => {
  for (const bad of ['expired-exemption','unrecognized-status']) await t.test(bad,async () => {
    const f = fixture({intercept:({stage}) => {
      if (bad === 'expired-exemption' && stage === 'exemption') return {token:'synthetic-integrity-token',metadata:{expiry:Math.floor(time/1000)}};
      if (bad === 'unrecognized-status' && stage === 'status') return {};
    }});
    const started = await startLogin({phone:'4155550100'},f.options);
    await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options));
    assert.equal((await pollLogin({},f.options)).status,'validation_pending');
    assert.deepEqual(await f.store.readState('session'),f.priorSession);
    assert.equal(f.calls.filter(call => call.stage === 'exchange').length,1);
  });
});

test('an already-expired validation candidate fails locally without another exemption or token exchange', async () => {
  const f = fixture({intercept:({stage}) => {if (stage === 'exemption') throw error('network_error');}});
  const started = await startLogin({phone:'4155550100'},f.options);
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options));
  const candidate = await f.store.readState('candidate-session');
  await f.store.saveState('candidate-session',{...candidate,expiresAt:time-1});
  const count = f.calls.length;
  await assert.rejects(validateLogin({loginId:started.loginId},f.options),{code:'LOGIN_CANDIDATE_EXPIRED'});
  assert.equal(f.calls.length,count);
  assert.deepEqual(await f.store.readState('session'),f.priorSession);
});

test('missing, zero or malformed OAuth expiry cannot replace a prior session or replay the successful exchange', async t => {
  for (const expiry of ['missing','zero','invalid']) await t.test(expiry,async () => {
    const f = fixture({intercept:({stage}) => {
      if (stage !== 'exchange') return undefined;
      const payload = clone(oauth);
      if (expiry === 'missing') delete payload.oAuthInfo.expiresIn;
      else if (expiry === 'zero') payload.oAuthInfo.expiresIn = {high:0,low:0,unsigned:false};
      else payload.oAuthInfo.expiresIn = '3600';
      return payload;
    }});
    const started = await startLogin({phone:'4155550100'},f.options);
    await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options));
    assert.equal((await pollLogin({},f.options)).status,'outcome_unknown');
    assert.equal(await f.store.readState('candidate-session'),null);
    assert.deepEqual(await f.store.readState('session'),f.priorSession);
    const count = f.calls.length;
    await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options),{code:'LOGIN_CODE_NOT_EXPECTED'});
    await assert.rejects(startLogin({phone:'4155550100'},f.options),{code:'LOGIN_OUTCOME_UNKNOWN'});
    await assert.rejects(validateLogin({loginId:started.loginId},f.options),{code:'LOGIN_VALIDATION_NOT_PENDING'});
    assert.equal(f.calls.length,count);
    assert.equal(f.calls.filter(call => call.stage === 'exchange').length,1);
    assert.equal(f.calls.filter(call => call.stage === 'exemption' || call.stage === 'status').length,0);
  });
});

test('a persisted candidate with unknown expiry cannot be validated or promoted', async () => {
  const f = fixture({intercept:({stage}) => {if (stage === 'exemption') throw error('network_error');}});
  const started = await startLogin({phone:'4155550100'},f.options);
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options));
  const candidate = await f.store.readState('candidate-session');
  await f.store.saveState('candidate-session',{...candidate,expiresAt:null});
  const count = f.calls.length;
  await assert.rejects(validateLogin({loginId:started.loginId},f.options),{code:'LOGIN_PROTOCOL_CHANGED'});
  assert.equal(f.calls.length,count);
  assert.deepEqual(await f.store.readState('session'),f.priorSession);
});

test('cancel preserves the prior authenticated session and mutation journals; logout removes credentials and preserves journals', async () => {
  const f = fixture({intercept:({stage}) => {if (stage === 'exemption') throw error('network_error');}});
  const started = await startLogin({phone:'4155550100'},f.options);
  await assert.rejects(completeLogin({loginId:started.loginId,challengeId:started.challenge.id,code:'0012'},f.options));
  assert.ok(await f.store.readState('candidate-session'));
  const count = f.calls.length;
  assert.equal((await cancelLogin({loginId:started.loginId},f.options)).status,'canceled');
  assert.equal(await f.store.readState('candidate-session'),null);
  assert.deepEqual(await f.store.readState('session'),f.priorSession);
  assert.deepEqual(await f.store.readState(operationKey),f.journal);
  await f.store.saveState('pending-login',{verifier:'synthetic-browser-verifier'});
  await f.store.saveState('last-login-response',{body:{synthetic:'private'}});
  assert.deepEqual(await logout(f.options),{loggedOut:true});
  assert.equal(await f.store.readState('session'),null);
  assert.equal(await f.store.readState('pending-login'),null);
  assert.equal(await f.store.readState('last-login-response'),null);
  assert.deepEqual(await f.store.readState(operationKey),f.journal);
  assert.equal(f.calls.length,count);
});
