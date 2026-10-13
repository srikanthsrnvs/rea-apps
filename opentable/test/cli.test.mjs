import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const entry=new URL('../bin/opentable',import.meta.url);
function run(args,dir){return spawnSync(process.execPath,[entry.pathname,...args],{encoding:'utf8',timeout:3000,env:{...process.env,OPENTABLE_CLI_STATE_DIR:dir,HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1'}});}
test('offline model catalog declares OTP and reviewed transaction branches',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'opentable-cli-'));
 try{
 const result=run(['tools'],dir);assert.equal(result.status,0,result.stderr);
 const catalog=JSON.parse(result.stdout).tools;
 for(const command of ['login','auth complete','search','availability','reservations','book','cancel','operation'])assert.ok(catalog.some(t=>t.command===command));
 assert.equal(catalog.find(t=>t.command==='login').inputSchema.oneOf.length,2);
 for(const name of ['book','cancel'])assert.equal(catalog.find(t=>t.command===name).inputSchema.oneOf[1].properties.confirm.const,true);
 assert.deepEqual(await fs.readdir(dir),[]);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('malformed agent inputs fail before state or network side effects',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'opentable-cli-'));
 try{
 for(const args of [
 ['search','--query','food','--near','91,0','--date-time','2026-10-13T19:00'],
 ['availability','--restaurant-id','1','--date-time','2026-02-30T12:00'],
 ['search','--query','food','--near','0,0','--date-time','2026-10-13T19:00','--party-size','21'],
 ['book','--restaurant-id','1','--slot-id','fake','--confirm'],
 ['book','--plan-id','11111111-1111-4111-8111-111111111111'],
 ['cancel','--reservation-id','11111111-1111-4111-8111-111111111111','--confirm'],
 ['cancel','--reservation-id','11111111-1111-4111-8111-111111111111','--accept-unknown-fee'],
 ['login','--phone','2125550123','--email','a@example.test'],
 ['auth','complete','--code','123456','--code','456789'],
 ['me','--restaurant-id','1'],
 ]){const result=run(args,dir);assert.equal(result.status,1,JSON.stringify(args));assert.equal(JSON.parse(result.stderr).error.code,'INVALID_ARGUMENT');assert.equal(result.stdout,'');}
 assert.deepEqual(await fs.readdir(dir),[]);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
