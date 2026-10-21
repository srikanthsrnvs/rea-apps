import { AirbnbError } from './errors.mjs';
// Shipped PhoneOTPRequest.forRequestVerificationCode. Used only as an explicit
// SMS dispatch for an existing native phone sign-in flow.
export function buildPhoneCodeRequest(phone) {
  if (typeof phone !== 'string' || !/^\+[1-9][0-9]{6,14}$/.test(phone)) throw new AirbnbError('INVALID_ARGUMENT', 'Provide a complete international phone number.');
  return { path: 'phone_one_time_passwords', method: 'POST', body: {
    workFlow: 'GLOBAL_SIGNUP_LOGIN', phoneNumber: phone, otpMethod: 'AUTO', appHashType: 'ANDROID',
  } };
}
export function parsePhoneCodeResponse(data, phone) {
  buildPhoneCodeRequest(phone);
  if (data?.success !== true || typeof data.deliveryMethod !== 'string' || !data.deliveryMethod
    || !Number.isSafeInteger(data.codeLength) || data.codeLength < 4 || data.codeLength > 10) {
    throw new AirbnbError('SMS_REQUEST_FAILED', 'Airbnb did not acknowledge a usable phone-code request.');
  }
  if (typeof data.internationalPhoneNumber === 'string') {
    const returned = data.internationalPhoneNumber.replace(/[ ().-]/g, '');
    if (/^\+[1-9][0-9]{6,14}$/.test(returned) && returned !== phone) throw new AirbnbError('AUTH_DESTINATION_MISMATCH', 'Airbnb returned a different phone destination.');
  }
  return { accepted: true, deliveryMethod: data.deliveryMethod, codeLength: data.codeLength };
}
