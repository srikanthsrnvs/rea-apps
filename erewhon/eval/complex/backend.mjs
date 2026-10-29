import { createRecipes } from '../../src/recipes.mjs';
import { createOrdering } from '../../src/ordering.mjs';
import { createCatalog } from '../../src/catalog.mjs';
const clone = v => structuredClone(v);
const group = (name, options, required=false, maximum=4) => ({name, required, minimum:required?1:0, maximum, type:maximum===1?'radio':'checkbox', modifiers:options.map(([name,price=0,maximum=1])=>({name,price,maximum}))});
const milk=()=>group('Milk',[['Whole Milk'],['Oat Milk',1],['Almond Milk',1]],true,1);
const extras=()=>group('Extras',[['Espresso Shot',2,3],['Vanilla Syrup',0.75],['Cinnamon',0]],false,5);
const temperature=()=>group('Temperature',[['Extra Hot'],['Iced']],false,1);
export const catalogData=[
 {name:'Cappuccino',sku:'CAP',brand:'Erewhon',sizes:[['Small 8 oz',5],['Large 16 oz',7]],groups:[milk(),extras(),temperature()]},
 {name:'Matcha Latte',sku:'MAT',brand:'Erewhon',sizes:[['Small 8 oz',7],['Large 16 oz',9]],groups:[milk(),group('Sweetness',[['Unsweetened'],['Light Sweetener'],['Regular Sweetener']],true,1),temperature()]},
 {name:'Breakfast Burrito',sku:'BUR',brand:'Erewhon',price:12,groups:[group('Salsa',[['Mild'],['Hot'],['No Salsa']],true,1),group('Add-ons',[['Avocado',3],['Extra Egg',2]],false,2)]},
 {name:'Spring Water',sku:'WAT',brand:'Mountain',price:3,groups:[]},
 {name:'Spring Water',sku:'WAT2',brand:'Alpine',price:4,groups:[]},
];
export function backend() {
 const f={rows:[],calls:[],records:new Map(),rotation:'initial',type:'pickup',storeName:'Venice',dropAt:0,addCount:0,retired:false,forceAmbiguous:false,reverseRows:false};
 const session={token:'fixture-only',deviceId:'eval-device',account:{id:'eval-user'}};
 const store={readState:async key=>clone(f.records.get(key)??null),saveState:async(key,val)=>f.records.set(key,clone(val))};
 let queue=Promise.resolve();const enqueue=fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};store.withStateLock=enqueue;
 const storeData=()=>({_id:f.storeName.toLowerCase(),name:f.storeName,time_zone:'America/Los_Angeles',algolia:{search_index:`${f.storeName.toUpperCase()}_SEARCH_INDEX`}});
 const address={address_id:'saved-home',address1:'100 Test Avenue',city:'Los Angeles',state:'CA',zipcode:'90001'};
 const products=()=>catalogData.map(c=>{const base={name:c.name,sku:c.sku,price:c.price,brands:{name:c.brand},_id:`native-${c.sku}-${f.rotation}`,internal_product_id:`ref-${c.sku}-${f.rotation}`};
   const groups=(size='')=>({modifier_sets:c.groups.map((g,i)=>({...clone(g),_id:`group-${c.sku}-${size}-${i}-${f.rotation}`,modifiers:g.modifiers.filter(m=>!(f.retired&&m.name==='Oat Milk')).map((m,j)=>({...m,...(f.generousLimits&&m.name==='Vanilla Syrup'?{maximum:3}:{}),_id:`mod-${c.sku}-${size}-${i}-${j}-${f.rotation}`}))}))});
   return {...base,...(c.sizes?{modifier_size:c.sizes.map(([name,price],i)=>({_id:`size-${c.sku}-${i}-${f.rotation}`,name,price,modifier_groups:groups(i)}))}:{modifier_groups:groups()})};});
 async function send(path,opts={}) {
  f.calls.push({path,...clone(opts)});
  if(path==='/v1/place_order')throw new Error('PURCHASE ENDPOINT DISABLED IN THIS EVALUATION');
  if(path==='/v1/ordermethod')return {error:0,cart_id:'eval-cart',all_cart_types:[{_id:'primary',type:'primary'}],store:storeData(),order_type:f.type,address:f.type==='delivery'?address:null};
  if(path==='/v1/usercart')return {error:0,cart:{allow_checkout:true,all_product_available:true,departments:[{products:clone(f.reverseRows?[...f.rows].reverse():f.rows)}]}};
  if(path==='/v1/stores')return {error:0,stores:['Venice','Grove'].map(name=>({_id:name.toLowerCase(),name}))};
  if(path==='/v1/default_stores'){f.storeName=opts.form.store_id==='grove'?'Grove':'Venice';return {error:0};}
  if(path==='/v1/alladdress')return {error:0,address:[address]};
  if(path.startsWith('/v1/set_address/'))return {error:0};
  if(path==='/v1/select_ordermethod'){f.type=opts.form.order_method;return {error:0};}
  if(path==='/v1/validate_cart')return {error:0};
  if(path==='/v1/getproduct')return {error:0,product:products().find(p=>p.internal_product_id===opts.form.internal_product_id)};
  if(path.startsWith('/v1/addtocart/')) {
   const p=products().find(p=>`/v1/addtocart/${p._id}`===path);if(!p)throw new Error('Stale native identity');
   const form=opts.form,selected=form.modifier_sets?JSON.parse(form.modifier_sets):[];
   const size=p.modifier_size?.find(s=>s._id===form.modifier_size_id);
   const price=(size?.price??p.price)+selected.flatMap(g=>g.modifiers).reduce((n,m)=>n+(m.is_selected?m.price*m.count:0),0);
   f.addCount++;
   f.rows.push({_id:p._id,cart_product_id:`row-${f.addCount}`,product:p,quantity:form.product_quantity,modifier_size_id:form.modifier_size_id??null,selected_modifiers:selected,product_instruction:form.product_instruction,product_price:(price*form.product_quantity).toFixed(2)});
   if(f.dropAt===f.addCount)throw new Error('Lost addition response; cart may already contain this item.');
   return {error:0};
  }
  if(path==='/v1/checkout_details'){
   const subtotal=f.rows.reduce((n,r)=>n+Number(r.product_price),0),tax=Math.round(subtotal*9.5)/100,delivery=f.type==='delivery'?5:0;
   return {error:0,allow_checkout:true,order_type:f.type,payment_process_type:'erewhon',cart_amount_dtls:{subtotal:subtotal.toFixed(2),tax:tax.toFixed(2),delivery_fee:delivery.toFixed(2),order_total:(subtotal+tax+delivery).toFixed(2)},schedule_types:[{_id:'asap',type:'schedule_asap',is_selected:true,order_time:{time:'ASAP',is_default:true}}],default_payment_method:{id:'fixture-card',brand:'mastercard',last4:'1234'},is_redeem_points:false};
  }
  throw new Error(`Unexpected endpoint ${path}`);
 }
 const operation=fn=>enqueue(()=>fn({session,send}));
 const fetchImpl=async (_url,opts)=>{const {query,page,hitsPerPage}=JSON.parse(opts.body);let hits=products().filter(p=>query.toLowerCase().split(/\s+/).filter(Boolean).every(token=>`${p.brands.name} ${p.name}`.toLowerCase().includes(token.replace(/s$/,'')))).map(p=>({ProductName:p.name,BrandName:p.brands.name,SKU:p.sku,ECRSID:p.internal_product_id,DisplayPrice:p.price,has_modifier:Boolean(p.modifier_size?.length||p.modifier_groups?.modifier_sets.length)}));
 if(f.forceAmbiguous)hits=hits.flatMap(h=>[h,{...h,ECRSID:`duplicate-${h.ECRSID}`}]);
 return {ok:true,json:async()=>({page,nbPages:Math.ceil(hits.length/hitsPerPage),nbHits:hits.length,hits:hits.slice(page*hitsPerPage,(page+1)*hitsPerPage)})};};
 const dependencies={operation,store,fetchImpl};
 return Object.assign(f,{api:createRecipes(dependencies),ordering:createOrdering(dependencies),catalog:createCatalog(dependencies)});
}
