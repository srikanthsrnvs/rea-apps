import test from 'node:test';
import assert from 'node:assert/strict';
import { createEatsService } from '../src/eats/service.mjs';

const id = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const ids = {
  owner: id(1),
  order: id(2),
  action: id(3),
  feedback: id(4),
  other: id(5),
};
const optionsPath = '/rt/eats/v1/orders/{uuid}/resolution/options';
const actionsPath = '/rt/eats/v1/orders/{uuid}/resolution/actions';

function harness() {
  const h = {
    session: { userUUID: ids.owner },
    now: Date.now(),
    state: new Map(),
    calls: [],
    active: [
      {
        uuid: ids.order,
        orderUUID: ids.order,
        orderInfo: { orderPhase: 'PREPARING' },
      },
    ],
    action: {
      actionType: 'AUTH_CANCEL',
      uuid: ids.action,
      token: 'old-opaque-token',
      text: {
        title: 'Cancel order?',
        confirmation: 'You will be charged $1.00.',
        finalCharges: [
          {
            key: 'cancellation_fee',
            label: 'Cancellation fee',
            type: 'credit',
            value: '$1.00',
          },
        ],
      },
      value: 'opaque-server-value',
      futureOpaqueField: { authorization: ['must', 'remain'] },
    },
    history: [],
  };
  h.send = async (endpoint, body, options = {}) => {
    h.calls.push({
      endpoint,
      body: structuredClone(body),
      options: structuredClone(options),
    });
    if (endpoint.endsWith('/active-orders'))
      return { activeEaterOrdersMobileView: structuredClone(h.active) };
    if (endpoint === optionsPath)
      return {
        actions: [
          structuredClone(h.action),
          {
            actionType: 'CANCEL_FEEDBACK',
            uuid: ids.feedback,
            token: 'feedback-token',
          },
        ],
      };
    if (endpoint === actionsPath) {
      if (h.fulfillFailure) throw h.fulfillFailure;
      return (
        h.fulfillResponse ?? {
          completedActions: [{ action: structuredClone(h.action) }],
          failedActions: [],
        }
      );
    }
    if (endpoint.includes(`/rt/eats/v1/eaters/${h.session.userUUID}/orders?`)) {
      if (h.historyFailure) throw h.historyFailure;
      return { orders: structuredClone(h.history) };
    }
    throw new Error(`Unexpected cancellation test endpoint ${endpoint}`);
  };
  h.execute = createEatsService({
    operation: (callback) => callback({ session: h.session, send: h.send }),
    read: async (key) => structuredClone(h.state.get(key)),
    write: async (key, value) => {
      h.state.set(key, structuredClone(value));
      if (h.onWrite) await h.onWrite(key, value);
    },
    now: () => h.now,
  });
  h.prepare = (extra = {}) =>
    h.execute('order', {
      action: 'cancel',
      'order-id': ids.order,
      near: '34,-118',
      ...extra,
    });
  h.confirm = (plan) =>
    h.execute('order', {
      action: 'cancel',
      'plan-id': plan.planId,
      confirm: true,
    });
  h.mutations = () =>
    h.calls.filter(({ endpoint }) => endpoint === actionsPath);
  return h;
}

test('cancellation preparation binds an active order and exact server terms without mutating it', async () => {
  const h = harness();
  const plan = await h.prepare();
  assert.equal(plan.status, 'confirmation_required');
  assert.equal(plan.orderId, ids.order);
  assert.deepEqual(plan.terms.text, h.action.text);
  assert.deepEqual(plan.terms.finalCharges, h.action.text.finalCharges);
  assert.equal(h.mutations().length, 0);
  const request = h.calls.find(({ endpoint }) => endpoint === optionsPath);
  assert.deepEqual(request.body, {
    request: { issues: [{ issueType: 'CANCEL', order: { uuid: ids.order } }] },
  });
  assert.equal(
    request.options.extraHeaders['x-uber-target-location-latitude'],
    '34',
  );
  assert.equal(
    [...h.state.keys()].filter((key) => key.startsWith('plan-')).length,
    1,
  );
});

test('preparation requires explicit location or saved context owned by the account', async () => {
  const h = harness();
  await assert.rejects(h.prepare({ near: undefined }), /Provide --near/);
  assert.equal(
    h.calls.filter(({ endpoint }) => endpoint === optionsPath).length,
    0,
  );
  h.state.set(`eats-order-${ids.order}`, {
    userUUID: ids.other,
    location: { latitude: 34, longitude: -118 },
  });
  await assert.rejects(h.prepare({ near: undefined }), /Provide --near/);
  h.state.set(`eats-order-${ids.order}`, {
    userUUID: ids.owner,
    location: { latitude: 35, longitude: -117 },
  });
  const plan = await h.prepare({ near: undefined });
  assert.equal(plan.status, 'confirmation_required');
  const request = h.calls.find(({ endpoint }) => endpoint === optionsPath);
  assert.equal(
    request.options.extraHeaders['x-uber-target-location-latitude'],
    '35',
  );
  assert.equal(h.mutations().length, 0);
});

test('fresh cancellation charges are rechecked and a changed fee blocks submission', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.action.text.finalCharges[0].value = '$10.00';
  await assert.rejects(h.confirm(plan), { code: 'EATS_PLAN_CHANGED' });
  assert.equal(h.mutations().length, 0);
});

test('confirmation submits the complete freshly authorized action once, including opaque fields', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.action.uuid = id(30);
  h.action.token = 'fresh-opaque-token';
  h.action.futureOpaqueField.authorization.push('fresh');
  h.history = [
    {
      uuid: ids.order,
      completionStatus: {
        completionState: 'EATER_CANCELLED',
        completionTime: 1700000000000,
      },
    },
  ];
  const result = await h.confirm(plan);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.completionStatus.completionState, 'EATER_CANCELLED');
  assert.deepEqual(h.mutations()[0].body, { request: { actions: [h.action] } });
  assert.equal(h.mutations()[0].options.callUuid, plan.operationId);
  assert.equal(h.mutations()[0].options.readOnly, false);
  assert.equal(h.state.get(`operation-${plan.operationId}`).state, 'accepted');
  const repeated = await h.confirm(plan);
  assert.equal(repeated.recovered, true);
  assert.equal(h.mutations().length, 1);
});

test('acknowledgement alone does not assert a cancelled order', async (t) => {
  for (const state of [
    undefined,
    'SUCCESS',
    'CANCELLED',
    'RESTAURANT_CANCELLED',
  ])
    await t.test(String(state), async () => {
      const h = harness();
      const plan = await h.prepare();
      if (state)
        h.history = [
          { uuid: ids.order, completionStatus: { completionState: state } },
        ];
      const result = await h.confirm(plan);
      assert.equal(result.status, 'cancellation_submitted');
      assert.match(result.next, /verify.*terminal state/);
      assert.equal(h.mutations().length, 1);
    });
});

test('an unrelated cancelled history order does not confirm this order cancellation', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.history = [
    {
      uuid: ids.other,
      completionStatus: { completionState: 'EATER_CANCELLED' },
    },
  ];
  assert.equal((await h.confirm(plan)).status, 'cancellation_submitted');
});

test('foreign, expired and unconfirmed cancellation plans cannot send a mutation', async (t) => {
  await t.test('foreign account', async () => {
    const h = harness();
    const plan = await h.prepare();
    const count = h.calls.length;
    h.session.userUUID = ids.other;
    await assert.rejects(h.confirm(plan), /another signed-in rider/);
    assert.equal(h.calls.length, count);
  });
  await t.test('expired approval', async () => {
    const h = harness();
    const plan = await h.prepare();
    const count = h.calls.length;
    h.now = Date.parse(plan.expiresAt) + 1;
    await assert.rejects(h.confirm(plan), /expired/);
    assert.equal(h.calls.length, count);
  });
  await t.test('approval missing', async () => {
    const h = harness();
    const plan = await h.prepare();
    await assert.rejects(
      h.execute('order', { action: 'cancel', 'plan-id': plan.planId }),
      /Explicit --confirm/,
    );
    assert.equal(h.mutations().length, 0);
  });
});

test('expiry during durable preparation blocks the actual fulfillment request', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.onWrite = (key, record) => {
    if (
      key === `operation-${plan.operationId}` &&
      record.state === 'submitting'
    )
      h.now = Date.parse(plan.expiresAt) + 1;
  };
  await assert.rejects(h.confirm(plan), /expired|repeat|outcome/i);
  assert.equal(h.mutations().length, 0);
});

test('unknown fulfillment never sends another action or reports cancellation success', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.fulfillFailure = Object.assign(
    new Error('Connection closed after submitting'),
    { code: 'ECONNRESET' },
  );
  await assert.rejects(h.confirm(plan), { code: 'outcome_unknown' });
  await assert.rejects(h.confirm(plan), { code: 'outcome_unknown' });
  assert.equal(h.mutations().length, 1);
  assert.equal(h.state.get(`operation-${plan.operationId}`).state, 'unknown');
});

test('completion must match the fresh authorization token and action identity exactly', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.fulfillResponse = {
    completedActions: [{ action: { ...h.action, token: 'wrong-token' } }],
  };
  await assert.rejects(h.confirm(plan), { code: 'outcome_unknown' });
  await assert.rejects(h.confirm(plan), { code: 'outcome_unknown' });
  assert.equal(h.mutations().length, 1);
});

test('a failed history read after accepted fulfillment remains recoverable without another cancellation', async () => {
  const h = harness();
  const plan = await h.prepare();
  h.historyFailure = new Error('History is temporarily unavailable');
  await assert.rejects(h.confirm(plan), /History is temporarily unavailable/);
  const recovered = await h.confirm(plan);
  assert.equal(recovered.status, 'cancellation_submitted');
  assert.equal(recovered.recovered, true);
  assert.equal(h.mutations().length, 1);
});
