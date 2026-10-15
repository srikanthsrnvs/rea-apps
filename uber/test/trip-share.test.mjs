import test from 'node:test';
import assert from 'node:assert/strict';
import { getTripShareLink, fetchSharedTrip } from '../src/trip-share.mjs';
const tripId = '11111111-1111-4111-8111-111111111111';
test('native link retrieval is an authenticated GET and never sends messages or contacts', async () => {
  let call;
  const result = await getTripShareLink(tripId, { send: async (...args) => { call = args; return { shareUrl: 'https://trip.uber.com/fixture', shareMessage: 'PRIVATE MESSAGE', token: 'PRIVATE TOKEN' }; } });
  assert.deepEqual(call, [`/rt/trips/${tripId}/share-yo-ride?shareTripType=RIDER_SHARE`, {}, { method: 'GET', readOnly: true }]);
  assert.equal(result.shareUrl, 'https://trip.uber.com/fixture');
  assert.equal(result.iframeSupportVerified, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('invalid IDs and unexpected sharing hosts fail before exposing a link', async () => {
  await assert.rejects(getTripShareLink('bad', { send: () => { throw Error('must not call'); } }));
  for (const shareUrl of ['http://trip.uber.com/x', 'https://uber.com.evil.example/x', 'https://user:password@trip.uber.com/x', 'https://trip.uber.com:444/x', null]) {
    await assert.rejects(getTripShareLink(tripId, { send: async () => ({ shareUrl }) }));
  }
});


test('native sharing follows only first-party redirects without bearer credentials, then fetches the exact DTO', async () => {
  const calls = [];
  const body = { uuid: tripId, status: 'ClientCanceled', tokenState: 'ACTIVE' };
  const result = await fetchSharedTrip(tripId, {
    readOwner: async () => null,
    send: async (...args) => { calls.push(args); return calls.length === 1 ? { shareUrl: 'https://trip.uber.com/fixture' } : body; },
    fetcher: async (url, options) => {
      assert.equal(url.origin, 'https://trip.uber.com'); assert.equal(options.redirect, 'manual'); assert.equal(options.headers, undefined);
      return new Response(null, { status: 302, headers: { location: 'https://m.uber.com/go/share?share_token=fixture-token' } });
    },
  });
  assert.equal(result, body);
  assert.deepEqual(calls[1], ['/rt/sharetrip/fetch', { request: { shareToken: 'fixture-token', usePolylines: false } }, { readOnly: true }]);
  await assert.rejects(fetchSharedTrip(tripId, { readOwner: async () => null,
    send: async () => ({ shareUrl: 'https://trip.uber.com/fixture' }),
    fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/leak' } }),
  }), /Unexpected Uber sharing redirect/);
});

test('short-lived tracking token cache stays scoped to its rider and selected trip', async () => {
  let owner = 'fixture-a', linkCalls = 0;
  const send = async endpoint => {
    if (endpoint.includes('share-yo-ride')) { linkCalls++; return { shareUrl: 'https://m.uber.com/go/share?share_token=fixture-token' }; }
    return { uuid: tripId };
  };
  const options = { send, readOwner: async () => owner, fetcher: () => { throw Error('must not resolve a link already containing its token'); } };
  await fetchSharedTrip(tripId, options); await fetchSharedTrip(tripId, options);
  assert.equal(linkCalls, 1);
  owner = 'fixture-b'; await fetchSharedTrip(tripId, options); assert.equal(linkCalls, 2);
});
