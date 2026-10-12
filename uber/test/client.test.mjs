import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'uber-client-test-'));
process.env.UBER_CLI_STATE_DIR = state;
const { request, authenticatedRequest } = await import('../src/client.mjs');
const { saveState, readState } = await import('../src/state.mjs');
const { createContext } = await import('../src/protocol.mjs');
const nativeFetch = globalThis.fetch;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers:{'content-type':'application/json',...headers} });
const context = createContext();
test.after(async()=>{ globalThis.fetch = nativeFetch; await fs.rm(state,{recursive:true,force:true}); });

test('redirect refuses credential leakage and retains POST on trusted regional redirect', async()=>{
  let calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return calls.length===1 ? new Response(null,{status:307,headers:{location:'https://cn-dca1.cfe.uber.com/rt/example'}}) : json({ok:true});};
  assert.deepEqual(await request(context,'/rt/example/',{request:{a:1}},'test-access'),{ok:true});
  assert.equal(calls[1].options.method,'POST');
  assert.equal(calls[1].options.headers.authorization,'Bearer test-access');
  assert.equal(calls[1].options.body,calls[0].options.body);
  for(const target of ['https://evil.example/rt/example/','https://cn-dca1.uber.com/rt/other','http://cn-dca1.uber.com/rt/example/','https://cn-dca1.uber.com:8443/rt/example/']){
    globalThis.fetch=async()=>new Response(null,{status:307,headers:{location:target}});
    await assert.rejects(request(context,'/rt/example/',{},'test-access'),/unexpected redirect/);
  }
});

test('OAuth refresh and exemption renewal are automatic; valid credentials are reused',async()=>{
  await saveState('session',{context,accessToken:'expired',refreshToken:'test-refresh',expiresAt:1});
  let paths=[];
  globalThis.fetch=async(url,options)=>{
    const p=new URL(url).pathname; paths.push(p);
    if(p.endsWith('oauth2/token')){
      assert.equal(JSON.parse(options.body).request.refreshToken,'test-refresh');
      return json({oAuthInfo:{accessToken:'fresh',refreshToken:'rotated',expiresIn:{high:0,low:3600,unsigned:false},refreshTokenExpiresIn:{high:0,low:7200,unsigned:false}}});
    }
    if(p.endsWith('exemption')) return json({token:'issued-integrity',metadata:{expiry:Math.floor(Date.now()/1000)+90}});
    assert.equal(options.headers.authorization,'Bearer fresh');
    assert.equal(options.headers['x-uber-cit'],'issued-integrity');
    return json({response:{ok:true}});
  };
  await authenticatedRequest('/rt/shopping-service/order_selection/',{request:{}});
  await authenticatedRequest('/rt/shopping-service/order_selection/',{request:{}});
  assert.equal(paths.filter(p=>p.endsWith('oauth2/token')).length,1);
  assert.equal(paths.filter(p=>p.endsWith('exemption')).length,1);
  assert.equal((await readState('session')).refreshToken,'rotated');
  const i=await readState('integrity'); await saveState('integrity',{...i,expiresAt:1});
  await authenticatedRequest('/rt/shopping-service/order_selection/',{request:{}});
  assert.equal(paths.filter(p=>p.endsWith('exemption')).length,2);
});

test('integrity challenge renews once without an infinite request loop',async()=>{
  let exemptions=0,shopping=0;
  globalThis.fetch=async(url)=>{
    if(new URL(url).pathname.endsWith('exemption')){exemptions++;return json({token:'renewed',metadata:{expiry:Math.floor(Date.now()/1000)+90}});}
    shopping++;return json({code:'denied'},401,{'www-authenticate':'Uber-CIT-Sig'});
  };
  await assert.rejects(authenticatedRequest('/rt/shopping-service/order_selection/',{request:{}}),{code:'integrity_required'});
  assert.equal(exemptions,1); assert.equal(shopping,2);
});

test('network failures and temporary read errors retry within bounds; refresh never retries',async()=>{
  let calls=0;
  globalThis.fetch=async()=>{calls++; if(calls===1)throw new TypeError('network'); if(calls===2)return json({},503); return json({ok:true});};
  assert.deepEqual(await request(context,'/rt/read',{},'test',{retry:true}),{ok:true}); assert.equal(calls,3);
  calls=0;globalThis.fetch=async()=>{calls++;throw new TypeError('network');};
  await assert.rejects(request(context,'/rt/identity/oauth2/token',{},undefined),{code:'network_error'});assert.equal(calls,1);
});

test('mutations send only once on network, server and integrity failures',async()=>{
  for(const failure of ['network','server','integrity']){
    let calls=0;
    globalThis.fetch=async(url,options)=>{
      calls++;
      assert.equal(options.headers['x-uber-call-uuid'],'operation-test-id');
      if(failure==='network')throw new TypeError('connection lost after transmission');
      return failure==='server' ? json({},503) : json({},401,{'www-authenticate':'Uber-CIT-Sig'});
    };
    await assert.rejects(authenticatedRequest('/rt/test-create',{request:{}},{readOnly:false,callUuid:'operation-test-id'}));
    assert.equal(calls,1,`${failure} must not trigger a second mutation`);
  }
});

test('payment profile reads use GET without a JSON body',async()=>{
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).pathname,'/rt/payment/v3/payment-profiles');
    assert.equal(options.method,'GET');assert.equal(options.body,undefined);
    assert.equal(options.headers['x-uber-uuid'],'test-rider');
    return json({paymentProfiles:[]});
  };
  await authenticatedRequest('/rt/payment/v3/payment-profiles',undefined,{method:'GET',extraHeaders:{'x-uber-uuid':'test-rider'}});
});
