import test from 'node:test';
import assert from 'node:assert/strict';
import {webSendMagicLinkRequest,webVerifyMagicLinkRequest,exchangeNonceForCodeRequest,parseOfficialMagicLink,WEB_VERIFICATION_KEYS} from '../src/web-auth-protocol.mjs';
const token='test-fixture-not-a-real-proof',magicLink='https://claude.ai/magic-link/android#fixture-nonce:dGVzdEBleGFtcGxlLmludmFsaWQ=';
test('web email request has source-proven minute offset and no invented native client or attestation',()=>{
 const {json}=webSendMagicLinkRequest({email:'test@example.invalid',utcOffsetMinutes:420,token});
 assert.equal(json.utc_offset,420);assert.equal(json.login_intent,null);assert.equal(json.return_to,null);
 assert.equal(json.source,'claude');assert.equal(json.client,undefined);assert.equal(json.play_integrity_token,undefined);assert.equal(json.recaptcha_token,undefined);
 assert.deepEqual(json.client_attestation,{hcaptcha_token:token});assert.notEqual(WEB_VERIFICATION_KEYS.send,WEB_VERIFICATION_KEYS.verify);
});
test('official magic-link nonce and email-code proof requests remain distinct',()=>{
 const nonce=webVerifyMagicLinkRequest({magicLink,token}).json;
 assert.equal(nonce.credentials.method,'nonce');assert.equal(nonce.credentials.nonce_source,undefined);
 assert.equal(nonce.play_integrity_token,undefined);assert.equal(nonce.recaptcha_token,undefined);
 const code=webVerifyMagicLinkRequest({email:'test@example.invalid',code:'123456',token}).json;
 assert.equal(code.credentials.method,'code');assert.equal(code.credentials.code,'123456');
 assert.throws(()=>webVerifyMagicLinkRequest({magicLink,code:'123456',token}),{code:'INVALID_ARGUMENT'});
});
test('button-to-code handoff has no invented proof and cannot accept a foreign credential URL',()=>{
 const operation=exchangeNonceForCodeRequest(magicLink);
 assert.ok(operation.url.endsWith('/exchange_nonce_for_code'));assert.equal(operation.json.client_attestation,undefined);
 assert.equal(parseOfficialMagicLink(magicLink.replace('/android','')).nonce,'fixture-nonce');
 for(const url of [magicLink.replace('claude.ai','example.com'),magicLink.replace('https:','http:'),'https://claude.ai/magic-link#no-colon','https://claude.ai/magic-link#%GG:x'])assert.throws(()=>parseOfficialMagicLink(url),{code:'INVALID_ARGUMENT'});
});
