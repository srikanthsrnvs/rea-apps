import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, createLogin, pkceChallenge } from '../src/protocol.mjs';
import {
  normalizePhone,
  initialLoginRequest,
  chooseCodeChallenge,
  prepareCodeRequest,
  codeAnswerRequest,
  sessionVerification,
} from '../src/auth-protocol.mjs';

const context = createContext();
const pending = createLogin(context, 'https://auth.uber.com/v2/applogin/helix');
const sms = {
  flowType: 'INITIAL',
  screens: [
    {
      screenType: 'PHONE_OTP',
      eventType: 'TypeSMSOTP',
      fields: [
        { fieldType: 'PHONE_SMS_OTP', otpWidth: 4, hintValue: '•••0100' },
      ],
    },
  ],
};
const email = {
  flowType: 'SIGN_IN',
  screens: [
    {
      screenType: 'EMAIL_OTP_CODE',
      eventType: 'TypeEmailOTP',
      fields: [
        {
          fieldType: 'EMAIL_OTP_CODE',
          otpWidth: 6,
          hintValue: 't•••@example.test',
        },
      ],
    },
  ],
};
const response = {
  inAuthSessionID: 'synthetic-session',
  form: {
    flowType: 'INITIAL',
    screens: [
      {
        screenType: 'SOCIAL',
        eventType: 'TypeFacebookAuthCode',
        fields: [{ fieldType: 'FACEBOOK_AUTH_CODE' }],
      },
    ],
  },
  alternateForms: [sms, email],
};

test('phone normalization keeps calling code separate and refuses conflicting or ambiguous input', () => {
  assert.deepEqual(normalizePhone('(415) 555-0100'), {
    phoneNumber: '4155550100',
    countryCode: '+1',
  });
  assert.deepEqual(normalizePhone('+1 415 555 0100'), {
    phoneNumber: '4155550100',
    countryCode: '+1',
  });
  assert.deepEqual(normalizePhone('+44 20 7946 0958', '44'), {
    phoneNumber: '2079460958',
    countryCode: '+44',
  });
  for (const [phone, country] of [
    ['14155550100', '1'],
    ['+44 20 7946 0958', '1'],
    ['', '1'],
    ['4155550100 ext123', '1'],
    ['123', '1'],
    ['0000000000', '1'],
    ['123456789012345', '44'],
    ['4155550100', '0'],
  ]) {
    assert.throws(() => normalizePhone(phone, country));
  }
});

test('initial phone body binds native callback, first-party client, and the pending PKCE challenge', () => {
  const request = initialLoginRequest(
    context,
    pending,
    normalizePhone('4155550100'),
  );
  const answer = request.formContainerAnswer.formAnswer;
  assert.equal(request.formContainerAnswer.inAuthSessionID, '');
  assert.equal(answer.codeChallenge, pkceChallenge(pending.verifier));
  assert.equal(answer.authDomain, 'auth.uber.com');
  assert.equal(answer.deviceData, '');
  assert.deepEqual(answer.appContext, {
    appUrl: pending.callback,
    isChromeCustomTabSession: false,
  });
  assert.deepEqual(answer.screenAnswers, [
    {
      screenType: 'PHONE_NUMBER_INITIAL',
      eventType: 'TypeInputMobile',
      fieldAnswers: [
        { fieldType: 'PHONE_COUNTRY_CODE', phoneCountryCode: '+1' },
        { fieldType: 'PHONE_NUMBER', phoneNumber: '4155550100' },
      ],
    },
  ]);
  assert.throws(
    () =>
      initialLoginRequest(
        context,
        { ...pending, verifier: 'other' },
        normalizePhone('4155550100'),
      ),
    /PKCE/,
  );
  assert.throws(
    () =>
      initialLoginRequest(
        { ...context, firstPartyClientID: 'other' },
        pending,
        normalizePhone('4155550100'),
      ),
    /client context/,
  );
});

test('challenge selection only accepts matching server screen, event, and field tuples', () => {
  const challenge = chooseCodeChallenge(response);
  assert.deepEqual(challenge, {
    channel: 'sms',
    screenType: 'PHONE_OTP',
    eventType: 'TypeSMSOTP',
    fieldType: 'PHONE_SMS_OTP',
    answerKey: 'phoneSMSOTP',
    flowType: 'INITIAL',
    otpWidth: 4,
    hint: '•••0100',
  });
  assert.equal(
    chooseCodeChallenge({ ...response, form: email }).channel,
    'email',
  );
  assert.equal(
    chooseCodeChallenge({ ...response, alternateForms: [email] }).channel,
    'email',
  );
  assert.equal(
    chooseCodeChallenge({ alternateForms: [email, sms] }).channel,
    'sms',
  );
  const malformed = structuredClone(sms);
  malformed.screens[0].eventType = 'TypeVoiceOTP';
  assert.equal(
    chooseCodeChallenge({ form: malformed, inAuthSessionID: 's' }),
    null,
  );
  malformed.screens[0].eventType = 'TypeSMSOTP';
  malformed.screens[0].fields.push({ ...malformed.screens[0].fields[0] });
  assert.equal(
    chooseCodeChallenge({ form: malformed, inAuthSessionID: 's' }),
    null,
  );
  assert.equal(chooseCodeChallenge({ formContainer: null, form: sms }), null);
});

test('prepare DTO uses the offered session, field, flow and event with no code or login context', () => {
  const challenge = chooseCodeChallenge(response);
  assert.deepEqual(prepareCodeRequest(response, challenge), {
    request: {
      flowType: 'INITIAL',
      inAuthSessionID: 'synthetic-session',
      eventType: 'TypeSMSOTP',
      fieldType: 'PHONE_SMS_OTP',
    },
  });
  assert.throws(
    () => prepareCodeRequest({ ...response, inAuthSessionID: '' }, challenge),
    /session ID/,
  );
  assert.throws(
    () =>
      prepareCodeRequest({ ...response, alternateForms: [email] }, challenge),
    /not offered/,
  );
});

test('prepared forms can replace the session and provide the final server code width', () => {
  const prepared = {
    success: true,
    formContainer: {
      inAuthSessionID: 'prepared-session',
      form: email,
      alternateForms: [],
    },
  };
  const challenge = chooseCodeChallenge(prepared);
  assert.equal(challenge.channel, 'email');
  assert.equal(challenge.otpWidth, 6);
  assert.equal(
    prepareCodeRequest(prepared, challenge).request.inAuthSessionID,
    'prepared-session',
  );
  assert.equal(chooseCodeChallenge({ ...prepared, success: false }), null);
  assert.throws(
    () => prepareCodeRequest({ ...prepared, success: false }, challenge),
    /not offered/,
  );
  const unknown = structuredClone(email);
  unknown.screens[0].fields[0].otpWidth = 0;
  assert.equal(chooseCodeChallenge({ form: unknown }).otpWidth, null);
});

test('code submission preserves PKCE and leading zeros and omits initial appContext', () => {
  for (const [form, code, key] of [
    [sms, '0012', 'phoneSMSOTP'],
    [email, '000123', 'emailOTPCode'],
  ]) {
    const challenge = chooseCodeChallenge({
      form,
      inAuthSessionID: 'next-session',
    });
    const request = codeAnswerRequest(
      pending,
      'next-session',
      challenge,
      ` ${code} `,
    );
    const answer = request.formContainerAnswer.formAnswer;
    assert.equal(answer.codeChallenge, pkceChallenge(pending.verifier));
    assert.equal(answer.firstPartyClientID, context.firstPartyClientID);
    assert.equal(Object.hasOwn(answer, 'appContext'), false);
    assert.equal(answer.screenAnswers[0].fieldAnswers[0][key], code);
    assert.throws(
      () => codeAnswerRequest(pending, 's', challenge, '12x4'),
      /digits/,
    );
    assert.throws(
      () => codeAnswerRequest(pending, 's', challenge, '12'),
      /digits/,
    );
  }
});

test('session verification reads exact authCode only from the active native verification screen', () => {
  const final = {
    inAuthSessionID: 'exchange-session',
    form: {
      flowType: 'SIGN_IN',
      screens: [
        {
          screenType: 'SESSION_VERIFICATION',
          eventType: 'TypeVerifySession',
          fields: [
            {
              fieldType: 'SESSION_VERIFICATION_CODE',
              authCode: 'synthetic-auth-code',
            },
            { fieldType: 'CODE_VERIFIER' },
          ],
        },
      ],
    },
  };
  assert.deepEqual(sessionVerification(final), {
    session: 'exchange-session',
    authCode: 'synthetic-auth-code',
  });
  assert.deepEqual(
    sessionVerification({ success: true, formContainer: final }),
    { session: 'exchange-session', authCode: 'synthetic-auth-code' },
  );
  const altered = structuredClone(final);
  altered.form.screens[0].fields[0] = {
    fieldType: 'SESSION_VERIFICATION_CODE',
    defaultValue: 'must-not-be-used',
  };
  assert.equal(sessionVerification(altered), null);
  assert.equal(
    sessionVerification({
      ...final,
      form: response.form,
      alternateForms: [final.form],
    }),
    null,
  );
  altered.form = {
    ...final.form,
    screens: [{ ...final.form.screens[0], eventType: 'TypeVerifyWebSession' }],
  };
  assert.equal(sessionVerification(altered), null);
  altered.form = structuredClone(final.form);
  altered.form.screens[0].fields.push({ ...altered.form.screens[0].fields[0] });
  assert.equal(sessionVerification(altered), null);
  assert.throws(
    () => sessionVerification({ ...final, inAuthSessionID: '' }),
    /session ID/,
  );
});
