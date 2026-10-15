import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePaymentProfiles,
  fetchPaymentProfiles,
  selectPaymentProfile,
  fetchUserProfiles,
} from '../src/payments.mjs';
test('payment summaries retain selection IDs but omit sensitive account and card fields', () => {
  const summary = normalizePaymentProfiles({
    paymentProfiles: [
      {
        uuid: 'id',
        displayable: { displayName: 'Visa ••••1234' },
        cardType: 'Visa',
        status: 'active',
        isExpired: false,
        cardNumber: 'secret',
        billingAddress: 'secret',
        token: 'secret',
      },
    ],
    inactivePaymentProfiles: [{}],
  });
  assert.deepEqual(summary, {
    profiles: [
      {
        id: 'id',
        name: 'Visa ••••1234',
        type: 'Visa',
        status: 'active',
        expired: false,
        useCase: null,
      },
    ],
    inactiveProfileCount: 1,
  });
  assert.ok(!JSON.stringify(summary).includes('secret'));
  assert.throws(() => normalizePaymentProfiles({}), /Unrecognized/);
});
test('payment defaults come from the actual Personal RIDER profile, with explicit overrides', () => {
  const profiles = {
    profiles: [
      {
        uuid: 'profile-id',
        type: 'Personal',
        status: 'active',
        defaultPaymentProfileByProduct: { RIDER: 'default' },
        defaultPaymentProfileUuid: 'other',
      },
    ],
  };
  const payments = {
    paymentProfiles: [
      { uuid: 'default', status: 'active', isExpired: false },
      { uuid: 'other', status: 'active', isExpired: false },
      { uuid: 'expired', status: 'active', isExpired: true },
    ],
  };
  assert.equal(selectPaymentProfile(payments, profiles).payment.id, 'default');
  assert.equal(
    selectPaymentProfile(payments, profiles, 'other').payment.id,
    'other',
  );
  assert.equal(
    selectPaymentProfile(payments, profiles).userProfile.id,
    'profile-id',
  );
  assert.throws(
    () => selectPaymentProfile(payments, profiles, 'expired'),
    /expired/,
  );
  assert.throws(
    () => selectPaymentProfile(payments, { profiles: [] }),
    /Personal/,
  );
});
test('profile lookup preserves native userUuid casing', async () => {
  await fetchUserProfiles(async (endpoint, body) => {
    assert.equal(endpoint, '/rt/profiles/v2/get-profiles');
    assert.deepEqual(body, { request: { userUuid: 'rider' } });
  }, 'rider');
});
test('payment listing never uses the create-profile POST route', async () => {
  await fetchPaymentProfiles(async (endpoint, body, options) => {
    assert.equal(endpoint, '/rt/payment/v3/payment-profiles');
    assert.equal(body, undefined);
    assert.deepEqual(options, { method: 'GET' });
  });
});
