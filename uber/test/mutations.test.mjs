import test from 'node:test';
import assert from 'node:assert/strict';
import { executeMutation } from '../src/mutations.mjs';

const operation = {id:'df00bf9a-d252-42f4-9a7c-4e6aeaf79a3c',kind:'booking',endpoint:'/rt/test',body:{request:{selection:'x'}}};
function store() {
  const records = new Map();
  return {records,read:async key => records.get(key),write:async (key,value) => records.set(key,structuredClone(value))};
}
test('accepted operations return their saved result without sending twice',async () => {
  const state = store(); let calls=0;
  const send=async (endpoint,body,options) => {
    calls++; assert.equal(state.records.values().next().value.state,'submitting');
    assert.deepEqual(options,{readOnly:false,callUuid:operation.id}); return {order:{id:'order'}};
  };
  assert.deepEqual(await executeMutation(operation,send,state),{order:{id:'order'}});
  assert.deepEqual(await executeMutation(operation,send,state),{order:{id:'order'}});
  assert.equal(calls,1);
  await assert.rejects(executeMutation({...operation,body:{}},send,state),/different request/);
});
test('network, server and crashed operations remain uncertain and cannot be repeated',async () => {
  for (const status of [undefined,503,409]) {
    const state=store();let calls=0;
    const send=async () => {calls++;throw Object.assign(new Error('Connection lost'),{status});};
    await assert.rejects(executeMutation(operation,send,state),{code:'outcome_unknown',operationId:operation.id});
    await assert.rejects(executeMutation(operation,send,state),{code:'outcome_unknown'});
    assert.equal(calls,1);
    state.records.values().next().value.state='submitting';
    await assert.rejects(executeMutation(operation,send,state),{code:'outcome_unknown'});
    assert.equal(calls,1);
  }
});
test('persistence failure before sending prevents the request; after sending blocks repetition',async () => {
  let calls=0;
  await assert.rejects(executeMutation(operation,async () => {calls++;},{read:async()=>null,write:async()=>{throw new Error('disk');}}),/disk/);
  assert.equal(calls,0);
  const state=store();const write=state.write;let writes=0;
  state.write=async (...args) => {if(++writes===2)throw new Error('disk');return write(...args);};
  const send=async()=>{calls++;return {order:{id:'order'}};};
  await assert.rejects(executeMutation(operation,send,state),{code:'outcome_unknown'});
  await assert.rejects(executeMutation(operation,send,state),{code:'outcome_unknown'});
  assert.equal(calls,1);
});
test('definitive validation rejection is recorded and not silently retried',async()=>{
  const state=store();let calls=0;
  const send=async()=>{calls++;throw Object.assign(new Error('Bad selection'),{status:422});};
  await assert.rejects(executeMutation(operation,send,state),{status:422,operationId:operation.id});
  await assert.rejects(executeMutation(operation,send,state),{code:'operation_rejected'});
  assert.equal(calls,1);
});
test('an unrecognized success response remains uncertain instead of reporting a booked ride',async()=>{
  const state=store();let calls=0;
  const send=async()=>{calls++;return {unexpected:'shape'};};
  const request={...operation,validate:()=>{throw new Error('Unknown booking response');}};
  await assert.rejects(executeMutation(request,send,state),{code:'outcome_unknown'});
  await assert.rejects(executeMutation(request,send,state),{code:'outcome_unknown'});
  assert.equal(calls,1);
});
