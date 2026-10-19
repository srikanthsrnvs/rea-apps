import {randomUUID,createHash} from 'node:crypto';
import {ClaudeError} from './errors.mjs';
import {withClient,sessionBinding} from './auth.mjs';
import {readState,saveState,removeState,withStateLock} from './state.mjs';
import {organizationFor,readChatWithClient} from './chats.mjs';
import {buildCompletionRequest,buildStopRequest,selectReplyParent,ROOT_MESSAGE_UUID} from './chat-write-protocol.mjs';
import {consumeCompletionStream} from './sse.mjs';
import {completionMode} from './native-configuration.mjs';

const fail=(code,message,details)=>{throw new ClaudeError(code,message,details);};
const terminal=phase=>['completed','stopped','rejected','not_submitted'].includes(phase);
const id=value=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value??''))fail('INVALID_ARGUMENT','Operation ID must be a UUID.');return value.toLowerCase();};
const key=operationId=>`turn-${id(operationId)}`;
const activeKey=binding=>`active-${binding}`;
const signature=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicTurn=turn=>({operationId:turn.id,status:turn.phase,organizationId:turn.organizationId,chatId:turn.chatId,completionRequestId:turn.completionRequestId,humanMessageId:turn.acknowledged?.humanMessageId??turn.humanMessageId,assistantMessageId:turn.acknowledged?.assistantMessageId??turn.assistantMessageId,...(turn.result?{result:turn.result}:{}),...(turn.error?{error:turn.error}:{}),...(turn.observation?{observation:turn.observation}:{}),updatedAt:turn.updatedAt});
async function persist(turn){turn.updatedAt=new Date().toISOString();await saveState(key(turn.id),turn);}
async function release(turn){const name=activeKey(turn.binding),active=await readState(name);if(active?.id===turn.id)await removeState(name);}
async function recoverPrepared(turn){if(turn.phase==='prepared'){turn.phase='not_submitted';await persist(turn);await release(turn);}}
async function owned(operationId,session){const turn=await readState(key(operationId));if(!turn)fail('OPERATION_NOT_FOUND','No saved turn has this operation ID.');if(turn.binding!==sessionBinding(session))fail('SESSION_CHANGED','This turn belongs to a different saved login.');return turn;}
function acknowledge(turn,message){
 if(!message?.uuid||!message.parent_uuid)return;
 const received={humanMessageId:id(message.parent_uuid),assistantMessageId:id(message.uuid)};
 if(turn.acknowledged&&JSON.stringify(turn.acknowledged)!==JSON.stringify(received))fail('TURN_IDENTITY_MISMATCH','The server changed its acknowledged turn identity.');
 // These identities came from this operation's authenticated SSE response.
 // The following GET must still verify both roles and the original branch.
 turn.acknowledged=received;
}

export function observeTurn(turn,conversation){
 const humanId=turn.acknowledged?.humanMessageId??turn.humanMessageId,assistantId=turn.acknowledged?.assistantMessageId??turn.assistantMessageId;
 const human=conversation.messages.find(m=>m.id===humanId),assistant=conversation.messages.find(m=>m.id===assistantId);
 if(human&&(human.sender!=='human'||human.parentMessageId!==turn.parentMessageId))fail('TURN_IDENTITY_MISMATCH','The saved human message has a different identity or parent.');
 if(human&&turn.promptHash&&signature(human.text)!==turn.promptHash)fail('TURN_IDENTITY_MISMATCH','The acknowledged human message differs from the submitted prompt.');
 if(assistant&&(assistant.sender!=='assistant'||assistant.parentMessageId!==humanId))fail('TURN_IDENTITY_MISMATCH','The saved assistant message has a different identity or parent.');
 if(assistant&&!human)fail('TURN_IDENTITY_MISMATCH','The reply was returned without its submitted human message.');
 return {humanSeen:!!human,assistantSeen:!!assistant,assistantFinished:!!assistant?.stopReason,...(assistant?{assistant}:{}),currentLeafMessageId:conversation.currentLeafMessageId};
}

// Network dependencies are injected only to exercise lost-response recovery.
export function createTurnService(deps={}){
 const useClient=deps.withClient??withClient,consume=deps.consume??consumeCompletionStream;
 async function reconcile(client,turn){
  if(!turn.acknowledged&&turn.streamResult?.messages?.length===1)acknowledge(turn,turn.streamResult.messages[0]);
  const conversation=await readChatWithClient(client,turn.organizationId,turn.chatId);
  const observation=observeTurn(turn,conversation);turn.observation=observation;
  if(observation.assistantFinished){turn.phase=turn.stopAccepted?'stopped':'completed';turn.result={assistant:observation.assistant};}
  else if(turn.streamFinished&&observation.humanSeen&&observation.assistantSeen){turn.phase=turn.stopAccepted?'stopped':'completed';turn.result={assistant:observation.assistant};}
  await persist(turn);if(terminal(turn.phase))await release(turn);return publicTurn(turn);
 }
 async function send({operationId=randomUUID(),organizationId,chatId,prompt,parentMessageId,timezone=Intl.DateTimeFormat().resolvedOptions().timeZone,model,name='',temporary=false}={}){
  operationId=id(operationId);
  const input={organizationId:organizationId??null,chatId:chatId??null,prompt,parentMessageId:parentMessageId??null,timezone,model:model??null,name,temporary};
  // Validate prompt, timezone and all caller-supplied IDs before allocating state.
  const preview=buildCompletionRequest({organizationId:organizationId??randomUUID(),chatId:chatId??randomUUID(),prompt,parentMessageId:parentMessageId??ROOT_MESSAGE_UUID,timezone,model,completionRequestId:randomUUID(),humanMessageId:randomUUID(),assistantMessageId:randomUUID(),...(chatId?{}:{create:{name,temporary}})});
  void preview;
  let turn,stream;
  const existing=await useClient(async(client,session)=>{
   const previous=await readState(key(operationId));
   if(previous){await owned(operationId,session);if(previous.inputHash!==signature(input))fail('OPERATION_INPUT_CHANGED','This operation ID was already used with different input.');await recoverPrepared(previous);if(terminal(previous.phase))await release(previous);turn=previous;return publicTurn(previous);}
   const binding=sessionBinding(session);let active=await readState(activeKey(binding));
   if(active){const saved=await readState(key(active.id));if(saved?.binding===binding){await recoverPrepared(saved);if(terminal(saved.phase)){await release(saved);active=null;}}}
   if(active)fail('TURN_PENDING','An earlier turn must be inspected or stopped before sending another.',{operationId:active.id});
   const organization=organizationFor(session,organizationId),conversation=chatId?await readChatWithClient(client,organization,chatId):{messages:[],currentLeafMessageId:null};
   const parent=selectReplyParent(conversation,{parentMessageId});
   if(conversation.messages.find(m=>m.id===parent)?.sender==='human')fail('TURN_IN_PROGRESS','The selected branch ends in an unanswered human message. Inspect or stop it before continuing.');
   turn={id:operationId,binding,inputHash:signature(input),promptHash:signature(prompt),phase:'prepared',organizationId:organization,chatId:chatId??randomUUID(),parentMessageId:parent,completionRequestId:randomUUID(),humanMessageId:randomUUID(),assistantMessageId:randomUUID(),createdAt:new Date().toISOString()};
   const bard=await completionMode(client,session,organization);
   const request=buildCompletionRequest({...turn,prompt,timezone,model,bard,...(chatId?{}:{create:{name,temporary}})});
   turn.bard=bard;
   await persist(turn);await saveState(activeKey(binding),{id:turn.id});
   turn.phase='request_pending';await persist(turn);
   try{stream=await client.request(request.url,{...request,responseType:'stream',timeoutMs:600000});turn.phase='streaming';await persist(turn);}
   catch(error){
    turn.error={code:error instanceof ClaudeError?error.code:'LOCAL_ERROR',message:'The completion was not automatically retried.'};
    if(error.code==='HTTP_ERROR'&&[400,401,403,404,422].includes(error.details?.httpStatus)||error.code==='RATE_LIMITED')turn.phase='rejected';
    else turn.phase='outcome_unknown';
    await persist(turn);if(terminal(turn.phase))await release(turn);
    throw new ClaudeError('TURN_SUBMISSION_FAILED','The turn was not replayed. Inspect the saved operation before sending again.',publicTurn(turn));
   }
   return null;
  });
  if(existing)return existing;
  // Consume outside the global mutex so another process can inspect or stop.
  try{
   const result=await consume(stream.body,{snapshotOnEvent:false,onEvent:async event=>{
    if(event.type==='message_start')await withStateLock(async()=>{const current=await readState(key(turn.id));if(!current)return;acknowledge(current,event.message);await persist(current);});
   }});
   await withStateLock(async()=>{const current=await readState(key(turn.id));if(!current)return;current.streamFinished=true;current.streamResult=result;await persist(current);});
  }catch(error){
   await withStateLock(async()=>{const current=await readState(key(turn.id));if(!current)return;current.error={code:error instanceof ClaudeError?error.code:'STREAM_ERROR',message:'The response stream ended without a confirmed completion.'};if(!terminal(current.phase))current.phase='outcome_unknown';await persist(current);});
  }
  return status({operationId:turn.id});
 }
 async function status({operationId}={}){return useClient(async(client,session)=>{
  const turn=await owned(operationId,session);await recoverPrepared(turn);if(terminal(turn.phase)){await release(turn);return publicTurn(turn);}
  try{return await reconcile(client,turn);}catch(error){turn.observation={readError:error instanceof ClaudeError?error.code:'LOCAL_ERROR'};await persist(turn);return publicTurn(turn);}
 });}
 async function stop({operationId}={}){return useClient(async(client,session)=>{
  const turn=await owned(operationId,session);await recoverPrepared(turn);if(terminal(turn.phase)){await release(turn);return publicTurn(turn);}
  if(turn.stopPhase==='request_pending')fail('STOP_OUTCOME_UNKNOWN','The previous stop response was lost. Inspect this operation; the stop was not replayed.',publicTurn(turn));
  if(!turn.stopPhase){
   const request=buildStopRequest(turn);turn.stopPhase='request_pending';await persist(turn);
   const response=await client.request(request.url,{...request,responseType:'response'});
   turn.stopPhase='response_received';turn.stopHttpStatus=response.status;turn.stopAccepted=response.status>=200&&response.status<300;if(turn.stopAccepted)turn.phase='stop_requested';await persist(turn);
  }
  if(!turn.stopAccepted)fail('STOP_REJECTED','Claude did not accept the stop request.',{...publicTurn(turn),httpStatus:turn.stopHttpStatus});
  return reconcile(client,turn);
 });}
 return {send,status,stop};
}
export const {send:sendTurn,status:turnStatus,stop:stopTurn}=createTurnService();
