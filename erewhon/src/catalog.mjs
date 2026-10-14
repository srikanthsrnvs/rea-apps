import * as disk from './state.mjs';
import { authenticatedOperation, ApiError } from './http.mjs';
import { endpoints, cartBinding, id, fail,publicData,fingerprint } from './ordering-protocol.mjs';
function containsID(value,wanted){if(Array.isArray(value))return value.some(v=>containsID(v,wanted));if(!value||typeof value!=='object')return false;if(['_id','id','address_id','store_id'].some(k=>value[k]===wanted))return true;return Object.values(value).some(v=>containsID(v,wanted));}
export function createCatalog({operation=authenticatedOperation,store=disk,fetchImpl=fetch,now=()=>new Date()}={}){
 async function loadCart({session,send}){let cart=await store.readState('cart');if(cart?.deviceId&&cart.deviceId!==session.deviceId)fail('CART_ACCOUNT_CHANGED','This cart belongs to a different device session.');if(cart?.owner&&cart.owner!==fingerprint({accountId:session.account?.id,deviceId:session.deviceId}))fail('CART_ACCOUNT_CHANGED','This cart belongs to a different account.');const form={device_id:session.deviceId};if(cart?.cartId||session.cartId)form.cart_id=cart?.cartId||session.cartId;if(cart?.cartTypeId)form.cart_type_id=cart.cartTypeId;const response=await send(endpoints.method,{form,readOnly:false});const cartId=response.cart_id||form.cart_id;const cartTypes=response.all_cart_types||cart?.cartTypes;const primary=Array.isArray(cartTypes)?cartTypes.find(t=>t.type==='primary'):null;if(!cartId||!primary?._id)fail('INVALID_RESPONSE','Erewhon did not return a primary cart identity.');cart={cartId,cartTypeId:primary._id,cartTypes,deviceId:session.deviceId,owner:fingerprint({accountId:session.account?.id,deviceId:session.deviceId}),store:response.store,orderType:response.order_type,address:response.address??null,index:response.store?.algolia?.search_index};await store.saveState('cart',cart);return cart;}
 async function fulfillment(){return operation(async context=>{const cart=await loadCart(context);return {cartId:cart.cartId,type:cart.orderType,store:cart.store,address:cart.address,index:cart.index};});}
 async function product({productId}={}){id(productId,'product ID');return operation(async context=>{const cart=await loadCart(context);return publicData(await context.send(endpoints.product,{form:{internal_product_id:productId,cart_id:cart.cartId},readOnly:true}));});}
 async function categories({department}={}){if(department!==undefined&&(!/^[a-z0-9-]+$/.test(department)))fail('INVALID_ARGUMENT','Supply a valid department slug.');return operation(async context=>{const cart=await loadCart(context);return publicData(await context.send(endpoints.departments,{form:{cart_id:cart.cartId,...(department&&department!=='all'?{slug:department}:{})},readOnly:true}));});}
 async function stores({lat,lon}={}){if((lat===undefined)!==(lon===undefined)||lat!==undefined&&(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon)||Math.abs(lon)>180))fail('INVALID_ARGUMENT','Supply valid latitude and longitude together.');return operation(async context=>{const cart=await loadCart(context);return publicData(await context.send(endpoints.stores,{form:{...cartBinding(cart),...(lat!==undefined?{latitude:lat,longitude:lon}:{})},readOnly:true}));});}
 async function addresses(){return operation(async context=>{const cart=await loadCart(context);return publicData(await context.send(endpoints.addresses,{form:cartBinding(cart),readOnly:true}));});}

 function addressFields(options) {
  const text = (value, label, max, required = true) => {
   if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value) || required && !value.trim()) fail('INVALID_ARGUMENT', `Supply a valid ${label}.`);
   return value.trim();
  };
  const address1 = text(options.address1, 'street address', 250);
  const city = text(options.city, 'city', 120);
  const state = text(options.state, 'state abbreviation', 2).toUpperCase();
  const zipcode = text(options.zipcode, 'US ZIP code', 10);
  if (!/^[A-Z]{2}$/.test(state) || !/^\d{5}(?:-\d{4})?$/.test(zipcode)) fail('INVALID_ARGUMENT', 'Supply a two-letter state and a five-digit or ZIP+4 code.');
  const latitude = options.latitude, longitude = options.longitude;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) fail('INVALID_ARGUMENT', 'Supply finite latitude and longitude for the delivery address.');
  return { address1, city, state, zipcode, latitude, longitude };
 }
 async function checkAddress(options = {}) {
  const fields = addressFields(options);
  return operation(async context => {
   const cart = await loadCart(context);
   const response = await context.send('/v1/check_address', { form: { ...cartBinding(cart), ...fields }, readOnly: true, allowErrors: true });
   return { status: response.error === 0 ? 'serviceable' : 'rejected', serviceable: response.error === 0, address: fields, details: publicData(response) };
  });
 }
 async function addAddress(options = {}) {
  const fields = addressFields(options);
  const { address2 = '', addressType, deliveryInstructions = '', dropMethod = 1, isDefault = false } = options;
  if (typeof address2 !== 'string' || address2.length > 250 || /[\r\n\0]/.test(address2) || typeof addressType !== 'string' || !addressType.trim() || addressType.length > 100 || /[\r\n\0]/.test(addressType) || typeof deliveryInstructions !== 'string' || deliveryInstructions.length > 2000 || deliveryInstructions.includes('\0') || !Number.isSafeInteger(dropMethod) || dropMethod < 1 || dropMethod > 100 || typeof isDefault !== 'boolean') fail('INVALID_ARGUMENT', 'Supply a valid address type, optional apartment/instructions, drop method, and explicit default preference.');
  const details = { ...fields, address2: address2.trim(), address_type: addressType.trim(), type: addressType.trim(), delivery_instructions: deliveryInstructions, drop_method: dropMethod, is_default: isDefault };
  return operation(async context => {
   let active = await store.readState('order-active');
   if (active && ['submitting', 'uncertain', 'additional_auth_required', 'pending'].includes(active.status)) {
    const recorded = await store.readState(`order-operation-${active.operationId}`);
    if (recorded && ['confirmed', 'rejected'].includes(recorded.status)) { active = recorded; await store.saveState('order-active', recorded); }
   }
   if (active && ['submitting', 'uncertain', 'additional_auth_required', 'pending'].includes(active.status)) fail('ORDER_UNRESOLVED', 'Resolve the previous order before changing delivery addresses.');
   const owner = fingerprint({ accountId: context.session.account?.id, deviceId: context.session.deviceId });
   const requestId = fingerprint({ owner, details });
   const journalName = `address-write-${requestId}`;
   const previous = await store.readState(journalName);
   if (previous?.status === 'confirmed') return { status: 'already_added', addressId: previous.addressId, address: publicData(previous.address), selectedForDelivery: false };
   if (previous && ['submitting', 'uncertain'].includes(previous.status)) fail('ADDRESS_OUTCOME_UNKNOWN', 'The previous address addition may have succeeded. List addresses and use the returned address ID; do not repeat the addition.');
   const cart = await loadCart(context);
   const check = await context.send('/v1/check_address', { form: { ...cartBinding(cart), ...fields }, readOnly: true, allowErrors: true });
   if (check.error !== 0) return { status: 'rejected', serviceable: false, details: publicData(check) };
   if (check.popup_data && Object.keys(check.popup_data).length) return { status: 'review_required', details: publicData(check) };
   const journal = { version: 1, requestId, owner, status: 'submitting', submittedAt: new Date(Number(now())).toISOString() };
   await store.saveState(journalName, journal);
   let response;
   try { response = await context.send('/v1/add_address', { form: { ...cartBinding(cart), ...details }, allowErrors: true }); }
   catch { journal.status = 'uncertain'; await store.saveState(journalName, journal); return { status: 'uncertain', requestId, message: 'The address addition outcome is unknown. List addresses before proceeding; do not repeat this addition.' }; }
   const nativeId = response.address?.address_id;
   const addressId = typeof nativeId === 'string' ? nativeId : Number.isSafeInteger(nativeId) ? String(nativeId) : null;
   if (response.error === 0 && addressId && /^[A-Za-z0-9_-]{1,200}$/.test(addressId)) {
    journal.status = 'confirmed'; journal.addressId = addressId; journal.address = response.address;
    await store.saveState(journalName, journal);
    return { status: 'added', addressId, address: publicData(response.address), selectedForDelivery: false, defaultPreferenceRequested: isDefault };
   }
   journal.status = response.error === 0 ? 'uncertain' : 'rejected';
   await store.saveState(journalName, journal);
   return { status: journal.status, requestId, details: publicData(response) };
  });
 }
 async function selectFulfillment({type,storeId,addressId}={}){if(!['pickup','delivery'].includes(type))fail('INVALID_ARGUMENT','Choose pickup or delivery.');if(type==='pickup'&&(!storeId||addressId)||type==='delivery'&&!addressId)fail('INVALID_ARGUMENT','Pickup needs a store ID; delivery needs an existing address ID.');if(storeId)id(storeId,'store ID');if(addressId)id(addressId,'address ID');return operation(async context=>{let journal=await store.readState('order-active');if(journal&&['submitting','uncertain','additional_auth_required','pending'].includes(journal.status)){const recorded=await store.readState(`order-operation-${journal.operationId}`);if(recorded&&['confirmed','rejected'].includes(recorded.status)){journal=recorded;await store.saveState('order-active',recorded);}}if(journal&&['submitting','uncertain','additional_auth_required','pending'].includes(journal.status))fail('ORDER_UNRESOLVED','Resolve the previous order outcome before changing fulfillment.');const cart=await loadCart(context);if(type==='pickup'){const listings=await context.send(endpoints.stores,{form:cartBinding(cart),readOnly:true});if(!containsID(listings,storeId))fail('INVALID_STORE','Choose a store returned by Erewhon.');await context.send(endpoints.defaultStore,{form:{...cartBinding(cart),store_id:storeId}});}else{const listing=await context.send(endpoints.addresses,{form:cartBinding(cart),readOnly:true});if(!containsID(listing.address,addressId))fail('INVALID_ADDRESS','Choose an address returned by your account.');const result=await context.send(`${endpoints.setAddress}/${addressId}`,{method:'PUT',form:{...cartBinding(cart),...(storeId?{store_id:storeId}:{set_default:1})},allowErrors:true});if(result.error===2)return {status:'store_selection_required',addressId,stores:result.stores};if(result.error!==0)fail('API_REJECTED','Erewhon rejected that delivery selection.');}await context.send(endpoints.selectMethod,{form:{...cartBinding(cart),order_method:type}});const current=await loadCart(context);if(current.orderType!==type||storeId&&current.store?._id!==storeId||type==='delivery'&&String(current.address?.address_id??current.address?.id??'')!==addressId)fail('FULFILLMENT_MISMATCH','The server did not retain the selected fulfillment.');return {status:'selected',type:current.orderType,cartId:current.cartId,store:current.store,address:current.address,index:current.index};});}
 async function search({query='',index,department,brand,category,subCategory,page=0,limit=20,day}={}){if(typeof query!=='string'||query.length>500||!Number.isInteger(page)||page<0||page>10000||!Number.isInteger(limit)||limit<1||limit>200)fail('INVALID_ARGUMENT','Supply a query, nonnegative page, and limit from 1 to 200.');const cart=await store.readState('cart');index??=cart?.index||'GROVE_SEARCH_INDEX';if(typeof index!=='string'||! /^[A-Z0-9_]+$/.test(index)||index.length>100)fail('INVALID_ARGUMENT','Supply a valid store search index.');if(day===undefined){const timezone=cart?.store?.time_zone||'America/Los_Angeles';try{const weekday=new Intl.DateTimeFormat('en-US',{timeZone:timezone,weekday:'short'}).format(now());day={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7}[weekday];}catch{fail('INVALID_TIMEZONE','The selected store timezone is not recognized.');}}if(!Number.isInteger(day)||day<1||day>7)fail('INVALID_ARGUMENT','Day must be an ISO weekday from 1 to 7.');const facets=[`DayOfWeek:${day}`];for(const[key,value]of Object.entries({Department:department,BrandName:brand,Category:category,SubCategory:subCategory}))if(value!==undefined){if(typeof value!=='string'||!value||value.length>150)fail('INVALID_ARGUMENT','Supply valid search facets.');facets.push(`${key}:${value}`);}let response;try{response=await fetchImpl(`https://y98rsjcjdh-dsn.algolia.net/1/indexes/${encodeURIComponent(index)}/query`,{method:'POST',headers:{'Content-Type':'application/json','X-Algolia-Application-Id':'Y98RSJCJDH','X-Algolia-API-Key':'107758089d485c894f7205d715457357'},body:JSON.stringify({query:query.trim(),page,hitsPerPage:limit,facets:['*'],facetFilters:facets,attributesToRetrieve:['*'],analytics:false}),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new ApiError('SEARCH_NETWORK_ERROR','The catalog request failed.');}if(!response.ok)throw new ApiError('SEARCH_REJECTED','The catalog rejected the request.',response.status);const data=await response.json();if(!Array.isArray(data.hits)||!Number.isInteger(data.nbPages))fail('INVALID_RESPONSE','The catalog response is not recognized.');return {query,index,page:data.page??page,limit,items:data.hits,facets:data.facets??{},total:data.nbHits,hasMore:(data.page??page)+1<data.nbPages,nextPage:(data.page??page)+1<data.nbPages?(data.page??page)+1:null};}
 return {loadCart,fulfillment,product,categories,stores,addresses,checkAddress,addAddress,selectFulfillment,search};
}
const catalog=createCatalog();export const {fulfillment,product,categories,stores,addresses,checkAddress,addAddress,selectFulfillment,search}=catalog;
