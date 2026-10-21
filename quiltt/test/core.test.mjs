import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { inspectConnector } from '../src/config.mjs';
import { request, graphql } from '../src/http.mjs';
import { validateSession, createDataTools } from '../src/data.mjs';
import { createLoginServer, callbackToken, beginPage } from '../src/auth-worker.mjs';

test('only official Sandbox connector metadata configures a bank-linking flow', async () => {
  for (const [mode, id, expected] of [['SANDBOX','sample',true],['PRODUCTION','sample',false],['TEST','sample',false],['SANDBOX','different',false]]) {
    const operation = inspectConnector('sample', { fetchImpl: async (url, options) => {
      assert.equal(url,'https://sample.quiltt.app/'); assert.equal(options.redirect,'error');
      return new Response(`<div id="root" data-connector-id="${id}" data-environment-id="env_test" data-environment-mode="${mode}"></div>`);
    } });
    if (expected) assert.deepEqual(await operation,{id:'env_test',mode:'SANDBOX'});
    else await assert.rejects(operation,{code:'SANDBOX_REQUIRED'});
  }
  await assert.rejects(inspectConnector('user@example.com'),{code:'INVALID_CONNECTOR'});
});
test('HTTP uses documented fixed endpoints and partial GraphQL data is never complete success', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url,'https://api.quiltt.io/v1/graphql'); assert.equal(options.redirect,'error');
    assert.equal(options.headers['quiltt-version'],'2026-04-01');
    return new Response(JSON.stringify({data:{accounts:[]},errors:[{message:'Synthetic failure'}]}));
  };
  await assert.rejects(graphql('query { accounts { id } }',{}, {token:'synthetic-token-00000',fetchImpl}),{code:'GRAPHQL_ERROR'});
  await assert.rejects(request('https://example.invalid',{token:'synthetic-token-00000'}),{code:'INVALID_REQUEST'});
});
test('a browser credential must be validated by Quiltt and independently identify the same Profile/environment', async () => {
  const config={environment:{id:'env_test',mode:'SANDBOX'}};
  const session={userId:'p_test',environmentId:'env_test',expiresAt:new Date(Date.now()+60000).toISOString()};
  const dependencies={requestImpl:async()=>session,query:async()=>({profile:{id:'p_test',email:'example@example.test'}})};
  assert.equal((await validateSession('synthetic-token-00000',config,dependencies)).validated,true);
  await assert.rejects(validateSession('synthetic-token-00000',{environment:{id:'env_other'}},dependencies),{code:'SESSION_MISMATCH'});
  await assert.rejects(validateSession('synthetic-token-00000',config,{...dependencies,query:async()=>({profile:{id:'p_other'}})}),{code:'SESSION_MISMATCH'});
});
test('transaction cursors retain profile, dates, page size and upstream pagination without skipping pages', async () => {
  const records=new Map(),calls=[]; let profile='p_test',time=1000;
  const selected=()=>({config:{environment:{id:'env_test'}},session:{profile:{id:profile},token:'synthetic-token-00000'}});
  const tools=createDataTools({context:async()=>selected(),lock:async op=>op(),read:async key=>records.get(key),save:async(key,value)=>records.set(key,value),
    assertProfile:async context=>assert.equal(context.session.profile.id,profile),now:()=>time,uuid:()=> '00000000-0000-4000-8000-000000000001',
    query:async query=>{calls.push(query);return {transactions:{count:2,nodes:[{id:'txn_test'}],pageInfo:{hasNextPage:calls.length===1,endCursor:'upstream-private-cursor'}}};}});
  const first=await tools.transactions({limit:1,startDate:'2026-10-01',status:'POSTED'});
  assert.equal(first.hasMore,true);assert.match(first.cursor,/^quiltt-transactions:/);assert.equal(JSON.stringify(first).includes('upstream-private-cursor'),false);
  const second=await tools.transactions({cursor:first.cursor});assert.equal(second.hasMore,false);
  assert.match(calls[1],/after:"upstream-private-cursor"/);assert.match(calls[1],/date_gte:"2026-10-01"/);assert.match(calls[1],/first:1/);
  await assert.rejects(tools.transactions({cursor:first.cursor,status:'PENDING'}),{code:'CURSOR_MISMATCH'});
  profile='p_other';await assert.rejects(tools.transactions({cursor:first.cursor}),{code:'CURSOR_EXPIRED'});
  profile='p_test';time=4_000_000;await assert.rejects(tools.transactions({cursor:first.cursor}),{code:'CURSOR_EXPIRED'});
  assert.equal(calls.length,2);
});
test('dates/enums cannot inject queries, null balances stay null, and nonadvancing pages fail', async () => {
  let calls=0;
  const tools=createDataTools({context:async()=>({config:{environment:{id:'env_test'}},session:{profile:{id:'p_test'},token:'synthetic-token-00000'}}),lock:async op=>op(),assertProfile:async()=>{},
    query:async()=>{calls++;return {accounts:[{id:'acct_test',balance:null}],transactions:{nodes:[],pageInfo:{hasNextPage:true,endCursor:null}}};}});
  for(const options of [{startDate:'2026-02-30'},{status:'POSTED} mutation {'},{limit:101},{entryType:'UNKNOWN'}]) await assert.rejects(tools.transactions(options),{code:'INVALID_ARGUMENT'});
  assert.equal(calls,0);assert.equal((await tools.balances()).balances[0].balance,null);
  await assert.rejects(tools.transactions(),{code:'INVALID_RESPONSE'});
});
test('callback requires one genuine token candidate; untrusted Profile metadata is not an authentication grant',()=>{
  assert.equal(callbackToken(new URL('https://example.test/callback?token=aaa.bbb.ccc&profileId=p_other')),'aaa.bbb.ccc');
  assert.throws(()=>callbackToken(new URL('https://example.test/callback?profileId=p_other')));
  assert.throws(()=>callbackToken(new URL('https://example.test/callback?a=aaa.bbb.ccc&b=ddd.eee.fff')));
  assert.throws(()=>beginPage("'\n</script>"));
  const page=beginPage('a'.repeat(32));assert.match(page.headers['content-security-policy'],/default-src 'none'/);assert.match(page.html,/location.replace/);
});
test('connection server binds the browser to its private link and validates once without trusting Profile metadata', async()=>{
  const loginId='a'.repeat(32),secret='s'.repeat(43),origin='https://public.example.test';let validations=0;
  const config={connectorId:'sample',environment:{id:'env_test',mode:'SANDBOX'}};
  const records=new Map([['login',{loginId,secret,status:'waiting',connectorId:'sample',environmentId:'env_test',expiresAt:Date.now()+60000}],['session',{profile:{id:'p_old'}}]]);
  const server=createLoginServer({loginId,origin:()=>origin,read:async key=>structuredClone(records.get(key)),save:async(key,value)=>records.set(key,structuredClone(value)),lock:async op=>op(),configReader:async()=>config,
    validate:async token=>{validations++;assert.equal(token,'aaa.bbb.ccc');return {validated:true,profile:{id:'p_test'},environmentId:'env_test',token};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  async function call(path,headers={},method='GET') {
    return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,headers:{host:'public.example.test',...headers}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));});req.on('error',reject);req.end();});
  }
  try {
    assert.equal((await call('/callback?token=aaa.bbb.ccc')).status,403);assert.equal(validations,0);
    assert.equal((await call(`/pair/${loginId}/begin`,{origin,'x-quiltt-pair-key':'wrong'},'POST')).status,403);
    const begin=await call(`/pair/${loginId}/begin`,{origin,'x-quiltt-pair-key':secret},'POST');assert.equal(begin.status,200);
    const cookie=begin.headers['set-cookie'][0];assert.match(cookie,/Secure; HttpOnly; SameSite=Lax/);
    const result=await call('/callback?token=aaa.bbb.ccc&profileId=p_forged',{cookie:cookie.split(';')[0]});assert.equal(result.status,303);assert.equal(result.headers.location,'/done');
    assert.equal(records.get('session').profile.id,'p_test');assert.equal(records.get('login').secret,undefined);assert.equal(validations,1);
    assert.equal((await call('/callback?token=aaa.bbb.ccc',{cookie:cookie.split(';')[0]})).status,410);assert.equal(validations,1);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('failed validation and cancellation during validation never replace the previous saved Profile', async()=>{
  for(const scenario of ['rejected','cancelled','profile_mismatch']) {
    const loginId='a'.repeat(32),secret='s'.repeat(43),old={validated:true,profile:{id:'p_old'}};
    const records=new Map([['login',{loginId,secret,status:'waiting',connectorId:'sample',environmentId:'env_test',expectedProfileId:scenario==='profile_mismatch'?'p_old':null,expiresAt:Date.now()+60000}],['session',old]]);
    const server=createLoginServer({loginId,origin:()=> 'https://public.example.test',read:async key=>structuredClone(records.get(key)),save:async(key,value)=>records.set(key,structuredClone(value)),lock:async op=>op(),
      configReader:async()=>({connectorId:'sample',environment:{id:'env_test'}}),validate:async()=>{
        if(scenario==='rejected')throw Error('Synthetic authentication failure');
        if(scenario==='cancelled')records.set('login',{...records.get('login'),status:'canceled'});
        return {validated:true,profile:{id:'p_other'},environmentId:'env_test'};
      }});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    try {
      const status=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path:'/callback?token=aaa.bbb.ccc',headers:{host:'public.example.test',cookie:`__Host-quiltt-pair=${loginId}.${secret}`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});
      assert.equal(status,scenario==='cancelled'?409:401);assert.deepEqual(records.get('session'),old);
    } finally { await new Promise(resolve=>server.close(resolve)); }
  }
});
