import test from 'node:test';
import assert from 'node:assert/strict';
import { request, authenticatedOperation, authenticatedRequest } from '../src/http.mjs';
function fixture(response) {
  const values = new Map(), calls = []; let locked = false;
  const store = { async readState(n) { return values.get(n) ?? null; }, async saveState(n,v) { values.set(n,v); }, async withStateLock(fn) { assert.equal(locked,false); locked=true; try{return await fn();}finally{locked=false;} } };
  const fetchImpl = async (url, args) => { calls.push({url,args,locked}); return typeof response === 'function' ? response(url,args,calls.length) : Response.json(response ?? {error:0,message:'OK'}); };
  return { values, calls, store, options: { store, fetchImpl } };
}

test('POST omits its body when form is undefined and sends exact scalar form encoding otherwise', async () => {
  const f=fixture(); await request('/v2/home',{},f.options);
  assert.equal(Object.hasOwn(f.calls[0].args,'body'),false); assert.equal(f.calls[0].args.headers['Content-Type'],undefined);
  await request('/v1/phoneverify',{form:{phone:'2025550100',otp:'0012',userDetails:'{}',device_id:'sample-id',flag:false},token:'private'},f.options);
  const call=f.calls[1]; assert.equal(call.args.body,'phone=2025550100&otp=0012&userDetails=%7B%7D&device_id=sample-id&flag=false');
  assert.equal(call.args.headers.Authorization,'Bearer private'); assert.equal(call.args.redirect,'manual');
  const record=f.values.get('last-response'); assert.equal(Object.hasOwn(record,'headers'),false); assert.equal(Object.hasOwn(record,'body'),false);
});

test('off-origin paths, non-scalar forms, and mutation retries are rejected before fetch',async()=>{
 const f=fixture();
 for(const endpoint of ['https://example.test/v1/login','//example.test/v1/login','/v1/../../outside','/v1/login#token'])await assert.rejects(request(endpoint,{},f.options),{code:'INVALID_ENDPOINT'});
 await assert.rejects(request('/v1/login',{form:{nested:{secret:'x'}}},f.options),{code:'INVALID_FORM'});
 await assert.rejects(request('/v1/login',{form:{phone:'2025550100'},retries:1},f.options),{code:'INVALID_RETRY'});
 assert.equal(f.calls.length,0);
});

test('API error3 and HTTP401 require authentication without deleting a session or journals',async()=>{
 for(const status of [200,401]){
  const f=fixture(()=>Response.json({error:3,message:'private'}, {status}));f.values.set('session',{token:'private'});f.values.set('operation-test',{unknown:true});
  await assert.rejects(request('/v2/myerewhon',{allowErrors:true},f.options),{code:'AUTH_REQUIRED'});
  assert.equal(f.values.get('session').token,'private');assert.deepEqual(f.values.get('operation-test'),{unknown:true});
 }
});

test('allowErrors returns application rejection only after successful HTTP; errors expose no server payload',async()=>{
 const f=fixture({error:1,message:'token-private-value'});
 await assert.rejects(request('/v1/login',{},f.options),e=>e.code==='API_REJECTED'&&!e.message.includes('token-private-value'));
 assert.equal((await request('/v1/login',{allowErrors:true},f.options)).error,1);
 const bad=fixture(()=>Response.json({error:0},{status:503}));
 await assert.rejects(request('/v1/login',{allowErrors:true},bad.options),{code:'HTTP_ERROR',status:503});assert.equal(bad.calls.length,1);
});

test('only explicitly requested read retries repeat a failed request and their count is bounded',async()=>{
 const f=fixture((_,__,n)=>Response.json({error:0},{status:n<3?503:200}));
 await request('/v2/myerewhon',{readOnly:true,retries:2},f.options);assert.equal(f.calls.length,3);
 const mutation=fixture(()=>{throw Error('secret thrown fetch message');});
 await assert.rejects(request('/v1/phoneverify',{form:{otp:'0012'}},mutation.options),e=>e.code==='NETWORK_ERROR'&&!e.message.includes('secret'));
 assert.equal(mutation.calls.length,1);
});

test('a redirect or invalid JSON is stopped without following its credential-bearing target',async()=>{
 const f=fixture(()=>new Response('not json',{status:302,headers:{Location:'https://example.test'}}));
 await assert.rejects(request('/v1/userprofile',{method:'GET',token:'private'},f.options),{code:'INVALID_RESPONSE'});assert.equal(f.calls.length,1);
 assert.equal(f.values.get('last-response').invalidJSON,true);
});

test('authenticated outer operation binds the current token and holds one lock across sends',async()=>{
 const f=fixture();f.values.set('session',{token:'private-session',deviceId:'device'});
 await authenticatedOperation(async({session,send})=>{assert.equal(session.deviceId,'device');await send('/v2/myerewhon',{token:'other'});await send('/v1/userprofile',{method:'GET'});},f.options);
 assert.ok(f.calls.every(x=>x.locked&&x.args.headers.Authorization==='Bearer private-session'));
 await authenticatedRequest('/v2/myerewhon',{},f.options);assert.equal(f.calls.length,3);
 const absent=fixture();await assert.rejects(authenticatedOperation(()=>assert.fail('not called'),absent.options),{code:'AUTH_REQUIRED'});
});

test('PUT uses a form body while DELETE encodes fields in the URL and omits a body',async()=>{
 const f=fixture();
 await request('/v1/set_address/address-test',{method:'PUT',form:{default:true}},f.options);
 assert.equal(f.calls[0].args.method,'PUT');assert.equal(f.calls[0].args.body,'default=true');
 await request('/v1/remove_address?existing=yes',{method:'DELETE',form:{address_id:'address & test'}},f.options);
 const url=new URL(f.calls[1].url);assert.equal(url.searchParams.get('existing'),'yes');assert.equal(url.searchParams.get('address_id'),'address & test');
 assert.equal(Object.hasOwn(f.calls[1].args,'body'),false);assert.equal(f.calls[1].args.headers['Content-Type'],undefined);
});

test('JSON-valued checkout fields match the website RFC3986 body rather than plus-for-space encoding',async()=>{
 const f=fixture();const time=JSON.stringify({date:'Wed, Oct 14',time:'30 - 45 minutes'});
 await request('/v1/place_order',{form:{delivery_time:time,instruction:'A+B !() café'}},f.options);
 assert.equal(f.calls[0].args.body,'delivery_time=%7B%22date%22%3A%22Wed%2C%20Oct%2014%22%2C%22time%22%3A%2230%20-%2045%20minutes%22%7D&instruction=A%2BB%20%21%28%29%20caf%C3%A9');
 assert.equal(new URLSearchParams(f.calls[0].args.body).get('delivery_time'),time);
});
