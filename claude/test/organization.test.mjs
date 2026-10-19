import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {organizationFor} from '../src/chats.mjs';
test('the only chat organization is selected even when the account lists an API organization first',()=>{
 const api=randomUUID(),chat=randomUUID(),session={account:{uuid:randomUUID(),memberships:[{organization:{uuid:api,capabilities:['api']}},{organization:{uuid:chat,capabilities:['claude_max','chat']}}]}};
 assert.equal(organizationFor(session),chat);
 assert.throws(()=>organizationFor(session,api),{code:'CHAT_ORGANIZATION_REQUIRED'});
});
test('multiple chat memberships require a verified explicit selection',()=>{
 const a=randomUUID(),b=randomUUID(),session={account:{uuid:randomUUID(),memberships:[{organization:{uuid:a,capabilities:['chat']}},{organization:{uuid:b,capabilities:['chat']}}]}};
 assert.throws(()=>organizationFor(session),{code:'ORGANIZATION_REQUIRED'});
 assert.equal(organizationFor(session,b),b);
 assert.throws(()=>organizationFor(session,randomUUID()),{code:'ORGANIZATION_NOT_FOUND'});
});
