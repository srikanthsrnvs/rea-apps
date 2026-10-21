import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhoneCodeRequest, parsePhoneCodeResponse } from '../src/phone-code-protocol.mjs';
test('explicit phone dispatch uses the shipped workflow and preserves international number', () => {
  assert.deepEqual(buildPhoneCodeRequest('+15555550123'), { path: 'phone_one_time_passwords', method: 'POST', body: { workFlow: 'GLOBAL_SIGNUP_LOGIN', phoneNumber: '+15555550123', otpMethod: 'AUTO', appHashType: 'ANDROID' } });
  assert.throws(() => buildPhoneCodeRequest('5555550123'), { code: 'INVALID_ARGUMENT' });
});
test('only explicit server acknowledgement becomes accepted dispatch, never carrier delivery', () => {
  const response = { success: true, deliveryMethod: 'TEXT', codeLength: 6, internationalPhoneNumber: '' };
  assert.deepEqual(parsePhoneCodeResponse(response, '+15555550123'), { accepted: true, deliveryMethod: 'TEXT', codeLength: 6 });
  for (const value of [{}, { ...response, success: false }, { ...response, codeLength: 0 }]) assert.throws(() => parsePhoneCodeResponse(value, '+15555550123'), { code: 'SMS_REQUEST_FAILED' });
  assert.throws(() => parsePhoneCodeResponse({ ...response, internationalPhoneNumber: '+1 (555) 555-0124' }, '+15555550123'), { code: 'AUTH_DESTINATION_MISMATCH' });
});
