import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eatsCancellationOptionsRequest,
  normalizeEatsCancellationOptions,
  eatsFulfillCancellationRequest,
  normalizeEatsCancellationResult,
} from '../src/eats/cancellation-protocol.mjs';

const id = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const orderId = id(1);
const action = () => ({
  uuid: id(2),
  actionType: 'AUTH_CANCEL',
  token: 'synthetic-authorized-token',
  text: {
    title: 'Cancel this order?',
    confirmation: 'Cancel order',
    details: { details: 'The restaurant has started preparing your food.' },
    finalCharges: [
      { key: 'final', label: 'You will be charged', value: '$12.00' },
    ],
  },
  value: { value: 1200, feeValue: 100, currencyCode: 'USD' },
  extension: { opaque: ['retain', 123] },
});
const feedback = () => ({
  uuid: id(3),
  actionType: 'CANCEL_FEEDBACK',
  token: 'synthetic-feedback-token',
});
const options = () => ({ actions: [action(), feedback()] });
const richText = (text) => ({
  richTextElements: [{ text: { text: { text } }, type: 'TEXT' }],
});

test('cancel preview binds order through native issue without confusing action identity', () => {
  assert.deepEqual(eatsCancellationOptionsRequest(orderId), {
    request: { issues: [{ issueType: 'CANCEL', order: { uuid: orderId } }] },
  });
  const result = normalizeEatsCancellationOptions(options(), orderId);
  assert.equal(result.orderId, orderId);
  assert.equal(result.actionId, id(2));
  assert.notEqual(result.actionId, result.orderId);
  assert.throws(() => eatsCancellationOptionsRequest('../another-order'), {
    code: 'EATS_INVALID_ARGUMENT',
  });
});

test('preview requires unambiguous native cancellation and feedback authorizations', () => {
  for (const actions of [
    [],
    [action()],
    [feedback()],
    [action(), action(), feedback()],
  ])
    assert.throws(
      () => normalizeEatsCancellationOptions({ actions }, orderId),
      {
        code: 'EATS_CANCELLATION_UNAVAILABLE',
      },
    );
  assert.throws(() =>
    normalizeEatsCancellationOptions({ actions: null }, orderId),
  );
  const same = options();
  same.actions[1].uuid = id(2);
  assert.throws(
    () => normalizeEatsCancellationOptions(same, orderId),
    /conflicting/,
  );
  const missingToken = options();
  delete missingToken.actions[0].token;
  assert.throws(
    () => normalizeEatsCancellationOptions(missingToken, orderId),
    /authorized/,
  );
});

test('preview retains complete charges and opaque authorization without declaring a fee or refund', () => {
  const payload = options();
  const result = normalizeEatsCancellationOptions({ body: payload }, orderId);
  assert.deepEqual(result.action, payload.actions[0]);
  assert.deepEqual(
    result.terms.finalCharges,
    payload.actions[0].text.finalCharges,
  );
  assert.deepEqual(result.terms.value, payload.actions[0].value);
  assert.equal(result.fee, undefined);
  assert.equal(result.free, undefined);
  payload.actions[0].text.finalCharges[0].value = '$999.00';
  assert.equal(result.terms.finalCharges[0].value, '$12.00');
  const noChargeList = options();
  delete noChargeList.actions[0].text.finalCharges;
  const noChargeResult = normalizeEatsCancellationOptions(
    noChargeList,
    orderId,
  );
  assert.equal(noChargeResult.terms.finalCharges, null);
  assert.equal(noChargeResult.free, undefined);
});

test('overriding confirmation modal is retained and must contain readable terms and confirmation button', () => {
  const payload = options();
  payload.actions[0].overridingResolutionModal = {
    header: richText('Cancellation charges apply'),
    description: richText('You will be charged $12.00.'),
    primaryButton: {
      content: { textContent: { text: richText('Cancel order') } },
    },
    secondaryButton: {
      content: { textContent: { text: richText('Keep order') } },
    },
  };
  delete payload.actions[0].text;
  const result = normalizeEatsCancellationOptions(payload, orderId);
  assert.deepEqual(
    result.terms.overridingResolutionModal,
    payload.actions[0].overridingResolutionModal,
  );
  assert.equal(result.terms.text, null);
  payload.actions[0].overridingResolutionModal = {
    primaryButton: { action: 'CANCEL' },
  };
  assert.throws(
    () => normalizeEatsCancellationOptions(payload, orderId),
    /readable/,
  );
});

test('ordinary cancellation terms must include title and confirmation and reject malformed charges', () => {
  for (const field of ['title', 'confirmation']) {
    const payload = options();
    payload.actions[0].text[field] = ' ';
    assert.throws(
      () => normalizeEatsCancellationOptions(payload, orderId),
      /complete cancellation terms/,
    );
  }
  const payload = options();
  payload.actions[0].text.finalCharges = 'free';
  assert.throws(
    () => normalizeEatsCancellationOptions(payload, orderId),
    /malformed/,
  );
  payload.actions[0].text.finalCharges = [{ value: 1200 }];
  assert.throws(
    () => normalizeEatsCancellationOptions(payload, orderId),
    /malformed/,
  );
});

test('fulfillment sends the complete server action and clones it instead of rebuilding token-only or feedback actions', () => {
  const source = action();
  const result = eatsFulfillCancellationRequest(source);
  assert.deepEqual(result, { request: { actions: [source] } });
  source.extension.opaque[0] = 'changed';
  assert.equal(result.request.actions[0].extension.opaque[0], 'retain');
  assert.throws(() => eatsFulfillCancellationRequest(feedback()), /authorized/);
});

test('non-JSON, cyclic and excessive opaque payloads fail before a plan or request is created', () => {
  const source = action();
  source.self = source;
  assert.throws(() => eatsFulfillCancellationRequest(source), /non-JSON/);
  delete source.self;
  source.extension.date = new Date();
  assert.throws(() => eatsFulfillCancellationRequest(source), /non-JSON/);
  source.extension = {};
  let tail = source.extension;
  for (let i = 0; i < 40; i++) tail = tail.next = {};
  assert.throws(() => eatsFulfillCancellationRequest(source), /oversized/);
});

test('successful fulfillment acknowledges only exact action and still requires order state verification', () => {
  const expected = action();
  const result = normalizeEatsCancellationResult(
    {
      completedActions: [{ action: expected }],
      failedActions: [],
    },
    expected,
  );
  assert.deepEqual(result, {
    actionId: id(2),
    fulfilled: true,
    requiresOrderVerification: true,
  });
  assert.equal(result.cancelled, undefined);
  assert.equal(result.orderId, undefined);
});

test('empty completions, another action, replaced tokens, error-bearing completed actions and any failed action never report success', () => {
  const expected = action();
  const uncertain = [
    {},
    { completedActions: [] },
    { completedActions: [{ action: { ...expected, uuid: id(99) } }] },
    { completedActions: [{ action: { ...expected, token: 'different' } }] },
    { completedActions: [{ action: { ...expected, actionType: 'REFUND' } }] },
    { completedActions: [{ action: expected, errorCode: 'NOT_ACTIVE' }] },
    { completedActions: [{ action: expected }, { action: expected }] },
  ];
  for (const response of uncertain)
    assert.throws(() => normalizeEatsCancellationResult(response, expected), {
      code: 'EATS_CANCELLATION_UNCERTAIN',
    });
  assert.throws(
    () =>
      normalizeEatsCancellationResult(
        {
          completedActions: [{ action: expected }],
          failedActions: [
            { action: expected, error: 'Restaurant refused cancellation' },
          ],
        },
        expected,
      ),
    { code: 'EATS_CANCELLATION_FAILED' },
  );
  assert.throws(
    () =>
      normalizeEatsCancellationResult(
        {
          completedActions: [{ action: expected }],
          failedActions: {},
        },
        expected,
      ),
    { code: 'EATS_RESPONSE_INVALID' },
  );
});
