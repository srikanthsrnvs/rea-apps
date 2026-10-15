import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'uber-book-test-'));
process.env.UBER_CLI_STATE_DIR=directory;
const {saveState,readState}=await import('../src/state.mjs');
const {createContext}=await import('../src/protocol.mjs');
const {prepareBooking,confirmBooking}=await import('../src/booking.mjs');
const nativeFetch=globalThis.fetch;const context=createContext();
const riderId=randomUUID(),paymentId=randomUUID(),profileId=randomUUID(),variantId=randomUUID();
test.after(async()=>{globalThis.fetch=nativeFetch;await fs.rm(directory,{recursive:true,force:true});});

test('booking preparation never dispatches; confirmation uses the approved signed fare and card',async()=>{
  await saveState('session',{context,accessToken:'test',userUUID:riderId,expiresAt:Date.now()+3600000});
  await saveState('integrity',{token:'test',contextDeviceId:context.deviceId,expiresAt:Date.now()+3600000});
  let expired=false;let bookings=0;let tripId;
  globalThis.fetch=async(url,options)=>{
    const endpoint=new URL(url).pathname;
    if(endpoint.endsWith('/status'))return Response.json({clientStatus:{status:'Looking'},fulfillmentStateData:{orders:[]}});
    if(endpoint.endsWith('/order_selection/'))return Response.json({response:{fullResponse:{shoppingOrders:[{id:'catalog',presentation:{displayName:'UberX'},eligibility:{availability:'AVAILABLE'},jobs:{singleTransport:{transportJob:{productContext:{legacy:{vehicleViewID:125},properties:{reservationOnly:false},presentation:{spritesheetMapIcon:{dayImageURL:'https://d1a3f4spazzrp4.cloudfront.net/car-types/haloMapIconsSpritesheet/v1/uberX_Spritesheet_v1.png'},spriteDivisionCount:64}}}}}}]}}});
    if(endpoint.endsWith('/fare-estimate'))return Response.json({packageVariants:[{vehicleViewId:125,isDefault:true,pricingInfo:{packageVariantUuid:variantId,fareInfo:{upfrontFare:{vehicleViewId:125,fare:'31.94',currencyCode:'USD',originLat:33,originLng:-118,destinationLat:34,destinationLng:-119,viaLocations:[],signature:{signature:'signed-test',expiresAt:Math.floor(Date.now()/1000)+180}}}}}]});
    if(endpoint.endsWith('/payment-profiles')) {
      assert.equal(options.method,'GET');
      return Response.json({paymentProfiles:[{uuid:paymentId,status:'active',isExpired:expired,displayable:{displayName:'Card ••••1234'}}]});
    }
    if(endpoint.endsWith('/get-profiles'))return Response.json({profiles:[{uuid:profileId,type:'Personal',status:'active',defaultPaymentProfileByProduct:{RIDER:paymentId}}]});
    assert.equal(endpoint,`/rt/riders/${riderId}/v2/pickup`);bookings++;
    const body=JSON.parse(options.body);assert.equal(body.paymentProfileUUID,paymentId);assert.equal(body.profileUUID,profileId);
    assert.equal(body.upfrontFare.signature.signature,'signed-test');assert.equal(body.upfrontFare.fare,'31.94');
    tripId=body.jobUUID;return Response.json({trip:{uuid:tripId}});
  };
  const first=await prepareBooking({from:'33,-118',to:'34,-119',product:'UberX'});
  assert.equal(bookings,0);assert.equal(first.preview.fare.amount,'31.94');assert.equal(first.preview.payment.id,paymentId);
  expired=true;await assert.rejects(confirmBooking(first.planId),/expired/);assert.equal(bookings,0);expired=false;
  const result=await confirmBooking(first.planId);assert.equal(result.tripId,tripId);assert.equal(result.requiresCheckout,false);assert.equal(bookings,1);assert.equal(result.map.artworkSaved,true);assert.equal(result.map.command,`uber map serve --trip-id ${tripId}`);const art=await readState(`map-artwork-${tripId}`);assert.equal(art.userUUID,riderId);assert.equal(art.spriteDivisionCount,64);
  const journal=await readState(`operation-${first.operationId}`);assert.equal(journal.state,'accepted');assert.equal(journal.context.jobId,tripId);
});
test('optional artwork persistence failure cannot make an accepted booking look rejected',async()=>{
  const prepared=await prepareBooking({from:'33,-118',to:'34,-119',product:'UberX'});
  const plan=await readState(`plan-${prepared.planId}`);
  const blocked=path.join(directory,`map-artwork-${plan.jobId}.json`);
  await fs.mkdir(blocked);
  const fixtureFetch=globalThis.fetch;let bookings=0;
  globalThis.fetch=async(...args)=>{if(new URL(args[0]).pathname.endsWith('/v2/pickup'))bookings++;return fixtureFetch(...args);};
  try{const result=await confirmBooking(prepared.planId);assert.equal(result.map.artworkSaved,false);assert.equal(result.tripId,plan.jobId);assert.equal(bookings,1);assert.equal((await readState(`operation-${prepared.operationId}`)).state,'accepted');}
  finally{globalThis.fetch=fixtureFetch;await fs.rm(blocked,{recursive:true});}
});
test('an expired approval plan cannot dispatch a ride',async()=>{
  const plan=await prepareBooking({from:'33,-118',to:'34,-119',product:'UberX'});
  const saved=await readState(`plan-${plan.planId}`);saved.expiresAt=1;await saveState(`plan-${plan.planId}`,saved);
  globalThis.fetch=async()=>{throw new Error('Expired plan must not make an API request');};
  await assert.rejects(confirmBooking(plan.planId),/expired/);
});
