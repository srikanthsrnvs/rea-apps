import { pkceChallenge } from './protocol.mjs';

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim() !== '';
const codeTypes = Object.freeze([
  {
    channel: 'sms',
    screenType: 'PHONE_OTP',
    eventType: 'TypeSMSOTP',
    fieldType: 'PHONE_SMS_OTP',
    answerKey: 'phoneSMSOTP',
  },
  {
    channel: 'email',
    screenType: 'EMAIL_OTP_CODE',
    eventType: 'TypeEmailOTP',
    fieldType: 'EMAIL_OTP_CODE',
    answerKey: 'emailOTPCode',
  },
]);

/** Country calling code and national number remain separate on Uber's wire. */
export function normalizePhone(phone, countryCode = '1') {
  if (
    typeof phone !== 'string' ||
    !phone.trim() ||
    !/^\+?[0-9\s().-]+$/.test(phone.trim())
  ) {
    throw new Error('Phone must contain a phone number, without extensions');
  }
  const callingCode = String(countryCode).trim().replace(/^\+/, '');
  if (!/^[1-9][0-9]{0,2}$/.test(callingCode))
    throw new Error('Country code must contain one to three digits');
  const international = phone.trim().startsWith('+');
  let number = phone.replace(/[^0-9]/g, '');
  if (international) {
    if (!number.startsWith(callingCode))
      throw new Error('Phone prefix does not match the selected country code');
    number = number.slice(callingCode.length);
  }
  if (
    number.length < 4 ||
    number.length + callingCode.length > 15 ||
    /^0+$/.test(number)
  ) {
    throw new Error(
      'Phone number length is outside the supported international range',
    );
  }
  if (callingCode === '1' && number.length !== 10) {
    throw new Error(
      'Country code 1 requires a ten-digit national number; use +1 for an international number',
    );
  }
  return { phoneNumber: number, countryCode: `+${callingCode}` };
}

function loginParameters(context, pending) {
  if (
    !object(context) ||
    !nonempty(context.firstPartyClientID) ||
    !object(pending) ||
    !nonempty(pending.verifier)
  ) {
    throw new Error(
      'A pending PKCE login and first-party client context are required',
    );
  }
  const url = new URL(pending.url);
  const callback = new URL(pending.callback);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'auth.uber.com' ||
    url.username ||
    url.password ||
    callback.protocol !== 'https:' ||
    callback.hostname !== 'auth.uber.com' ||
    callback.username ||
    callback.password
  ) {
    throw new Error(
      'Pending login must use Uber HTTPS authentication and callback URLs',
    );
  }
  const challenge = url.searchParams.get('codeChallenge');
  if (challenge !== pkceChallenge(pending.verifier))
    throw new Error('Pending login PKCE challenge does not match its verifier');
  if (
    url.searchParams.get('firstPartyClientID') !== context.firstPartyClientID ||
    url.searchParams.get('app_url') !== pending.callback
  ) {
    throw new Error(
      'Pending login does not match its client context or callback',
    );
  }
  return {
    standardFlow: true,
    productConstraints: {
      isEligibleForWebOTPAutofill: false,
      isWhatsAppAvailable: false,
      isPublicKeyCredentialSupported: false,
    },
    additionalParams: {},
    deviceData: '',
    codeChallenge: challenge,
    uslURL: url.href,
    authDomain: url.hostname,
    firstPartyClientID: context.firstPartyClientID,
  };
}

// First-party builder25208 and the verified native phone flow provide this
// initial context. Later code answers keep its PKCE binding, without appContext.
export function initialLoginRequest(context, pending, phone) {
  if (!object(phone)) throw new Error('A normalized phone number is required');
  const normalized = normalizePhone(phone.phoneNumber, phone.countryCode);
  return {
    formContainerAnswer: {
      inAuthSessionID: '',
      formAnswer: {
        ...loginParameters(context, pending),
        flowType: 'INITIAL',
        appContext: {
          appUrl: pending.callback,
          isChromeCustomTabSession: false,
        },
        screenAnswers: [
          {
            screenType: 'PHONE_NUMBER_INITIAL',
            eventType: 'TypeInputMobile',
            fieldAnswers: [
              {
                fieldType: 'PHONE_COUNTRY_CODE',
                phoneCountryCode: normalized.countryCode,
              },
              {
                fieldType: 'PHONE_NUMBER',
                phoneNumber: normalized.phoneNumber,
              },
            ],
          },
        ],
      },
    },
  };
}

function container(response) {
  if (!object(response)) return null;
  if (response.success === false) return null;
  if (Object.hasOwn(response, 'formContainer'))
    return object(response.formContainer) ? response.formContainer : null;
  return response;
}

function forms(response) {
  const body = container(response);
  if (!body) return [];
  return [
    body.form,
    ...(Array.isArray(body.alternateForms) ? body.alternateForms : []),
  ].filter(object);
}

function fromForm(form) {
  if (!nonempty(form.flowType) || !Array.isArray(form.screens)) return [];
  const challenges = [];
  for (const screen of form.screens) {
    if (!object(screen) || !Array.isArray(screen.fields)) continue;
    const type = codeTypes.find(
      (type) =>
        type.screenType === screen.screenType &&
        type.eventType === screen.eventType,
    );
    if (!type) continue;
    const fields = screen.fields.filter(
      (field) => object(field) && field.fieldType === type.fieldType,
    );
    if (fields.length !== 1) continue;
    const field = fields[0];
    if (
      field.otpWidth !== undefined &&
      (!Number.isInteger(field.otpWidth) || field.otpWidth < 0)
    )
      continue;
    challenges.push({
      ...type,
      flowType: form.flowType,
      otpWidth: field.otpWidth > 0 ? field.otpWidth : null,
      hint: typeof field.hintValue === 'string' ? field.hintValue : null,
    });
  }
  return challenges;
}

/** Select supported server-offered SMS/email forms; never manufacture a step. */
export function chooseCodeChallenge(response) {
  const body = container(response);
  if (!body) return null;
  const primary = object(body.form) ? fromForm(body.form) : [];
  if (primary.length) return primary[0];
  const alternates = Array.isArray(body.alternateForms)
    ? body.alternateForms.filter(object).flatMap(fromForm)
    : [];
  return (
    alternates.find((challenge) => challenge.channel === 'sms') ??
    alternates.find((challenge) => challenge.channel === 'email') ??
    null
  );
}

function validateChallenge(challenge) {
  if (!object(challenge) || !nonempty(challenge.flowType))
    throw new Error('A supported server-issued code challenge is required');
  const type = codeTypes.find(
    (type) =>
      type.channel === challenge.channel &&
      type.screenType === challenge.screenType &&
      type.eventType === challenge.eventType &&
      type.fieldType === challenge.fieldType &&
      type.answerKey === challenge.answerKey,
  );
  if (
    !type ||
    (challenge.otpWidth !== null &&
      (!Number.isInteger(challenge.otpWidth) || challenge.otpWidth < 1))
  ) {
    throw new Error('A supported server-issued code challenge is required');
  }
  return type;
}

function sessionID(value) {
  if (!nonempty(value))
    throw new Error('Server response has no in-auth session ID');
  return value;
}

export function prepareCodeRequest(response, challenge) {
  validateChallenge(challenge);
  const offered = forms(response).flatMap(fromForm);
  if (
    !offered.some(
      (item) =>
        item.flowType === challenge.flowType &&
        item.screenType === challenge.screenType &&
        item.eventType === challenge.eventType &&
        item.fieldType === challenge.fieldType,
    )
  ) {
    throw new Error('Code challenge is not offered by this server response');
  }
  return {
    request: {
      flowType: challenge.flowType,
      inAuthSessionID: sessionID(container(response)?.inAuthSessionID),
      eventType: challenge.eventType,
      fieldType: challenge.fieldType,
    },
  };
}

export function codeAnswerRequest(pending, inAuthSessionID, challenge, code) {
  const type = validateChallenge(challenge);
  if (
    typeof code !== 'string' ||
    !/^[0-9]+$/.test(code.trim()) ||
    (challenge.otpWidth !== null && code.trim().length !== challenge.otpWidth)
  ) {
    throw new Error(
      challenge.otpWidth
        ? `Verification code must contain ${challenge.otpWidth} digits`
        : 'Verification code must contain digits',
    );
  }
  return {
    formContainerAnswer: {
      inAuthSessionID: sessionID(inAuthSessionID),
      formAnswer: {
        ...loginParameters(pending?.context, pending),
        flowType: challenge.flowType,
        screenAnswers: [
          {
            screenType: type.screenType,
            eventType: type.eventType,
            fieldAnswers: [
              { fieldType: type.fieldType, [type.answerKey]: code.trim() },
            ],
          },
        ],
      },
    },
  };
}

/** Final native exchange requires the exact server authCode, not a field default. */
export function sessionVerification(response) {
  const body = container(response);
  const form = body?.form;
  if (!object(form) || !Array.isArray(form.screens)) return null;
  const codes = [];
  for (const screen of form.screens) {
    if (
      !object(screen) ||
      screen.screenType !== 'SESSION_VERIFICATION' ||
      screen.eventType !== 'TypeVerifySession' ||
      !Array.isArray(screen.fields)
    )
      continue;
    for (const field of screen.fields) {
      if (
        object(field) &&
        field.fieldType === 'SESSION_VERIFICATION_CODE' &&
        nonempty(field.authCode)
      )
        codes.push(field.authCode);
    }
  }
  if (codes.length !== 1) return null;
  return { session: sessionID(body.inAuthSessionID), authCode: codes[0] };
}
