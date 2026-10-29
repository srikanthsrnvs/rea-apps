const pickup={type:'pickup',store:'Venice'};
const choice=(group,option,count=1)=>({group,option,count});
const cap=(quantity=1,more={})=>({product:{name:'Cappuccino',brand:'Erewhon',sku:'CAP'},quantity,size:'Large 16 oz',choices:[choice('Milk','Oat Milk'),choice('Extras','Espresso Shot',2),choice('Extras','Vanilla Syrup'),choice('Temperature','Extra Hot')],...more});
const matcha={product:{name:'Matcha Latte',brand:'Erewhon',sku:'MAT'},quantity:2,size:'Small 8 oz',choices:[choice('Milk','Almond Milk'),choice('Sweetness','Unsweetened'),choice('Temperature','Iced')]};
const burrito={product:{name:'Breakfast Burrito',brand:'Erewhon',sku:'BUR'},quantity:1,choices:[choice('Salsa','Hot'),choice('Add-ons','Avocado')],instruction:'Cut in half'};
const water={product:{name:'Spring Water',brand:'Mountain',sku:'WAT'},quantity:3};
export const scenarios={
 shots:{prompt:'Prepare 3 large 16 oz Cappuccinos, each with oat milk, TWO extra espresso shots, vanilla syrup, extra hot. Venice pickup ASAP. Leave points alone and show the full quote. Do not buy.',request:{...cap(3),fulfillment:pickup}},
 mixed:{prompt:'For Venice pickup ASAP prepare 2 small 8 oz iced Matcha Lattes with almond milk and unsweetened, one Breakfast Burrito with hot salsa plus avocado (cut in half), and 3 Mountain Spring Waters. No rewards. Show me the checkout, do not buy.',request:{items:[matcha,burrito,water],fulfillment:pickup}},
 split:{prompt:'Prepare two DIFFERENT cappuccinos for Venice pickup: one small 8 oz with whole milk and nothing else; one large 16 oz with oat milk and two extra espresso shots. Keep them as different drinks. No purchase.',request:{items:[cap(1,{size:'Small 8 oz',choices:[choice('Milk','Whole Milk')]}),cap(1,{choices:[choice('Milk','Oat Milk'),choice('Extras','Espresso Shot',2)]})],fulfillment:pickup}},
 repeat:{prompt:'Prepare my team-breakfast recipe for review. The request already ran once; do not duplicate any drinks or food. Do not buy.',request:{items:[matcha,burrito,water],fulfillment:pickup},saved:true,seed:true},
 rotation:{prompt:'Prepare my team-breakfast recipe for review with current products and prices. Do not buy.',request:{items:[matcha,burrito,water],fulfillment:pickup},saved:true,rotate:true},
 unavailable:{prompt:'Prepare a large 16 oz Cappuccino with oat milk for Venice pickup. Do not substitute another milk. If oat milk is unavailable, stop and ask. Do not buy.',request:{...cap(1,{choices:[choice('Milk','Oat Milk')]}),fulfillment:pickup},retired:true,error:'CHOICE_UNAVAILABLE'},
 missing:{prompt:'Prepare one Pistachio Croissant for Venice pickup. If you cannot find it, stop; no substitute and no purchase.',request:{product:{name:'Pistachio Croissant'},fulfillment:pickup},error:'PRODUCT_NOT_FOUND'},
 ambiguous:{prompt:'Prepare two Spring Waters for Venice pickup. I have not chosen a brand; if more than one matches, ask me rather than choosing. Do not buy.',request:{product:{name:'Spring Water'},quantity:2,fulfillment:pickup},error:'PRODUCT_AMBIGUOUS'},
 occupied:{prompt:'Prepare one large 16 oz Cappuccino with whole milk for Venice pickup, but preserve anything already in my cart. If that prevents a separate exact review, stop and explain. Do not buy.',request:{...cap(1,{choices:[choice('Milk','Whole Milk')]}),fulfillment:pickup},occupied:true,error:'CART_NOT_EMPTY'},
 partial:{prompt:'The team-breakfast request lost its connection halfway through adding items. Try checking that saved draft, but do not duplicate, clear, or buy anything. If it cannot be safely resumed, explain.',request:{items:[matcha,burrito,water],fulfillment:pickup},saved:true,partial:true,error:'RECIPE_DRAFT_UNRESOLVED'},
 badcard:{prompt:'Prepare a small 8 oz Cappuccino with whole milk for Venice pickup, using ONLY the card ending 9999. If that is not the selected card, stop. Do not buy.',request:{...cap(1,{size:'Small 8 oz',choices:[choice('Milk','Whole Milk')]}),fulfillment:pickup,paymentLast4:'9999'},error:'PAYMENT_CHANGED'},
 delivery:{prompt:'List my saved delivery addresses, then prepare 3 Mountain Spring Waters for delivery to 100 Test Avenue. Show fees and the checkout total. Do not buy.',request:{...water,fulfillment:{type:'delivery',addressId:'saved-home'}},delivery:true},
 grove:{prompt:'Prepare one small 8 oz Matcha Latte with oat milk, light sweetener, iced, at Grove for pickup ASAP. Show the current quote. Do not buy.',request:{...matcha,quantity:1,choices:[choice('Milk','Oat Milk'),choice('Sweetness','Light Sweetener'),choice('Temperature','Iced')],fulfillment:{type:'pickup',store:'Grove'}}},
 budget:{prompt:'Prepare 3 large 16 oz Cappuccinos with oat milk, two extra espresso shots each, vanilla syrup, extra hot, for Venice pickup. My limit is $20 total. Show whether the real quote fits; do not change quantities or options and do not buy.',request:{...cap(3),fulfillment:pickup},budget:20},
 invalidtail:{prompt:'Prepare one small 8 oz Cappuccino with whole milk AND one large 16 oz Matcha Latte with cashew milk and unsweetened for Venice pickup. No substitutions: if either exact drink is unavailable, stop without adding the other. Do not buy.',request:{items:[cap(1,{size:'Small 8 oz',choices:[choice('Milk','Whole Milk')]}),{...matcha,quantity:1,size:'Large 16 oz',choices:[choice('Milk','Cashew Milk'),choice('Sweetness','Unsweetened')]}],fulfillment:pickup},error:'CHOICE_UNAVAILABLE'},
};
// Regression for a real-menu failure: capacity was mistaken for requested count.
scenarios['modifier-defaults']={prompt:'Prepare 2 Large 16 oz Cappuccinos with Oat Milk, Vanilla Syrup, Extra Hot. Venice pickup ASAP. Do not add extra espresso shots. Show the real quote; do not buy.',request:{...cap(2,{choices:[choice('Milk','Oat Milk'),choice('Extras','Vanilla Syrup'),choice('Temperature','Extra Hot')]}),fulfillment:pickup},generousLimits:true};
// Product identities/labels already known from prior discovery: no new lookup needed.
scenarios['known-labels']={prompt:'Prepare for Venice pickup ASAP using these already known exact catalog labels: Cappuccino, brand Erewhon, SKU CAP; quantity 1, size Large 16 oz; choice group Milk, option Whole Milk, one portion; no kitchen instructions. Show the current server checkout total and do not buy.',request:{...cap(1,{choices:[choice('Milk','Whole Milk')]}),fulfillment:pickup},known:true};
// Held-out variations generated before running Qwen, using a fixed seed.
// The prompts and expected specifications are shared by both evaluations.
let randomState=20261029;
const random=n=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return Math.floor((randomState/4294967296)*n);};
for(let trial=1;trial<=12;trial++){
 const items=[], descriptions=[];
 for(let line=0;line<2+random(2);line++){
  const kind=random(4),quantity=1+random(3);
  if(kind===0){
   const size=random(2)?'Large 16 oz':'Small 8 oz',milk=['Whole Milk','Oat Milk','Almond Milk'][random(3)],shots=1+random(3);
   const choices=[choice('Milk',milk),choice('Extras','Espresso Shot',shots)];
   const syrup=Boolean(random(2));if(syrup)choices.push(choice('Extras','Vanilla Syrup'));
   items.push({product:{name:'Cappuccino',brand:'Erewhon',sku:'CAP'},quantity,size,choices});
   descriptions.push(`${quantity} ${size} Cappuccino(s) with ${milk}, ${shots} extra Espresso Shot(s) per drink${syrup?', Vanilla Syrup':''}`);
  }else if(kind===1){
   const size=random(2)?'Large 16 oz':'Small 8 oz',milk=['Whole Milk','Oat Milk','Almond Milk'][random(3)],sweet=['Unsweetened','Light Sweetener','Regular Sweetener'][random(3)];
   items.push({...matcha,quantity,size,choices:[choice('Milk',milk),choice('Sweetness',sweet),choice('Temperature','Iced')]});
   descriptions.push(`${quantity} ${size} iced Matcha Latte(s), ${milk}, ${sweet}`);
  }else if(kind===2){
   const salsa=['Mild','Hot','No Salsa'][random(3)],egg=Boolean(random(2));
   items.push({...burrito,quantity,choices:[choice('Salsa',salsa),choice('Add-ons',egg?'Extra Egg':'Avocado')],instruction:'Cut in half'});
   descriptions.push(`${quantity} Breakfast Burrito(s), salsa choice ${salsa}, add ${egg?'Extra Egg':'Avocado'}, cut in half`);
  }else{items.push({...water,quantity});descriptions.push(`${quantity} Mountain brand Spring Water(s)`);}
 }
 const store=random(2)?'Venice':'Grove';
 scenarios[`heldout-${String(trial).padStart(2,'0')}`]={prompt:`Prepare this entire basket for ${store} pickup ASAP: ${descriptions.join('; ')}. Keep different customizations separate. Leave rewards untouched. Give the server checkout total for review, without purchasing.`,request:{items,fulfillment:{type:'pickup',store}},heldOut:true};
}
export async function setup(f,key){const s=scenarios[key]?{...scenarios[key]}:null;if(!s)throw new Error(`Unknown scenario ${key}`);
 s.recipeName=process.env.EREWHON_EVAL_RECIPE_NAME??'team-breakfast';s.prompt=s.prompt.replaceAll('team-breakfast',s.recipeName);
 if(s.generousLimits)f.generousLimits=true;
 if(s.saved)await f.api.save({name:s.recipeName,recipe:s.request});
 if(s.seed)await f.api.prepare({name:s.recipeName});
 if(s.rotate)f.rotation='fresh-session';
 if(s.retired)f.retired=true;
 if(s.occupied)f.rows.push({_id:'existing',cart_product_id:'user-row',product:{name:'User existing item'},quantity:1,product_price:'2.00'});
 if(s.partial){f.dropAt=2;try{await f.api.prepare({name:s.recipeName});}catch{}f.dropAt=0;}
 return s;
}
