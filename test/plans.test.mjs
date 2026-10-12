import test from 'node:test';
import assert from 'node:assert/strict';
import {savePlan,loadPlan} from '../src/plans.mjs';
test('approval plans are bound to a rider, kind and expiry',async()=>{
  const session={userUUID:'rider'};const records=new Map();
  const plan=await savePlan('booking',session,{preview:{price:'12.34'}},{write:async(k,v)=>records.set(k,v)});
  const opts={read:async k=>records.get(k),now:plan.createdAt};
  assert.equal((await loadPlan(plan.id,'booking',session,opts)).preview.price,'12.34');
  await assert.rejects(loadPlan('../escape','booking',session,opts),/UUID/);
  await assert.rejects(loadPlan(plan.id,'cancellation',session,opts),/No cancellation/);
  await assert.rejects(loadPlan(plan.id,'booking',{userUUID:'other'},opts),/another/);
  await assert.rejects(loadPlan(plan.id,'booking',session,{...opts,now:plan.expiresAt}),/expired/);
});
