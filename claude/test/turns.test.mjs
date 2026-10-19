import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'claude-turns-'));
process.env.CLAUDE_CHAT_STATE_DIR=directory;
const {withStateLock,readState,saveState}=await import('../src/state.mjs');
const {createTurnService,observeTurn}=await import('../src/turns.mjs');
const {createProfile}=await import('../src/client-profile.mjs');
const {ClaudeError}=await import('../src/errors.mjs');
const {sessionBinding}=await import('../src/auth.mjs');
const org=randomUUID(),account=randomUUID(),chat=randomUUID(),oldHuman=randomUUID(),oldAssistant=randomUUID();
const root='00000000-0000-4000-8000-000000000000';
let session;
test.beforeEach(async()=>{for(const file of await fs.readdir(directory))await fs.rm(path.join(directory,file),{recursive:true,force:true});session={generation:randomUUID(),profile:createProfile(),account:{uuid:account,email_address:'test@example.invalid',memberships:[{organization:{uuid:org}}]}};});
test.after(async()=>fs.rm(directory,{recursive:true,force:true}));
function harness(request,consume){return createTurnService({withClient:operation=>withStateLock(()=>operation({request},session)),consume});}
const base={uuid:chat,current_leaf_message_uuid:oldAssistant,chat_messages:[{uuid:oldHuman,parent_message_uuid:root,sender:'human',text:'Prior'},{uuid:oldAssistant,parent_message_uuid:oldHuman,sender:'assistant',stop_reason:'end_turn',text:'Prior answer'}]};

test('a lost POST response blocks duplicate submission, including a fresh operation ID',async()=>{
 let posts=0;
 const service=harness(async(_url,options)=>{if(options?.method==='POST'){posts++;throw new ClaudeError('NETWORK_ERROR','Lost after upload');}return base;});
 const input={operationId:randomUUID(),chatId:chat,prompt:'Reply once',timezone:'UTC'};
 await assert.rejects(service.send(input),{code:'TURN_SUBMISSION_FAILED'});
 const known=await service.send(input);assert.equal(known.status,'outcome_unknown');assert.equal(posts,1);
 await assert.rejects(service.send({...input,operationId:randomUUID()}),{code:'TURN_PENDING'});assert.equal(posts,1);
 const status=await service.status({operationId:input.operationId});assert.equal(status.observation.humanSeen,false);
 await assert.rejects(service.send({...input,prompt:'Changed'}),{code:'OPERATION_INPUT_CHANGED'});
});

test('a fresh process reconciles exact persisted IDs after an interrupted stream without resending',async()=>{
 let submitted,posts=0;
 const service=harness(async(_url,options)=>{
  if(options?.method==='POST'){posts++;submitted=options.json;return {body:[]};}
  if(!submitted)return base;
  return {...base,current_leaf_message_uuid:submitted.turn_message_uuids.assistant_message_uuid,chat_messages:[...base.chat_messages,
   {uuid:submitted.turn_message_uuids.human_message_uuid,parent_message_uuid:oldAssistant,sender:'human',text:'New'},
   {uuid:submitted.turn_message_uuids.assistant_message_uuid,parent_message_uuid:submitted.turn_message_uuids.human_message_uuid,sender:'assistant',text:'Recovered answer',stop_reason:'end_turn'}]};
 },async()=>{throw new ClaudeError('STREAM_INCOMPLETE','EOF');});
 const operationId=randomUUID();
 const result=await service.send({operationId,chatId:chat,prompt:'New',timezone:'UTC'});
 assert.equal(result.status,'completed');assert.equal(result.result.assistant.text,'Recovered answer');assert.equal(posts,1);
 const repeat=await service.send({operationId,chatId:chat,prompt:'New',timezone:'UTC'});
 assert.equal(repeat.status,'completed');assert.equal(posts,1);
 const saved=await readState(`turn-${operationId}`);
 await saveState(`active-${saved.binding}`,{id:operationId});
 await service.status({operationId});assert.equal(await readState(`active-${saved.binding}`),null);
});

test('streaming releases the state mutex so another command can stop the exact completion',async()=>{
 let request,streamStarted,finishStream;
 const started=new Promise(resolve=>{streamStarted=resolve;});
 const finished=new Promise(resolve=>{finishStream=resolve;});
 let stopRequests=0;
 const service=harness(async(url,options)=>{
  if(url.endsWith('/completion')){request=options.json;return {body:[]};}
  if(url.endsWith('/stop_response')){stopRequests++;assert.equal(options.json.completion_request_id,request.completion_request_id);finishStream();return {status:200};}
  if(!request)return base;
  return {...base,chat_messages:[...base.chat_messages,{uuid:request.turn_message_uuids.human_message_uuid,parent_message_uuid:oldAssistant,sender:'human',text:'New'},...(stopRequests?[{uuid:request.turn_message_uuids.assistant_message_uuid,parent_message_uuid:request.turn_message_uuids.human_message_uuid,sender:'assistant',text:'',stop_reason:'stop_sequence'}]:[])]};
 },async()=>{streamStarted();await finished;throw new ClaudeError('STREAM_INCOMPLETE','Stopped');});
 const operationId=randomUUID(),send=service.send({operationId,chatId:chat,prompt:'New',timezone:'UTC'});
 await started;
 const stopped=await service.stop({operationId});assert.equal(stopped.status,'stopped');
 assert.equal((await send).status,'stopped');await service.stop({operationId});assert.equal(stopRequests,1);
});

test('another login cannot inspect or stop a saved turn',async()=>{
 const operationId=randomUUID();await saveState(`turn-${operationId}`,{id:operationId,binding:'other-account',phase:'streaming'});
 const service=harness(async()=>{throw Error('Network must not be used');});
 await assert.rejects(service.status({operationId}),{code:'SESSION_CHANGED'});
 await assert.rejects(service.stop({operationId}),{code:'SESSION_CHANGED'});
});

test('reconciliation rejects a server message with the right ID but wrong branch',()=>{
 const humanMessageId=randomUUID(),assistantMessageId=randomUUID();
 assert.throws(()=>observeTurn({humanMessageId,assistantMessageId,parentMessageId:oldAssistant},{messages:[{id:humanMessageId,parentMessageId:root,sender:'human'}]}),{code:'TURN_IDENTITY_MISMATCH'});
});

test('server-assigned IDs from the owning stream survive a lost EOF and reconcile the exact branch',async()=>{
 const human=randomUUID(),assistant=randomUUID();let submitted=false,posts=0;
 const bytes=Buffer.from(`data: ${JSON.stringify({type:'conversation_ready'})}\n\ndata: ${JSON.stringify({type:'message_start',message:{uuid:assistant,parent_uuid:human,role:'assistant',content:[]}})}\n\n`);
 const service=harness(async(_url,options)=>{
  if(options?.method==='POST'){posts++;submitted=true;return {body:[bytes]};}
  if(!submitted)return base;
  return {...base,current_leaf_message_uuid:assistant,chat_messages:[...base.chat_messages,{uuid:human,parent_message_uuid:oldAssistant,sender:'human',content:[{type:'text',text:'New'}]},{uuid:assistant,parent_message_uuid:human,sender:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Recovered from own stream'}]}]};
 });
 const operationId=randomUUID(),result=await service.send({operationId,chatId:chat,prompt:'New',timezone:'UTC'});
 assert.equal(result.status,'completed');assert.equal(result.humanMessageId,human);assert.equal(result.assistantMessageId,assistant);
 assert.equal(result.result.assistant.text,'Recovered from own stream');assert.equal(posts,1);
 const saved=await readState(`turn-${operationId}`);assert.notEqual(saved.assistantMessageId,assistant);assert.equal(saved.acknowledged.assistantMessageId,assistant);
});

test('a crash before the submission journal can release its prepared marker without any network request',async()=>{
 const operationId=randomUUID(),binding=sessionBinding(session);
 await saveState(`turn-${operationId}`,{id:operationId,binding,phase:'prepared'});await saveState(`active-${binding}`,{id:operationId});
 const service=harness(async()=>{throw Error('Prepared recovery must not access the network');});
 const result=await service.status({operationId});assert.equal(result.status,'not_submitted');assert.equal(await readState(`active-${binding}`),null);
 assert.equal((await service.stop({operationId})).status,'not_submitted');
});
