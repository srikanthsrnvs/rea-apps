import test from 'node:test';
import assert from 'node:assert/strict';
import { InstagramClient, parseInstagramJson } from '../src/http.mjs';
import { sessionFromExport } from '../src/session.mjs';

const session = () => sessionFromExport({ cookies: [{
  name: 'sessionid', value: 'fixture-private', domain: '.instagram.com', path: '/', expires: -1,
}, { name: 'ds_user_id', value: '123', domain: '.instagram.com', path: '/', expires: -1 }] });

test('reads use the exact HTTPS origin and never follow a credential-bearing redirect', async () => {
  let calls = 0;
  const client = new InstagramClient(session(), { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://www.instagram.com');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.method, 'GET');
    return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
  } });
  await assert.rejects(client.get('/accounts/current_user/'), { code: 'LOGIN_REQUIRED' });
  assert.equal(calls, 1);
  await assert.rejects(client.get('//evil.example/'), { code: 'INVALID_ENDPOINT' });
  assert.equal(calls, 1);
});

test('security challenges and rate limits are reported without leaking payloads or retrying', async () => {
  for (const [status, body, code] of [
    [400, { message: 'challenge_required', challenge: { token: 'private-value' } }, 'APPROVAL_REQUIRED'],
    [401, { require_login: true, secret: 'private-value' }, 'LOGIN_REQUIRED'],
    [429, { status: 'fail' }, 'RATE_LIMITED'],
  ]) {
    let calls = 0;
    const client = new InstagramClient(session(), { fetchImpl: async () => {
      calls++;
      return Response.json(body, { status, headers: { 'retry-after': '60' } });
    } });
    await assert.rejects(client.get('/discover/web/explore_grid/'), error => {
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(error).includes('private-value'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('account identity and cookie changes are persisted after server validation', async () => {
  let saved;
  const client = new InstagramClient(session(), {
    saveSession: async value => { saved = value; },
    fetchImpl: async url => {
      assert.equal(String(url), 'https://www.instagram.com');
      return new Response('<script type="application/json">' + JSON.stringify({ modules: [['PolarisViewer', [], { data: { id: '123', username: 'fixture' } }]] }) + '</script>');
    },
  });
  await client.me();
  assert.deepEqual(saved.account, { id: '123', username: 'fixture' });
  assert.ok(saved.validatedAt);
});

test('JSON decoding preserves media identifiers beyond Number precision', () => {
  const body = parseInstagramJson('{"items":[{"pk":3891234567890123456}],"count":0}');
  assert.equal(body.items[0].pk, '3891234567890123456');
  assert.equal(body.count, 0);
});
