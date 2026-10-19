import {createHash} from 'node:crypto';
import {ClaudeError} from './errors.mjs';
const GATE='claude_ai_clients_completions_use_bard';
export function appStartRequest(organizationId){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId??''))throw new ClaudeError('INVALID_ARGUMENT','Organization ID must be a UUID.');
 return {url:`https://claude.ai/api/bootstrap/${organizationId}/app_start?growthbook_format=sdk&include_system_prompts=false`,method:'GET'};
}
export function completionModeFromAppStart(payload){
 // Native dependency injection supplies the current organization's GrowthBook.
 // It does not use the global bootstrap's feature value as a fallback.
 const growthbook=payload?.org_growthbook,features=growthbook?.features;
 const hashed=growthbook?.hashing_algorithm==='sha256'?features?.[createHash('sha256').update(GATE).digest('base64')]:undefined;
 const value=(hashed??features?.[GATE])?.defaultValue;
 return value===true||typeof value==='string'&&value.toLowerCase()==='true';
}
export async function completionMode(client,session,organizationId){
 const cached=session.organizationConfiguration?.[organizationId];
 if(cached&&Date.parse(cached.receivedAt)>Date.now()-5*60000)return cached.bard===true;
 const request=appStartRequest(organizationId),response=await client.request(request.url);
 if(response?.account?.uuid&&response.account.uuid!==session.account.uuid)throw new ClaudeError('ACCOUNT_MISMATCH','Claude returned configuration for a different account.');
 const bard=completionModeFromAppStart(response);
 (session.organizationConfiguration??={})[organizationId]={bard,receivedAt:new Date().toISOString()};return bard;
}
