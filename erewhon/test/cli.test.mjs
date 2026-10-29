import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {commerceData} from '../src/output.mjs';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'erewhon-cli-'));
const run=(...args)=>spawnSync(process.execPath,[new URL('../bin/erewhon',import.meta.url).pathname,...args],{encoding:'utf8',env:{...process.env,EREWHON_CLI_STATE_DIR:directory}});
test.after(()=>fs.rm(directory,{recursive:true,force:true}));
test('CLI exposes authenticated account, catalog, both fulfillment modes and reviewed ordering tools',()=>{
 const result=run('tools');assert.equal(result.status,0);const tools=JSON.parse(run('tools','--advanced').stdout).tools;assert.ok(!JSON.parse(result.stdout).tools.some(t=>t.name==='cart_add'));assert.equal(JSON.parse(run('tools','--profile','ordering').stdout).tools.length,6);
 for(const name of ['auth_login','auth_complete','membership','rewards','history','receipt','search','fulfillment_select','cart_add','order_prepare','order_confirm','order_operation','product_find','product_options','recipe_save','recipe_show','recipe_reset','order_status'])assert.ok(tools.some(t=>t.name===name));
 assert.match(run('help').stdout,/pickup and delivery/);assert.equal(JSON.parse(run('login').stdout).status,'phone_required');
});
test('CLI rejects dispatch without explicit confirmation and malformed arguments before network access',()=>{
 for(const args of [['order','confirm','--plan-id','synthetic'],['checkout','--confirm'],['login','--phone','invalid'],['search','--page','oops'],['unknown'],['profile','--unknown']]){
  const result=run(...args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.ok(JSON.parse(result.stderr).error.message);assert.ok(!result.stderr.includes('at Module'));
 }
});
test('checkout outputs retain selectable payment IDs and delivery terms without credentials or billing records',()=>{
 const value={payment_methods:[{id:'synthetic-card-id',card:{brand:'visa',last4:'4242'},billing_details:{secret:'private'}}],user:{token:'secret',date_of_birth:'private'},delivery_details:{address:'Example Ave'},client_secret:'secret',nested:{forterToken:'secret'}};
 const result=commerceData(value);assert.equal(result.payment_methods[0].id,'synthetic-card-id');assert.equal(result.delivery_details.address,'Example Ave');assert.ok(!JSON.stringify(result).includes('secret'));assert.equal(result.user,undefined);
 const raw=commerceData(value,{raw:true});assert.equal(raw.user.date_of_birth,'private');assert.equal(raw.user.token,undefined);
});
test('invalid request JSON does not copy private file content into CLI errors',async()=>{
 const file=path.join(directory,'invalid.json');await fs.writeFile(file,'{"secret":"private-value" broken');
 const result=run('cart','update','--request',file);
 assert.equal(result.status,1);assert.match(result.stderr,/valid JSON/);assert.ok(!result.stderr.includes('private-value'));
});

test('ordering rejects ignored quantity flags and conflicting recipe inputs before any request',()=>{
 for(const args of [['order','prepare','--recipe','usual-coffee','--quantity','4'],['order','prepare','--recipe','usual-coffee','--json','{}'],['recipe','save','--name','coffee','--request','missing.json','--json','{}'],['order','confirm','--plan-id','id','--quantity','4','--confirm']]){
  const result=run(...args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/not valid|not both/);
 }
});

test('batch discovery rejects conflicting sources, malformed input and unsupported fields before authentication',()=>{
 for(const args of [
  ['product','find','--query','Cappuccino','--json','{"queries":["Cappuccino"]}'],
  ['product','find','--json','{"queries":[]}'],
  ['product','find','--json','{"queries":["Cappuccino"],"quantity":4}']
 ]){const result=run(...args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/AUTH_REQUIRED/);}
 const manifest=JSON.parse(run('tools','--profile','ordering').stdout);
 const schema=manifest.tools.find(t=>t.name==='product_find').inputSchema;
 assert.deepEqual(schema.required,['queries']);assert.equal(schema.properties.includeAddresses.type,'boolean');
});
