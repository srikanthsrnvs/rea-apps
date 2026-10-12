import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, publicEncrypt } from 'node:crypto';
import { PairingClient, createPairingAuth, sessionFromPairing } from '../src/pairing.mjs';

const auth = {
  user_id: '12345678901234567', analytics_claim: 'fixture-claim',
  access_token: 'Bearer IGT:2:' + Buffer.from(JSON.stringify({
    ds_user_id: '12345678901234567', sessionid: 'fixture-private-session',
  })).toString('base64'),
};

function fixture({ secondNonce = null } = {}) {
  const data = { session: { oldSession: true } };
  const calls = [];
  let time = 100000;
  let approved = false;
  let validationFails = false;
  let exchangeFails = false;
  let publicKey;
  let locked = false;
  const store = {
    read: async key => structuredClone(data[key] ?? null),
    save: async (key, value) => { data[key] = structuredClone(value); },
    remove: async key => { delete data[key]; },
    lock: async callback => {
      assert.equal(locked, false);
      locked = true;
      try { return await callback(); } finally { locked = false; }
    },
  };
  function encrypt(value) {
    return publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(value)).toString('base64');
  }
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://i.instagram.com/graphql_www/');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers['x-ig-app-id'], '1281876400241826');
    const name = options.body.get('queryName');
    assert.equal(options.headers['x-fb-friendly-name'], name);
    const variables = JSON.parse(options.body.get('variables'));
    calls.push({ name, variables, id: options.body.get('doc_id') });
    let root, result;
    if (name === 'useAirwaveGenerateLoginCodeMutation') {
      assert.equal(options.body.get('doc_id'), '24426392696979234');
      assert.deepEqual(Object.keys(variables).sort(), ['device_id', 'public_key']);
      publicKey = variables.public_key;
      root = 'airwave_login_generate_code'; result = { code: 'ABCDEFGHIJ' };
    } else if (name === 'useAirwaveLoginListenValidationQuery') {
      assert.equal(options.body.get('doc_id'), '30706232158975150');
      assert.deepEqual(variables, { code: 'ABCDEFGHIJ' });
      root = 'airwave_login_listen_validation'; result = {
        encrypted_first_nonce_code: approved ? encrypt('first-nonce') : null,
        encrypted_second_nonce_code: approved && secondNonce ? encrypt(secondNonce) : null,
      };
    } else {
      assert.equal(name, 'useAirwaveLoginExchangeTokenQuery');
      assert.equal(options.body.get('doc_id'), '24248585958071086');
      assert.deepEqual(variables, { first_nonce_code: 'first-nonce', second_nonce_code: secondNonce, registration_code: 'ABCDEFGHIJ' });
      if (exchangeFails) throw Error('fixture private network failure');
      root = 'airwave_login_exchange_token'; result = auth;
    }
    return new Response(JSON.stringify({ data: { [root]: result } }));
  };
  const service = createPairingAuth({ store, now: () => time,
    clientFactory: id => new PairingClient(id, { fetchImpl }),
    validate: async session => {
      if (validationFails) throw Error('fixture validation unavailable');
      assert.equal(session.cookies.find(c => c.name === 'sessionid').value, 'fixture-private-session');
      return { ...session, validatedAt: new Date(time).toISOString(), account: { id: auth.user_id, username: 'fixture' } };
    },
    sleep: async milliseconds => { assert.equal(locked, false); time += milliseconds; approved = true; },
  });
  return { service, data, calls, store,
    approve: () => { approved = true; },
    advance: ms => { time += ms; },
    failValidation: value => { validationFails = value; },
    failExchange: () => { exchangeFails = true; },
  };
}

test('headless approval uses exact TV wire contract and one RSA nonce with nullable second', async () => {
  const f = fixture();
  const start = await f.service.start();
  const url = new URL(start.approvalUrl);
  assert.equal(url.origin, 'https://www.instagram.com');
  assert.equal(url.pathname, '/activate');
  assert.equal(url.searchParams.get('code'), 'ABC-DEF-GHIJ');
  assert.equal(url.searchParams.get('flow'), 'login');
  assert.equal(url.searchParams.get('source'), 'qr');
  assert.match(url.searchParams.get('login_session_id'), /^[0-9a-f-]{36}$/);
  assert.equal(start.browserRequiredOnHost, false);
  assert.equal(JSON.stringify(start).includes('PRIVATE KEY'), false);
  f.approve();
  const result = await f.service.poll();
  assert.equal(result.status, 'authenticated');
  assert.equal(result.account.id, auth.user_id);
  assert.equal(JSON.stringify(result).includes('fixture-private'), false);
  assert.equal(f.data.login, undefined);
  assert.equal(f.data.session.acquiredBy, 'tv-pairing');
  assert.equal((await f.service.poll()).status, 'authenticated');
  assert.equal(f.calls.length, 3);
});

test('second RSA nonce is decrypted when supplied', async () => {
  const f = fixture({ secondNonce: 'second-nonce' });
  await f.service.start(); f.approve();
  assert.equal((await f.service.poll()).status, 'authenticated');
});

test('pending requests reuse links, throttle polling and preserve an old session', async () => {
  const f = fixture();
  const first = await f.service.start();
  assert.deepEqual(await f.service.start(), first);
  await f.service.poll(); await f.service.poll();
  assert.equal(f.calls.length, 2);
  assert.equal(f.data.session.oldSession, true);
  assert.match(f.data.login.privateKey, /PRIVATE KEY/);
  await f.service.cancel();
  assert.equal(f.data.login, undefined);
  assert.equal(f.data.session.oldSession, true);
});

test('expired requests remove RSA keys; wait releases locks while sleeping', async () => {
  const f = fixture();
  await f.service.start({ timeoutSeconds: 30 });
  f.advance(30000);
  await assert.rejects(f.service.poll(), { code: 'LOGIN_EXPIRED' });
  assert.equal(f.data.login, undefined);
  assert.equal(f.data.session.oldSession, true);
  await f.service.start();
  assert.equal((await f.service.wait()).status, 'authenticated');
});

test('acquired credentials survive validation failure and resume without redeeming again', async () => {
  const f = fixture();
  await f.service.start(); f.approve(); f.failValidation(true);
  await assert.rejects(f.service.poll(), /validation unavailable/);
  assert.equal(f.data.session.oldSession, true);
  assert.equal(f.data.login.stage, 'acquired');
  assert.equal(f.data.login.privateKey, undefined);
  const calls = f.calls.length;
  f.advance(3600000); // An already exchanged credential is not a pending code.
  f.failValidation(false);
  assert.equal((await f.service.poll()).status, 'authenticated');
  assert.equal(f.calls.length, calls);
});

test('uncertain exchange never automatically replays a consumed nonce', async () => {
  const f = fixture();
  await f.service.start(); f.approve(); f.failExchange();
  await assert.rejects(f.service.poll(), { code: 'NETWORK_ERROR' });
  assert.equal(f.data.login.stage, 'exchanging');
  assert.equal(f.data.login.privateKey, undefined);
  await assert.rejects(f.service.poll(), { code: 'EXCHANGE_UNCERTAIN' });
  assert.equal(f.calls.length, 3);
  assert.equal(f.data.session.oldSession, true);
});

test('wrong private key or validated identity cannot replace the existing session', async () => {
  const f = fixture();
  await f.service.start(); f.approve();
  f.data.login.privateKey = 'invalid-key';
  await assert.rejects(f.service.poll(), { code: 'INVALID_RESPONSE' });
  assert.equal(f.data.session.oldSession, true);
  const bad = fixture();
  await bad.service.start();
  bad.data.login = { ...bad.data.login, stage: 'acquired', session: sessionFromPairing(auth) };
  const service = createPairingAuth({ store: bad.store, validate: async session => ({ ...session, account: { id: '9', username: 'wrong' } }) });
  await assert.rejects(service.poll(), { code: 'INVALID_RESPONSE' });
  assert.equal(bad.data.session.oldSession, true);
});

test('token parsing rejects malformed, mismatched and unsafe credentials', () => {
  assert.equal(sessionFromPairing(auth).cookies.length, 2);
  for (const bad of [
    { ...auth, user_id: '42' }, { ...auth, access_token: 'Bearer secret' },
    { ...auth, analytics_claim: 'bad\r\nheader' },
    { ...auth, access_token: 'Bearer IGT:2:' + Buffer.from(JSON.stringify({ ds_user_id: auth.user_id, sessionid: 'bad;cookie' })).toString('base64') },
  ]) assert.throws(() => sessionFromPairing(bad), { code: 'INVALID_RESPONSE' });
});

test('pairing errors omit server-provided private values and reject redirects', async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://other.invalid/private' } }),
    new Response(JSON.stringify({ errors: [{ message: 'private-server-value' }] }))]) {
    const client = new PairingClient('fixture', { fetchImpl: async () => response });
    await assert.rejects(client.query('listen', { code: 'ABCDEFGHIJ' }), error => {
      assert.equal(error.code, 'PAIRING_REJECTED');
      assert.equal(error.message.includes('private-server-value'), false);
      return true;
    });
  }
});
