import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {advancedToolManifest,toolManifest,orderingToolManifest} from '../src/tools.mjs';
const legacy=JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-tools.json',import.meta.url)));
const command=value=>value.split(/\s+\[?--/)[0].trim();
function schema(value){if(Array.isArray(value))return value.map(schema);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='description').map(([key,v])=>[key,schema(v)]));return value;}

test('all 30 original tools keep their commands, parameter contracts and optional arguments',()=>{
 assert.equal(legacy.tools.length,30);
 const all=new Map(advancedToolManifest.tools.map(tool=>[tool.name,tool]));
 for(const old of legacy.tools){
  const current=all.get(old.name);assert.ok(current,old.name+' removed');
  assert.equal(command(current.command),command(old.command),old.name+' command changed');
  for(const [name,definition]of Object.entries(old.inputSchema.properties))assert.deepEqual(schema(current.inputSchema.properties[name]),schema(definition),old.name+'.'+name+' changed');
  for(const required of current.inputSchema.required)assert.ok(old.inputSchema.required.includes(required),old.name+' requires an additional parameter');
 }
});
test('full tool inventory includes every recommended and ordering helper without duplicate names',()=>{
 assert.equal(advancedToolManifest.profile,'advanced');
 const all=new Set(advancedToolManifest.tools.map(tool=>tool.name));assert.equal(all.size,advancedToolManifest.tools.length);
 for(const profile of [toolManifest,orderingToolManifest]){
  assert.equal(new Set(profile.tools.map(tool=>tool.name)).size,profile.tools.length);
  for(const tool of profile.tools)assert.ok(all.has(tool.name),tool.name+' missing from full inventory');
 }
 assert.equal(toolManifest.advancedTools,'erewhon tools --advanced');
});

test('legacy trace replay can use retained CLI reads without expanding the model profile',async()=>{
 const {session}=await import('../eval/complex/session.mjs');
 const current=await session('delivery');assert.equal(current.tools.some(tool=>tool.name==='addresses'),false);
 await assert.rejects(current.call('addresses',{}),/Tool unavailable/);
 const legacyRun=await session('delivery',undefined,{includeLegacyTools:true});
 const result=await legacyRun.call('addresses',{});assert.equal(result.address[0].address_id,'saved-home');
 assert.equal(legacyRun.tools.some(tool=>tool.name==='order_confirm'),false);
 assert.equal(legacyRun.f.calls.some(call=>call.path==='/v1/place_order'),false);
});
