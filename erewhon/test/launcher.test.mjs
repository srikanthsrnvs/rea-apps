import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('installed launcher resolves absolute and relative symlinks to the app runtime',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'erewhon-launcher-'));
 try{
  const absolute=path.join(directory,'erewhon');const relative=path.join(directory,'relative');
  await fs.symlink(fileURLToPath(new URL('../bin/erewhon-linux',import.meta.url)),absolute);
  await fs.symlink('erewhon',relative);
  for(const executable of [absolute,relative]){
   const result=spawnSync(executable,['tools'],{encoding:'utf8',env:{...process.env,EREWHON_NODE:process.execPath}});
   assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).name,'erewhon');
  }
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
