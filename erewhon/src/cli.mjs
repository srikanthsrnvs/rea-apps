import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import * as auth from './auth.mjs';
import * as account from './account.mjs';
import * as catalog from './catalog.mjs';
import * as ordering from './ordering.mjs';
import { commerceData } from './output.mjs';
import { toolManifest } from './tools.mjs';

const print = value => console.log(JSON.stringify(value,null,2));
const options = Object.fromEntries([
  'phone','login-id','code','code-file','query','index','department','brand','category','sub-category','page','limit','day','id','store-id','address-id','type','lat','lon','date-key','trn-cpk','trn-pk','product-id','quantity','instruction','modifier-size-id','modifiers-file','request','cart-product-id','payment-method-id','schedule-type-id','time','date','shopper-tip-id','driver-tip-id','redeem-points','coupon-code','plan-id','operation-id',
].map(key=>[key,{type:'string'}]));
Object.assign(options,{help:{type:'boolean',short:'h'},raw:{type:'boolean'},replace:{type:'boolean'},confirm:{type:'boolean'},'order-method-key':{type:'string',multiple:true}});

function number(value,fallback) {
  if (value===undefined) return fallback;
  if (!value.trim()||!Number.isFinite(Number(value))) throw new Error('Supply a finite numeric argument.');
  return Number(value);
}
async function jsonFile(file) {
  if (!file) throw new Error('--request FILE is required.');
  const stat=await fs.stat(file);if(stat.size>200000)throw new Error('Request file is too large.');
  const text=await fs.readFile(file,'utf8');
  try{return JSON.parse(text);}catch{throw new Error('Request file must contain valid JSON.');}
}
async function codeInput(values) {
  if (values.code!==undefined&&values['code-file']!==undefined)throw new Error('Use --code or --code-file.');
  if (values.code!==undefined)return values.code.trim();
  if (values['code-file']){const file=await fs.open(values['code-file'],'r');try{const b=Buffer.alloc(128),{bytesRead}=await file.read(b);if(bytesRead===128)throw new Error('Code file is too large.');return b.subarray(0,bytesRead).toString().trim();}finally{await file.close();}}
  if(!process.stdin.isTTY)throw new Error('--code or --code-file is required outside an interactive terminal.');
  const prompt=createInterface({input:process.stdin,output:process.stderr});try{return(await prompt.question('Verification code: ')).trim();}finally{prompt.close();}
}

try {
  const {values:v,positionals}=parseArgs({allowPositionals:true,options});
  const command=positionals.join(' ')||'help';
  const checkoutOptions=()=>Object.fromEntries(Object.entries({paymentMethodId:v['payment-method-id'],scheduleTypeId:v['schedule-type-id'],time:v.time,scheduleDate:v.date,shopperTipId:v['shopper-tip-id'],driverTipId:v['driver-tip-id'],redeemPoints:number(v['redeem-points']),couponCode:v['coupon-code']}).filter(([,value])=>value!==undefined));
  let result;
  if(v.help||command==='help'){
    console.log(`Erewhon CLI — headless SMS login, account access, pickup and delivery.

erewhon tools
erewhon login --phone +15555550123
erewhon auth complete --login-id ID --code CODE
erewhon auth poll|cancel|validate --login-id ID
erewhon auth status|logout
erewhon profile|membership
erewhon rewards --type accrual|redemption --page 1
erewhon history --type online|instore [--page 1]
erewhon receipt --trn-cpk ID --trn-pk ID
erewhon stores [--lat LAT --lon LON]
erewhon addresses
erewhon address check --request FILE
erewhon address add --request FILE
erewhon fulfillment
erewhon fulfillment select --type pickup --store-id ID
erewhon fulfillment select --type delivery --address-id ID [--store-id ID]
erewhon categories [--department SLUG]
erewhon search --query TEXT [--index STORE_INDEX --page 0 --limit 20]
erewhon product --id ID
erewhon cart
erewhon cart add --product-id ID [--quantity 1 --modifier-size-id ID --modifiers-file FILE]
erewhon cart update --request FILE   JSON: {"items":[{"cartProductId":"ID","quantity":1}]}
erewhon cart remove --cart-product-id ID
erewhon checkout
erewhon order prepare [--payment-method-id ID --schedule-type-id ID --time SERVER_TIME --date MM-DD-YYYY]
erewhon order confirm --plan-id ID --confirm
erewhon order detail --id ID
erewhon order operation --operation-id ID

Checkout options: --shopper-tip-id ID, --driver-tip-id ID, --redeem-points AMOUNT, --coupon-code CODE.
Codes may come from --code-file FILE. --raw still strips credentials.
Only order confirm dispatches and pays. Show the full review and obtain approval first.`);
  } else if(command==='tools')print(toolManifest);
  else {
    if(v.confirm&&command!=='order confirm')throw new Error('--confirm is valid only with order confirm.');
    if(command==='login')result=v.phone?await auth.startLogin({phone:v.phone,replace:v.replace}):{status:'phone_required',next:'Run erewhon login --phone NUMBER to receive an SMS code.'};
    else if(command==='auth complete')result=await auth.completeLogin({loginId:v['login-id'],code:await codeInput(v)});
    else if(command==='auth poll')result=await auth.pollLogin({loginId:v['login-id']});
    else if(command==='auth cancel')result=await auth.cancelLogin({loginId:v['login-id']});
    else if(command==='auth validate')result=await auth.validateLogin({loginId:v['login-id']});
    else if(command==='auth status')result=await auth.authStatus();
    else if(command==='auth logout')result=await auth.logout();
    else if(command==='profile')result=await account.profile({raw:v.raw});
    else if(command==='membership')result=await account.membership({raw:v.raw});
    else if(command==='rewards')result=await account.rewards({type:v.type??'accrual',page:number(v.page,1),raw:v.raw});
    else if(command==='history'){
      const args={page:number(v.page,1),dateKey:v['date-key'],methodKeys:v['order-method-key'],raw:v.raw};
      if((v.type??'online')==='online')result=await ordering.orders(args);
      else if(v.type==='instore')result=await account.purchaseHistory(args);
      else throw new Error('History type must be online or instore.');
    } else if(command==='receipt')result=await account.receipt({trnCpk:v['trn-cpk'],trnPk:v['trn-pk'],raw:v.raw});
    else if(command==='stores')result=await catalog.stores({lat:number(v.lat),lon:number(v.lon)});
    else if(command==='addresses')result=await catalog.addresses();
    else if(command==='address check')result=await catalog.checkAddress(await jsonFile(v.request));
    else if(command==='address add')result=await catalog.addAddress(await jsonFile(v.request));
    else if(command==='fulfillment')result=await catalog.fulfillment();
    else if(command==='fulfillment select')result=await catalog.selectFulfillment({type:v.type,storeId:v['store-id'],addressId:v['address-id']});
    else if(command==='categories')result=await catalog.categories({department:v.department});
    else if(command==='search')result=await catalog.search({query:v.query??'',index:v.index,department:v.department,brand:v.brand,category:v.category,subCategory:v['sub-category'],page:number(v.page,0),limit:number(v.limit,20),day:number(v.day)});
    else if(command==='product')result=await catalog.product({productId:v.id});
    else if(command==='cart')result=await ordering.cart();
    else if(command==='cart add')result=await ordering.addCartItem({productId:v['product-id'],quantity:number(v.quantity,1),instruction:v.instruction,modifierSizeId:v['modifier-size-id'],...(v['modifiers-file']?{modifiers:await jsonFile(v['modifiers-file'])}:{})});
    else if(command==='cart update')result=await ordering.updateCartItems(await jsonFile(v.request));
    else if(command==='cart remove')result=await ordering.removeCartItem({cartProductId:v['cart-product-id']});
    else if(command==='checkout')result=await ordering.checkout(checkoutOptions());
    else if(command==='order prepare')result=await ordering.prepareOrder(checkoutOptions());
    else if(command==='order confirm'){
      if(!v.confirm)throw new Error('Review order prepare first; --confirm is required to place and pay for the order.');
      result=await ordering.confirmOrder({planId:v['plan-id']});
    } else if(command==='order detail')result=await ordering.order({orderId:v.id});
    else if(command==='order operation')result=await ordering.inspectOrderOperation({operationId:v['operation-id']});
    else throw new Error(`Unknown command: ${command}`);
    print(commerceData(result,{raw:v.raw}));
  }
}catch(error){console.error(JSON.stringify({error:{code:error.code??'CLI_ERROR',message:error.message,...(error.status?{status:error.status}:{}),...(error.operationId?{operationId:error.operationId}:{})}}));process.exitCode=1;}
