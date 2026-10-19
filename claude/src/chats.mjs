import {ClaudeError} from './errors.mjs';
import {withClient} from './auth.mjs';
import {accountRequest,parseAccountResponse,listChatsRequest,parseChatsPage,searchChatsRequest,parseSearchResults,openChatRequest,parseChatResponse} from './chat-read-protocol.mjs';

const fail=(code,message,details)=>{throw new ClaudeError(code,message,details);};
export function organizationFor(session,requested){
 const account=parseAccountResponse(session.account),organizations=account.organizations;
 const chatOrganizations=organizations.filter(org=>org.capabilities.includes('chat'));
 const selected=requested??session.organizationId??(chatOrganizations.length===1?chatOrganizations[0].id:organizations.length===1?organizations[0].id:null);
 if(!selected)fail('ORGANIZATION_REQUIRED','Select an organization before reading or sending chats.',{organizations});
 if(!organizations.some(organization=>organization.id===selected))fail('ORGANIZATION_NOT_FOUND','This organization is not in the saved account memberships.');
 const organization=organizations.find(org=>org.id===selected);
 if(organization.capabilities.length&&!organization.capabilities.includes('chat'))fail('CHAT_ORGANIZATION_REQUIRED','This organization does not have Claude chat access. Select a chat organization.',{organizations:chatOrganizations});
 return selected;
}
export async function readAccount(){return withClient(async(client,session)=>{
 const raw=await client.request(accountRequest().url);
 const account=parseAccountResponse(raw);
 if(account.id!==session.account.uuid)fail('ACCOUNT_MISMATCH','Claude returned a different account. Sign in again.');
 session.account=raw;session.validatedAt=new Date().toISOString();
 const eligible=account.organizations.filter(org=>org.capabilities.includes('chat'));
 return {...account,selectedOrganizationId:session.organizationId??(eligible.length===1?eligible[0].id:account.organizations.length===1?account.organizations[0].id:null)};
});}
export async function selectOrganization({organizationId}={}){return withClient(async(client,session)=>{
 const raw=await client.request(accountRequest().url),account=parseAccountResponse(raw);
 if(account.id!==session.account.uuid)fail('ACCOUNT_MISMATCH','Claude returned a different account.');
 if(!account.organizations.some(org=>org.id===organizationId))fail('ORGANIZATION_NOT_FOUND','Choose an organization from this account.');
 organizationFor({...session,account:raw},organizationId);
 session.account=raw;session.organizationId=organizationId;session.validatedAt=new Date().toISOString();
 return {selectedOrganizationId:organizationId,organization:account.organizations.find(org=>org.id===organizationId)};
});}
export async function listChats({organizationId,cursor,section,limit,all=false}={}){
 if(typeof all!=='boolean')fail('INVALID_ARGUMENT','--all must be a boolean.');
 return withClient(async(client,session)=>{
  const organization=organizationFor(session,organizationId),first=listChatsRequest(organization,{cursor,section,limit});
  const page=parseChatsPage(await client.request(first.url));
  if(!all)return {organizationId:organization,...page};
  const byId=new Map(page.chats.map(chat=>[chat.id,chat])),queue=[...page.pagination.continuations],visited=new Set();
  const degraded=new Set(page.degradedSurfaces),incomplete=new Set(page.incompleteSurfaces);let pages=1;
  while(queue.length){
   if(pages>=500)fail('HISTORY_LIMIT','History exceeds this command’s 500-page limit. Continue using the source section/cursor.',{pages,chatCount:byId.size,continuations:queue});
   const next=queue.shift(),key=JSON.stringify(next);
   if(visited.has(key))fail('PAGINATION_CYCLE','Claude repeated a history cursor. The history is not known to be complete.',{pages,chatCount:byId.size});
   visited.add(key);
   const request=listChatsRequest(organization,{...next,limit:limit??100}),more=parseChatsPage(await client.request(request.url));pages++;
   for(const chat of more.chats){const previous=byId.get(chat.id);byId.set(chat.id,previous?{...chat,starred:previous.starred||chat.starred}:chat);}
   queue.push(...more.pagination.continuations);
   for(const value of more.degradedSurfaces)degraded.add(value);
   for(const value of more.incompleteSurfaces)incomplete.add(value);
  }
  return {organizationId:organization,chats:[...byId.values()],pages,pagination:{continuations:[],hasMore:false},degradedSurfaces:[...degraded],incompleteSurfaces:[...incomplete],complete:!degraded.size&&!incomplete.size};
 });
}
export async function searchChats({organizationId,query}={}){return withClient(async(client,session)=>{
 const organization=organizationFor(session,organizationId),request=searchChatsRequest(organization,query);
 return {organizationId:organization,query,...parseSearchResults(await client.request(request.url))};
});}
export async function readChatWithClient(client,organizationId,chatId){
 const request=openChatRequest(organizationId,chatId,{returnDanglingHumanMessage:true});
 return parseChatResponse(await client.request(request.url),{expectedChatId:chatId});
}
export async function openChat({organizationId,chatId}={}){return withClient(async(client,session)=>{
 const organization=organizationFor(session,organizationId);
 return {organizationId:organization,...await readChatWithClient(client,organization,chatId)};
});}
