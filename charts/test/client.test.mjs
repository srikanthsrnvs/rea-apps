import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createSessionStore } from '../src/session.mjs';
import { createAuth } from '../src/auth.mjs';
import { createAttempt, approvalResult } from '../src/auth-protocol.mjs';
import { createLoginClient, parseClientLink, validateClientConfig, validateApproval, remoteCommand } from '../src/client.mjs';
import { readCallbackStdin, dispatch } from '../src/cli.mjs';
import { createCharts } from '../src/service.mjs';

const now = Date.now();
const config = { version: 1, profile: 'orin', sshTarget: 'truffle@orin.local', remoteCli: '/home/truffle/.local/bin/charts' };
const callback = 'tradingview://browser-auth/?token=private-synthetic-grant';
const pending = createAttempt({ now });
const offer = { ...approvalResult(pending), status: 'awaiting_callback' };
async function fixture(t, remote = async () => offer) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'charts-client-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createSessionStore(directory), client = createLoginClient({ store, remote, now: () => now });
  await client.configure(config);
  return { store, client, directory };
}

test('client links select only a configured profile and one bound login', () => {
  assert.deepEqual(parseClientLink(offer.clientUrl), { profile: 'orin', loginId: pending.id });
  for (const value of [offer.clientUrl+'&host=evil.test', offer.clientUrl+'&login_id='+pending.id,
    offer.clientUrl+'#anything', offer.clientUrl.replace('rea-charts:', 'https:'),
    offer.clientUrl.replace('authorize/', 'bad/'), 'rea-charts://authorize/?profile=orin&login_id=wrong']) {
    assert.throws(() => parseClientLink(value));
  }
  assert.equal(validateApproval(offer.approvalUrl), offer.approvalUrl);
  for (const value of [offer.approvalUrl.replace('auth.tradingview.com', 'evil.test'), offer.approvalUrl+'&extra=yes',
    offer.approvalUrl.replace('https:', 'http:'), offer.approvalUrl+'#secret']) assert.throws(() => validateApproval(value));
});

test('SSH destinations and executables reject option and shell injection', () => {
  assert.deepEqual(validateClientConfig(config), config);
  for (const sshTarget of ['-oProxyCommand=evil', 'a;touch /tmp/evil', 'host\nother', 'a`id`']) {
    assert.throws(() => validateClientConfig({ ...config, sshTarget }));
  }
  for (const remoteCli of ['charts', '/bin/a;id', '/bin/$(id)', '/tmp/../bin/charts']) {
    assert.throws(() => validateClientConfig({ ...config, remoteCli }));
  }
});

test('host and login are checked before opening the official browser URL', async t => {
  const calls = [];
  const { client, store, directory } = await fixture(t, async (...args) => { calls.push(args); return offer; });
  const result = await client.authorize(offer.clientUrl);
  assert.equal(result.action, 'open'); assert.equal(result.approvalUrl, offer.approvalUrl);
  assert.deepEqual(calls[0][1], ['auth', 'poll', '--login-id', pending.id]);
  assert.equal((await store.read('active')).phase, 'awaiting_callback');
  assert.equal((await fs.stat(path.join(directory, 'active.json'))).mode & 0o777, 0o600);
  await assert.rejects(client.authorize(offer.clientUrl), { code: 'LOGIN_IN_PROGRESS' });
  await assert.rejects(client.configure({ ...config, sshTarget: 'another.local' }), { code: 'LOGIN_IN_PROGRESS' });
});

test('mismatched, expired or redirected offers cannot arm the native receiver', async t => {
  for (const bad of [{ ...offer, loginId: 'changed' }, { ...offer, clientProfile: 'other' },
    { ...offer, expiresAt: new Date(now-1).toISOString() }, { ...offer, expiresAt: new Date(now+3600000).toISOString() },
    { ...offer, approvalUrl: 'https://evil.test' }]) {
    const { client, store } = await fixture(t, async () => bad);
    await assert.rejects(client.authorize(offer.clientUrl)); assert.equal(await store.read('active'), null);
  }
});

test('unarmed callbacks and wrong profiles perform no network requests', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => { calls++; return offer; });
  await assert.rejects(client.callback(callback), { code: 'CALLBACK_NOT_EXPECTED' });
  await assert.rejects(client.authorize(offer.clientUrl.replace('profile=orin', 'profile=other')), { code: 'CLIENT_PROFILE' });
  assert.equal(calls, 0);
});

test('callbacks travel once via stdin, never arguments, and local state contains no grant', async t => {
  const calls=[];
  const { client, store } = await fixture(t, async (c,args,input) => {
    calls.push({args,input}); return args[0]==='auth' && args[1]==='poll' ? offer : {status:'authenticated'};
  });
  await client.authorize(offer.clientUrl);
  const result=await client.callback(callback);
  assert.equal(result.authenticated,true);
  assert.equal(calls[1].input,callback); assert.ok(calls[1].args.includes('--callback-stdin'));
  assert.ok(!JSON.stringify(calls[1].args).includes('private-synthetic-grant'));
  assert.ok(!JSON.stringify(await store.read('active')).includes('private-synthetic-grant'));
  await assert.rejects(client.callback(callback),{code:'CALLBACK_NOT_EXPECTED'}); assert.equal(calls.length,2);
});

test('a lost SSH exchange is not replayed; a later status read recovers the outcome', async t => {
  let polls=0, sends=0;
  const { client,store }=await fixture(t,async (c,args)=>{
    if(args[1]==='poll')return ++polls===1?offer:{status:'authenticated'};
    sends++;throw new Error('connection lost');
  });
  await client.authorize(offer.clientUrl);
  await assert.rejects(client.callback(callback));
  assert.equal((await store.read('active')).phase,'outcome_unknown');
  await assert.rejects(client.callback(callback),{code:'CALLBACK_NOT_EXPECTED'});
  assert.equal((await client.status({online:true})).active.phase,'completed'); assert.equal(sends,1);
});

test('configuration changes after arming prevent forwarding to a different host', async t => {
  let calls=0; const {client,store}=await fixture(t,async()=>{calls++;return offer;});
  await client.authorize(offer.clientUrl); await store.write('config',{...config,sshTarget:'changed.local'});
  await assert.rejects(client.callback(callback),{code:'CALLBACK_NOT_EXPECTED'});assert.equal(calls,1);
});

test('stdin callback mode is bounded and never reads from the terminal', async()=>{
  assert.equal(await readCallbackStdin(Readable.from([callback])),callback);
  const tty=Readable.from([callback]);tty.isTTY=true;await assert.rejects(readCallbackStdin(tty));
  await assert.rejects(readCallbackStdin(Readable.from(['x'.repeat(16385)])));
  await assert.rejects(readCallbackStdin(Readable.from([])));
  const controller = new AbortController(), waiting = new PassThrough();
  const stopped = readCallbackStdin(waiting, controller.signal);
  controller.abort(); await assert.rejects(stopped);
  let read=0,received;
  await dispatch(['auth','complete','--login-id',pending.id,'--callback-stdin'],{readCallback:async()=>{read++;return callback;},service:{execute:async(name,args)=>{received=args;return{};}}});
  assert.equal(read,1);assert.equal(received['callback-url'],callback);assert.equal(received['callback-stdin'],undefined);
  await assert.rejects(dispatch(['auth','complete','--login-id',pending.id,'--callback-stdin','--callback-url',callback],{readCallback:async()=>{read++;}}));
  assert.equal(read,1);
  await assert.rejects(createCharts().execute('auth complete',{'login-id':pending.id,'callback-stdin':true}),{code:'INVALID_ARGUMENT'});
});

test('SSH uses a fixed executable, closed forwarding, quoted arguments and bounded output',async()=>{
  let invocation;
  const spawnImpl=(binary,args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
    invocation={binary,args,stdin:''};child.stdin.on('data',data=>{invocation.stdin+=data;});
    queueMicrotask(()=>{child.stdout.write('{"status":"authenticated"}');child.emit('close',0);});
    return child;
  };
  assert.equal((await remoteCommand(config,['auth','complete','--callback-stdin'],callback,{spawnImpl})).status,'authenticated');
  assert.equal(invocation.binary,'/usr/bin/ssh');assert.ok(invocation.args.includes('ForwardAgent=no'));
  assert.equal(invocation.stdin,callback);assert.ok(!invocation.args.join(' ').includes('private-synthetic-grant'));
});

test('host poll recovers the correct login and exposes an offer during replacement',async t=>{
  const {store}=await fixture(t);
  await store.save({version:1,credentials:{session:'old-session'},account:{id:1,username:'old'}});
  const auth=createAuth({store,sdk:async()=>({}),now:()=>now});
  const started=await auth.login({replace:true,'client-profile':'orin'});
  const poll=await auth.poll({'login-id':started.loginId});
  assert.equal(poll.status,'awaiting_callback');assert.equal(poll.clientUrl,started.clientUrl);
  assert.ok(poll.approvalUrl.startsWith('https://auth.tradingview.com/'));
  await assert.rejects(auth.poll({'login-id':pending.id}),{code:'LOGIN_NOT_FOUND'});
  assert.equal((await store.load()).account.id,1);
});
