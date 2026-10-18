import { randomUUID } from 'node:crypto';
import { AmazonError } from './errors.mjs';
import { withClient } from './auth.mjs';
import { accountKey } from './orders.mjs';
import { readState, saveState, removeState } from './state.mjs';
import { readRetailPage, desktopHeaders } from './retail.mjs';
import { parseProductHTML } from './shopping-protocol.mjs';
import { parseCartPage, parseCheckoutPage, primeDeclineURL, fingerprint, addToCartSubmission, removeFromCartSubmission, parsePurchaseResult, cancellationForm, parseCancellationResult } from './commerce-protocol.mjs';
import { parseOrderDetailsPage } from './orders-protocol.mjs';
import { buildFormSubmission } from './form-protocol.mjs';

const CART = 'https://www.amazon.com/gp/aw/c?ref_=navm_hdr_cart';
const fail = (code,message,details) => { throw new AmazonError(code,message,details); };
const validId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id ?? '');
async function cartPage(client) {
  const page = await readRetailPage(client,CART,{desktop:true});
  return parseCartPage(page.html,{url:page.url});
}
async function savePlan(session, kind, data) {
  const id = randomUUID(), expiresAt = new Date(Date.now()+5*60000).toISOString();
  await saveState(`commerce-${id}`,{id,owner:accountKey(session),kind,status:'ready',expiresAt,...data});
  return {planId:id,expiresAt};
}
async function getPlan(session,id) {
  if (!validId(id)) fail('INVALID_ARGUMENT','Use the planId returned by a prepare command.');
  const plan = await readState(`commerce-${id}`);
  if (!plan || plan.owner!==accountKey(session)) fail('PLAN_NOT_FOUND','This plan does not belong to the current account.');
  if(['confirmed','applied','cancellation_requested'].includes(plan.status)){
    const pending=await readState('commerce-pending');
    if(pending?.planId===id&&pending.owner===plan.owner)await removeState('commerce-pending');
  }
  return plan;
}
async function requireReady(plan) {
  if (plan.status!=='ready') return false;
  if (Date.parse(plan.expiresAt)<=Date.now()) fail('PLAN_EXPIRED','Prepare this action again.');
  const pending = await readState('commerce-pending');
  if (pending) fail('COMMERCE_OUTCOME_UNKNOWN','An earlier submission has an unresolved outcome. Inspect operation status and account history before further changes.',{planId:pending.planId});
  return true;
}
const publicOperation = plan => ({planId:plan.id,kind:plan.kind,status:plan.status,...(plan.result?{result:plan.result}:{})});

export async function showCart() {
  return withClient(async(client,session)=>{
    const cart = await cartPage(client), reference=await savePlan(session,'cart_snapshot',{cart:cart.summary,cartFingerprint:cart.fingerprint});
    return {...cart.summary,cartRef:reference.planId,expiresAt:reference.expiresAt};
  },{authenticated:true});
}
export async function prepareAdd({asin}={}) {
  if (!/^[A-Z0-9]{10}$/.test(asin??'')) fail('INVALID_ARGUMENT','Provide a ten-character ASIN.');
  return withClient(async(client,session)=>{
    const before=await cartPage(client), page=await readRetailPage(client,`https://www.amazon.com/dp/${asin}`);
    const product=parseProductHTML(page.html,{url:page.url});
    addToCartSubmission(page.html,{url:page.url,asin});
    const reference=await savePlan(session,'cart_add',{asin,cartFingerprint:before.fingerprint,productFingerprint:fingerprint(product),product});
    return {...reference,action:'add_to_cart',quantity:1,product};
  },{authenticated:true});
}
export async function prepareRemove({cartRef,itemRef}={}) {
  return withClient(async(client,session)=>{
    const snapshot=await getPlan(session,cartRef);
    if(snapshot.kind!=='cart_snapshot'||Date.parse(snapshot.expiresAt)<=Date.now())fail('PLAN_EXPIRED','Read cart again.');
    const item=snapshot.cart.items.find(i=>i.itemRef===itemRef);
    if(!item)fail('INVALID_ARGUMENT','Use an itemRef from this cart.');
    const reference=await savePlan(session,'cart_remove',{item,cartFingerprint:snapshot.cartFingerprint});
    return {...reference,action:'remove_from_cart',item};
  },{authenticated:true});
}
async function reviewCheckout(client,cart) {
  if(!cart.checkout || cart.checkout.method!=='GET' || !cart.summary.items.some(item=>item.selected))fail('CHECKOUT_NOT_READY','The cart has no supported checkout action or selected items.');
  let page=await readRetailPage(client,cart.checkout.url,{desktop:true});
  const decline=primeDeclineURL(page.html,{url:page.url});
  // Follow only the exact source "No thanks" link. Never enroll in Prime.
  if(decline)page=await readRetailPage(client,decline,{desktop:true});
  const checkout=parseCheckoutPage(page.html,{url:page.url});
  const key=item=>JSON.stringify({asin:item.asin,title:item.title,quantity:item.quantity,price:item.unitPrice?.amount,currency:item.unitPrice?.currency});
  const selected=cart.summary.items.filter(item=>item.selected).map(key).sort();
  if(JSON.stringify(selected)!==JSON.stringify(checkout.review.items.map(key).sort()))fail('CHECKOUT_ITEMS_CHANGED','Checkout items differ from the selected cart items. Read the cart again.');
  return checkout;
}
export async function prepareCheckout() {
  return withClient(async(client,session)=>{
    const cart=await cartPage(client),checkout=await reviewCheckout(client,cart);
    const reference=await savePlan(session,'purchase',{cartFingerprint:cart.fingerprint,review:checkout.review,reviewFingerprint:checkout.fingerprint});
    return {...reference,status:'review_required',review:checkout.review,confirmationRequired:'Obtain user approval of these exact items, total, address and payment before checkout place.'};
  },{authenticated:true});
}
async function submitOnce(client,plan,submission) {
  if(submission.method!=='POST')fail('INVALID_SUBMISSION','Only a recognized source POST form may change an account.');
  plan.status='submission_pending';
  await saveState(`commerce-${plan.id}`,plan);
  await saveState('commerce-pending',{planId:plan.id,owner:plan.owner});
  // No retry: a timeout, crash or unparsable response can follow a committed action.
  const response=await client.request(submission.url,{method:'POST',form:submission.form,responseType:'response',headers:{...desktopHeaders,origin:'https://www.amazon.com',referer:submission.url}});
  plan.response={...response,headers:Object.fromEntries(response.headers)};
  plan.status='response_received';
  await saveState(`commerce-${plan.id}`,plan);
  return response;
}
async function finish(plan,result) {
  plan.result=result;plan.status=result.status;
  await saveState(`commerce-${plan.id}`,plan);
  if(['confirmed','applied','cancellation_requested'].includes(plan.status))await removeState('commerce-pending');
  return publicOperation(plan);
}
export async function applyCart({planId}={}) {
  return withClient(async(client,session)=>{
    const plan=await getPlan(session,planId);
    if(!['cart_add','cart_remove'].includes(plan.kind))fail('WRONG_PLAN','Use a cart preparation plan.');
    if(!await requireReady(plan))return publicOperation(plan);
    const before=await cartPage(client);
    if(before.fingerprint!==plan.cartFingerprint)fail('CART_CHANGED','The cart changed. Prepare the action again.');
    let submission;
    if(plan.kind==='cart_add'){
      const page=await readRetailPage(client,`https://www.amazon.com/dp/${plan.asin}`);
      if(fingerprint(parseProductHTML(page.html,{url:page.url}))!==plan.productFingerprint)fail('PRODUCT_CHANGED','Product details changed. Prepare Add to Cart again.');
      submission=addToCartSubmission(page.html,{url:page.url,asin:plan.asin});
    }else submission=removeFromCartSubmission(before,plan.item.itemRef);
    await submitOnce(client,plan,submission);
    const after=await cartPage(client);
    const unchanged=before.summary.items.filter(item=>plan.kind==='cart_remove'?item.itemRef!==plan.item.itemRef:item.asin!==plan.asin);
    const remaining=after.summary.items.filter(item=>plan.kind==='cart_remove'?item.itemRef!==plan.item.itemRef:item.asin!==plan.asin);
    const sameOtherItems=fingerprint(unchanged)===fingerprint(remaining);
    const quantity=(cart,asin)=>cart.summary.items.filter(i=>i.asin===asin).reduce((n,i)=>n+i.quantity,0);
    const expected=plan.kind==='cart_remove'?!after.summary.items.some(i=>i.itemRef===plan.item.itemRef):quantity(after,plan.asin)===quantity(before,plan.asin)+1;
    return finish(plan,{status:sameOtherItems&&expected?'applied':'outcome_unknown',cart:after.summary});
  },{authenticated:true});
}
export async function placeOrder({planId,confirmTotal,currency}={}) {
  if(typeof confirmTotal!=='string'||!/^\d+\.\d{2}$/.test(confirmTotal)||currency!=='USD')fail('INVALID_ARGUMENT','Provide the exact approved --confirm-total with two decimals and --currency USD.');
  return withClient(async(client,session)=>{
    const plan=await getPlan(session,planId);
    if(plan.kind!=='purchase')fail('WRONG_PLAN','Use a checkout prepare plan.');
    if(!await requireReady(plan))return publicOperation(plan);
    if(Number(confirmTotal)!==plan.review.total.amount||currency!==plan.review.total.currency)fail('TOTAL_NOT_CONFIRMED','The approved total does not match this review.');
    const cart=await cartPage(client);
    if(cart.fingerprint!==plan.cartFingerprint)fail('CART_CHANGED','The cart changed. Prepare checkout again.');
    const fresh=await reviewCheckout(client,cart);
    if(fresh.fingerprint!==plan.reviewFingerprint)fail('CHECKOUT_CHANGED','Items, prices, address, payment or delivery changed. Prepare checkout and obtain fresh approval.');
    const response=await submitOnce(client,plan,fresh.submission);
    let html=response.text;
    if(response.status>=300&&response.status<400&&response.headers.get('location'))html=(await readRetailPage(client,new URL(response.headers.get('location'),fresh.submission.url).href,{desktop:true})).html;
    return finish(plan,response.status>=400?{status:'outcome_unknown'}:parsePurchaseResult(html));
  },{authenticated:true});
}
export async function operationStatus({planId}={}) {
  return withClient(async(_client,session)=>publicOperation(await getPlan(session,planId)),{authenticated:true});
}
export async function prepareCancellation({orderRef}={}){
  if(!validId(orderRef))fail('INVALID_ARGUMENT','Use an orderRef returned by orders list.');
  return withClient(async(client,session)=>{
    const saved=await readState(`order-${orderRef}`);
    if(!saved||saved.owner!==accountKey(session)||Date.parse(saved.expiresAt)<=Date.now())fail('ORDER_REFERENCE_EXPIRED','Read orders list again.');
    let page=await readRetailPage(client,saved.order.actions.details);
    let details=parseOrderDetailsPage(page.html,{url:page.url,orderId:saved.order.orderId});
    if(details.source==='mobile_product_owner_page'&&details.actions?.details&&details.actions.details!==page.url){
      page=await readRetailPage(client,details.actions.details);
      details=parseOrderDetailsPage(page.html,{url:page.url,orderId:saved.order.orderId});
    }
    if(details.cancellation.available===false||!details.actions?.cancel)return {status:'unavailable',orderId:saved.order.orderId,reason:details.cancellation.reason,order:details};
    page=await readRetailPage(client,details.actions.cancel,{desktop:true});
    const source=cancellationForm(page.html,{url:page.url,orderId:saved.order.orderId});
    const reference=await savePlan(session,'cancellation',{orderId:saved.order.orderId,order:details,cancelURL:page.url,choices:source.choices});
    return {...reference,status:'review_required',order:details,choices:source.choices,confirmationRequired:'Obtain approval of the exact order and selected items before orders cancel.'};
  },{authenticated:true});
}
export async function cancelOrder({planId,confirm=false,values={}}={}){
  if(!confirm)fail('CONFIRMATION_REQUIRED','Review the cancellation and provide --confirm only after user approval.');
  if(!values||typeof values!=='object'||Array.isArray(values))fail('INVALID_ARGUMENT','Cancellation values must be a JSON object of source form choices.');
  return withClient(async(client,session)=>{
    const plan=await getPlan(session,planId);
    if(plan.kind!=='cancellation')fail('WRONG_PLAN','Use an orders cancel prepare plan.');
    if(!await requireReady(plan))return publicOperation(plan);
    const page=await readRetailPage(client,plan.cancelURL,{desktop:true});
    const source=cancellationForm(page.html,{url:page.url,orderId:plan.orderId});
    // Exclude rotating hidden CSRF values while retaining the visible choices.
    if(fingerprint(source.choices)!==fingerprint(plan.choices))fail('CANCELLATION_CHANGED','Cancellation choices changed. Prepare it again.');
    const submission=buildFormSubmission(source.form,{values,submitter:source.submitter});
    if(submission.url!==source.form.url||submission.method!=='POST')fail('INVALID_SUBMISSION','The cancellation button overrides its recognized action.');
    let response=await submitOnce(client,plan,submission), html=response.text;
    if(response.status>=300&&response.status<400&&response.headers.get('location'))html=(await readRetailPage(client,new URL(response.headers.get('location'),submission.url).href,{desktop:true})).html;
    return finish(plan,response.status>=400?{status:'outcome_unknown'}:parseCancellationResult(html,{orderId:plan.orderId}));
  },{authenticated:true});
}
