import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {appStartRequest,completionModeFromAppStart} from '../src/native-configuration.mjs';
const gate='claude_ai_clients_completions_use_bard';
test('completion endpoint follows selected organization with native boolean primitive parsing',()=>{
 assert.equal(completionModeFromAppStart({growthbook:{features:{[gate]:{defaultValue:true}}}}),false);
 assert.equal(completionModeFromAppStart({org_growthbook:{features:{[gate]:{defaultValue:true}}}}),true);
 for(const value of ['true','TRUE'])assert.equal(completionModeFromAppStart({org_growthbook:{features:{[gate]:{defaultValue:value}}}}),true);
 for(const value of ['false','1',1,null,undefined])assert.equal(completionModeFromAppStart({org_growthbook:{features:{[gate]:{defaultValue:value}}}}),false);
});
test('SHA256 feature lookup uses standard padded base64 and preserves hashed-key precedence',()=>{
 const key=createHash('sha256').update(gate).digest('base64');assert.ok(key.endsWith('='));
 assert.equal(completionModeFromAppStart({org_growthbook:{hashing_algorithm:'sha256',features:{[key]:{defaultValue:false},[gate]:{defaultValue:true}}}}),false);
 assert.equal(completionModeFromAppStart({org_growthbook:{hashing_algorithm:'sha256',features:{[key]:{defaultValue:true}}}}),true);
});
test('configuration request is a read-only source route bound to one organization',()=>{
 const id=randomUUID(),request=appStartRequest(id);assert.equal(request.method,'GET');
 assert.equal(new URL(request.url).pathname,`/api/bootstrap/${id}/app_start`);
 assert.equal(new URL(request.url).searchParams.get('include_system_prompts'),'false');
 assert.throws(()=>appStartRequest('../account'),{code:'INVALID_ARGUMENT'});
});
