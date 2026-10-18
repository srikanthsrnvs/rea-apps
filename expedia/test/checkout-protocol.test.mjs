import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckoutApolloState, checkoutFromApolloState, checkoutPreview, validateFlightCheckoutUrl, extractFlightCheckoutUrl, buildFlightBookingMutation, buildCheckoutSessionQuery, buildSmartFormMutation, normalizeFlightBookingResult, resolveCheckoutReferences } from '../src/checkout-protocol.mjs';
const id='00000000-0000-4000-8000-000000000001', url=`https://www.expedia.com/checkout/session/${id}?productLine=FLIGHT&tripId=trip`;
const context={identity:{authState:'ANONYMOUS',duaid:'anonymous'}};
const state=()=>({ROOT_QUERY:{
  [`checkout(${JSON.stringify({context})})`]:{[`getSession(${JSON.stringify({sessionID:id})})`]:{token:'private-token',productLine:'FLIGHT',checkoutSessionMode:'CHECKOUT_SESSION_MODE_REGULAR'},checkoutBookButton:{defaultButton:{content:{primary:'Complete booking'}}}},
  [`smartForm(${JSON.stringify({context,sessionId:id,type:'CONTACT_INFORMATION'})})`]:{view:{containers:[{elements:[{__typename:'SmartFormTextInputComponent',inputId:'server-id',label:'First name',required:true}]}]}},
  [`priceDetails(${JSON.stringify({context,sessionId:id})})`]:{pricePresentation:{title:{primary:'Total (USD)'},sections:[{primary:'$123.45'}]},trackingData:{totalPriceAmount:123.45,totalPriceCurrencyCode:'USD'}},
  [`paymentModule(${JSON.stringify({context,sessionId:id})})`]:{checkoutIdentifier:{sessionId:id,sessionToken:'private-token'},metaData:{paymentParameters:{hasStoredCards:true,paymentPayType:'PAY_NOW'}}},
},__REA_CHECKOUT_PAGE__:{deviceId:'anonymous',trustRequirement:{allowsEmpty:true,mode:'empty_payload_supported'},paymentFlow:'LEGACY_CPM'}});
const code=fn=>{try{fn();assert.fail('Expected an error');}catch(e){return e.code;}};
test('checkout bootstrap parses only JSON and never executes a remote script',()=>{
 globalThis.checkoutScriptExecuted=false;
 const input=state();delete input.__REA_CHECKOUT_PAGE__;const html=`<script>window.__APOLLO_STATE__ = JSON.parse(${JSON.stringify(JSON.stringify(input))}); globalThis.checkoutScriptExecuted=true;</script>`;
 assert.deepEqual(parseCheckoutApolloState(html),input);assert.equal(globalThis.checkoutScriptExecuted,false);
 delete globalThis.checkoutScriptExecuted;
 assert.equal(code(()=>parseCheckoutApolloState('<script>window.__APOLLO_STATE__ = arbitraryCall()</script>')),'CHECKOUT_BOOTSTRAP_MISSING');
});
test('a returned checkout must match the selected session and product',()=>{
 assert.equal(checkoutFromApolloState(state(),url).sessionId,id);
 assert.equal(code(()=>checkoutFromApolloState(state(),url.replace(id,'00000000-0000-4000-8000-000000000002'))),'CHECKOUT_SESSION_MISMATCH');
 const other=state();Object.values(other.ROOT_QUERY)[0][`getSession(${JSON.stringify({sessionID:id})})`].productLine='LODGING';
 assert.equal(code(()=>checkoutFromApolloState(other,url)),'UNSUPPORTED_CHECKOUT_PRODUCT');
});
test('checkout preparation cannot follow arbitrary hosts, credentials, or purchase URLs',()=>{
 const action='/checkout-redirect?action=UnifiedDetailsWidget%40statelessBook&offerToken=opaque';
 assert.equal(extractFlightCheckoutUrl({data:{flightsDetail:{priceSummary:{buttonAction:{relativeURI:{value:action}}}}}}),`https://www.expedia.com${action}`);
 for(const bad of ['https://www.expedia.com.evil.example/checkout/session/x','https://user@www.expedia.com/checkout/session/x','http://www.expedia.com/checkout/session/x','https://www.expedia.com:444/checkout/session/x','/checkout-redirect?action=book&offerToken=opaque'])assert.equal(code(()=>validateFlightCheckoutUrl(bad,{preparation:true})),'INVALID_CHECKOUT_URL');
});
test('preview includes fare and readiness but never session or payment tokens',()=>{
 const preview=checkoutPreview(checkoutFromApolloState(state(),url));
 assert.deepEqual(preview.price,{amount:123.45,currency:'USD',presentation:['Total (USD)','$123.45']});
 assert.equal(preview.payment.hasStoredCards,true);assert.equal(preview.readyToBook,false);
 assert.ok(!JSON.stringify(preview).includes('private-token'));assert.ok(!Object.hasOwn(preview,'context'));
});
test('cyclic or missing Apollo references fail closed',()=>{
 assert.equal(code(()=>resolveCheckoutReferences({a:{__ref:'a'}},{__ref:'a'})),'INVALID_CHECKOUT_RESPONSE');
 assert.equal(code(()=>resolveCheckoutReferences({},{__ref:'absent'})),'INVALID_CHECKOUT_RESPONSE');
 assert.deepEqual(resolveCheckoutReferences({a:{text:'Flight'}},{__ref:'a'}),{text:'Flight'});
});
test('booking and validation requests bind current session tokens and preserve exact server identifiers',()=>{
 const checkout=checkoutFromApolloState(state(),url);
 const request=buildFlightBookingMutation(checkout,{domainInfoList:[{name:'trustServicePayload',refId:'server-issued'}]});
 assert.equal(request.operationName,'BookMutation');assert.deepEqual(request.variables.checkoutSessionInfo,{sessionId:id,sessionToken:'private-token'});
 assert.equal(request.variables.checkoutSessionMode,'CHECKOUT_SESSION_MODE_REGULAR');
 assert.equal(buildCheckoutSessionQuery(checkout).variables.isValidate,true);
 assert.equal(code(()=>buildFlightBookingMutation({...checkout,sessionToken:''})),'INVALID_CHECKOUT_SESSION');
});
test('form updates reject field identifiers from another checkout',()=>{
 const checkout=checkoutFromApolloState(state(),url);
 const request=buildSmartFormMutation(checkout,{type:'CONTACT_INFORMATION',timestamp:123,userFieldInputs:[{inputId:'server-id',value:'Example'}]});
 assert.deepEqual(request.variables.data,{timestamp:'123',userInput:{userFieldInputs:[{inputId:'server-id',value:'Example'}]}});
 assert.equal(code(()=>buildSmartFormMutation(checkout,{type:'CONTACT_INFORMATION',userFieldInputs:[{inputId:'unknown',value:'Example'}]})),'INVALID_FORM_INPUT');
});
test('allocated order identifiers do not claim ticket issuance, async results are pending',()=>{
 const result=normalizeFlightBookingResult({data:{book:{data:{orderId:'order',itineraryNumber:'itinerary',email:'private@example.com',checkoutSessionToken:'secret',classicRedirectUrl:'https://example.test/private'}}}});
 assert.equal(result.status,'order_created');assert.equal(result.ticketingStatus,'unverified');assert.ok(!JSON.stringify(result).includes('private'));
 const pending=normalizeFlightBookingResult({data:{book:{data:{asyncResolution:{pollIntervalMs:1000,pollBackoff:2,pollingTimeoutMs:30000,timeoutRedirectionUrl:'secret'}}}}});
 assert.equal(pending.status,'pending');assert.ok(!JSON.stringify(pending).includes('secret'));
 assert.equal(code(()=>normalizeFlightBookingResult({errors:[{message:'timeout'}]})),'BOOKING_RESULT_UNCERTAIN');
});

test('form schema preserves gender requiredness, composes dates, and selects active billing country only',async()=>{
 const {checkoutFormFields}=await import('../src/checkout-protocol.mjs');
 const checkout={forms:[{type:'CONTACT_INFORMATION',view:{elements:[
  {__typename:'SmartFormRadioGroupInputComponent',inputId:'gender',label:'Gender',smartFormRadioGroup:{required:true,options:[{radioButton:{label:'Option',value:'OPTION'}}]}},
  {__typename:'SmartFormDateInputComponent',inputId:'dob',required:true,components:[{__typename:'SmartFormTextInputComponent',inputId:'internal-year'}]},
 ]}},{type:'BILLING_ADDRESS',view:{__typename:'SmartFormBillingAddressComponent',country:{__typename:'SmartFormSelectInputComponent',inputId:'country',required:true,options:[{label:'United States',value:'USA',selected:true}]},fieldConfigTemplates:[{templateId:'USA_CONFIG',config:{city:{__typename:'BillingFieldSpec',inputId:'city',required:true},stateProvince:{__typename:'BillingStateFieldSpec',inputId:'state',required:true}}},{templateId:'OTHER',config:{city:{__typename:'BillingFieldSpec',inputId:'foreign-hidden',required:true}}}],countryToTemplateMapping:[{countryCode:'USA',templateId:'USA_CONFIG'}],stateProvinceOptionsByCountry:[{countryCode:'USA',options:[{label:'Example state',value:'EX'}]}]}}]};
 const fields=checkoutFormFields(checkout);
 assert.equal(fields[0].fields.find(f=>f.inputId==='gender').required,true);
 assert.deepEqual(fields[0].fields.find(f=>f.inputId==='gender').options,[{label:'Option',value:'OPTION',selected:false}]);
 assert.ok(!fields.flatMap(f=>f.fields).some(f=>f.inputId==='internal-year'||f.inputId==='foreign-hidden'));
 assert.equal(fields[1].fields.find(f=>f.inputId==='state').options[0].value,'EX');
});
test('stored payment selection binds the returned fop and never accepts arbitrary card ids',async()=>{
 const {buildPaymentSelectionMutation,buildStoredCardTokenMutation,checkoutPaymentOptions}=await import('../src/checkout-protocol.mjs');
 const checkout=checkoutFromApolloState(state(),url);checkout.payment={components:[
  {__typename:'PaymentInstrument',fopId:'new-card',state:'STATE_SELECTED',paymentMethod:'CREDIT_CARD'},
  {__typename:'PaymentInstrument',fopId:'stored-card',state:'STATE_UNSELECTED',paymentMethod:'CREDIT_CARD',isStoredCard:true,storedCardConfig:{storedPaymentInstrumentId:'private-stored-card-id'}},
 ]};
 const selection=buildPaymentSelectionMutation(checkout,{paymentOptionId:'stored-card'});
 assert.deepEqual(selection.variables.selectPaymentMethodRequest.fopItems.map(f=>[f.id,f.state]),[['stored-card','STATE_SELECTED'],['new-card','STATE_UNSELECTED']]);
 assert.equal(buildStoredCardTokenMutation(checkout,{paymentOptionId:'stored-card',paymentSessionId:'server-session'}).variables.paymentTokenRequest.storedPaymentInstrumentId,'private-stored-card-id');
 assert.ok(!JSON.stringify(checkoutPaymentOptions(checkout)).includes('private-stored-card-id'));
 assert.equal(code(()=>buildStoredCardTokenMutation(checkout,{paymentOptionId:'new-card',paymentSessionId:'server-session'})),'INVALID_STORED_PAYMENT');
});
test('pending booking with an allocated order id must still reconcile through the exact status query',async()=>{
 const {buildFlightBookingStatusQuery,normalizeFlightBookingStatus}=await import('../src/checkout-protocol.mjs');
 const pending=normalizeFlightBookingResult({data:{book:{data:{orderId:'order',signals:[{signal:'PENDING_CONFIRMATION'}]}}}});
 assert.equal(pending.status,'pending');
 const query=buildFlightBookingStatusQuery(checkoutFromApolloState(state(),url),{orderId:'order',orderNumber:'number'});
 assert.equal(query.operationName,'RedirectOrderStatusQuery');
 assert.deepEqual(query.variables.confirmationSummaryParams,{orderId:'order',orderNumber:'number',orderStatus:'PENDING',sessionId:id,domainUrl:'https://www.expedia.com'});
 assert.equal(normalizeFlightBookingStatus({data:{confirmationSummary:{orderStatus:'SUCCESS'}}}).status,'booked');
 assert.equal(normalizeFlightBookingStatus({data:{confirmationSummary:{orderStatus:'FAILED'}}}).status,'failed');
 assert.equal(normalizeFlightBookingResult({data:{book:{data:{orderId:'order',signals:[{signal:'PAYMENT_ERROR'}]}}}}).status,'requires_reconciliation');
});

test('new card tokenization uses only the server scoped official endpoint and no card data leaks into booking',async()=>{
 const {buildNewCardTokenizationRequest,normalizeCardTokenizationResult,buildCardPaymentUpdateMutation}=await import('../src/checkout-protocol.mjs');
 const checkout=checkoutFromApolloState(state(),url);checkout.payment={metaData:{countryCode:'USA'},components:[
  {__typename:'PaymentInstrument',fopId:'new-card',state:'STATE_SELECTED',paymentMethod:'CREDIT_CARD',paymentInstrumentType:'BANK_ISSUED_CARD'},
  {__typename:'PaymentCardDetailsTokenizationField',accessTokenForCardTokenization:'scoped-bearer',cardTokenizationServiceURI:'https://api.expedia.com/v2/edge-tokens/instruments'},
 ]};
 const input={number:'4242 4242 4242 4242',cvv:'123',firstName:'Example',lastName:'Traveler',expirationMonth:10,expirationYear:2030,billingAddress:{countryCode:'USA',postalCode:'90001'}};
 const request=buildNewCardTokenizationRequest(checkout,input,{paymentOptionId:'new-card'});
 assert.equal(request.headers.authorization,'Bearer scoped-bearer');assert.equal(request.body.card_number,'4242424242424242');assert.equal(request.body.card_expiration_year,'2030');assert.equal(request.method,'POST');
 const {edgeToken}=normalizeCardTokenizationResult({id:'edge-token'}),update=buildCardPaymentUpdateMutation(checkout,{paymentOptionId:'new-card',edgeToken,billingCountry:'USA'});
 assert.equal(update.variables.updatePaymentMethodRequest.fopItems[0].paymentMethodConfiguration.etzToken,'edge-token');
 assert.ok(!JSON.stringify(update).includes('4242424242424242'));assert.ok(!JSON.stringify(buildFlightBookingMutation(checkout)).includes('4242424242424242'));
 checkout.payment.components[1].cardTokenizationServiceURI='https://untrusted.example/v2/edge-tokens/instruments';
 assert.equal(code(()=>buildNewCardTokenizationRequest(checkout,input,{paymentOptionId:'new-card'})),'PAYMENT_TOKENIZATION_UNAVAILABLE');
});
test('payment update treats official authentication init and server errors as blocking states',async()=>{
 const {normalizeCardPaymentUpdate}=await import('../src/checkout-protocol.mjs');
 const payload={data:{updatePaymentMethod:{updatedFops:[{__typename:'CreditCardPaymentFop',paymentMethodAttribute:{authenticationSpec:{pasSessionId:'pas',encodedInitConfig:'server-config'}}}],checkoutIdentifier:{sessionId:id,sessionToken:'updated'},actions:[]}}};
 assert.equal(normalizeCardPaymentUpdate(payload).state,'requires_action');
 payload.data.updatePaymentMethod.actions.push({__typename:'PaymentPublishSignalAction',serverSignals:[{payload:{signalUrn:'urn:expe:taxo:checkout:signal:payment-error'}}]});
 assert.equal(normalizeCardPaymentUpdate(payload).state,'blocked');
 payload.data.updatePaymentMethod.actions=[{__typename:'PaymentShowErrorMessageAction',error:{text:'Card was declined'}}];
 assert.equal(normalizeCardPaymentUpdate(payload).state,'blocked');
});

test('payment selection honors explicit switch failures and the payment adapter client id',async()=>{
 const {normalizePaymentSelection,buildPaymentSelectionMutation}=await import('../src/checkout-protocol.mjs');
 const checkout=checkoutFromApolloState(state(),url);checkout.paymentClientDetails={clientId:'MCKO'};
 checkout.payment={components:[{__typename:'PaymentInstrument',fopId:'new',paymentMethod:'CREDIT_CARD',state:'STATE_SELECTED'}]};
 assert.equal(buildPaymentSelectionMutation(checkout,{paymentOptionId:'new'}).variables.clientId,'MCKO');
 const response={data:{selectPaymentMethod:{actions:[{__typename:'PaymentMethodSwitchAction',uiSignal:'PAYMENT_METHOD_SELECT_SUCCESS'}],checkoutIdentifier:{sessionId:id,sessionToken:'new'},paymentCheckoutElement:{__typename:'PaymentCheckoutElement'}}}};
 assert.equal(normalizePaymentSelection(response).state,'selected');
 response.data.selectPaymentMethod.actions[0].uiSignal='PAYMENT_METHOD_SELECT_FAILURE';
 assert.equal(normalizePaymentSelection(response).state,'blocked');
 assert.equal(code(()=>normalizePaymentSelection({errors:[{}]})),'PAYMENT_SELECTION_UNCERTAIN');
});

test('authorable form files bind a session and check required fields before any mutation',async()=>{
 const {checkoutInputTemplate,validateCheckoutInput}=await import('../src/checkout-protocol.mjs');
 const checkout=checkoutFromApolloState(state(),url),input=checkoutInputTemplate(checkout);
 assert.equal(code(()=>validateCheckoutInput(checkout,input)),'REQUIRED_FORM_FIELDS');
 input.forms[0].userFieldInputs[0].value='Example';
 assert.deepEqual(validateCheckoutInput(checkout,input),[{type:'CONTACT_INFORMATION',userFieldInputs:[{inputId:'server-id',value:'Example'}]}]);
 assert.equal(code(()=>validateCheckoutInput(checkout,{...input,sessionId:'other'})),'CHECKOUT_SESSION_MISMATCH');
});

test('empty trust payload needs a real checkout experiment bound to the same device',()=>{
 const input=state();delete input.__REA_CHECKOUT_PAGE__;
 const html=plugins=>`<script>window.__APOLLO_STATE__=JSON.parse(${JSON.stringify(JSON.stringify(input))});window.__PLUGIN_STATE__=JSON.parse(${JSON.stringify(JSON.stringify(plugins))})</script>`;
 const plugins={context:{context:{deviceId:'anonymous'}},'experiment-store':{experimentStore:{exposures:{HYBRID_CHECKOUT_PASS_EMPTY_TRUST_PAYLOAD:{bucket:1},MCKO_MIGRATION_ONECPM_TNL_EXPOSURE:{bucket:1},MCKO_ONECPM_FLIGHT_LOB:{bucket:1},MCKO_CLIENT_ID_ONE_CPM:{bucket:1}}}}};
 const checkout=checkoutFromApolloState(parseCheckoutApolloState(html(plugins)),url);
 assert.equal(checkout.trustRequirement.allowsEmpty,true);assert.equal(checkout.trustRequirement.source,'checkout_ssr_experiment');
 assert.equal(checkout.paymentComponent,'ONE_CPM');assert.equal(checkout.paymentFlow,'LEGACY_CPM');
 assert.deepEqual(buildFlightBookingMutation(checkout).variables.domainInfoList,[]);
 assert.equal(buildFlightBookingMutation(checkout).variables.clientId,'LEGACY_CPM');
 plugins.context.context.deviceId='another-device';
 const mismatched=checkoutFromApolloState(parseCheckoutApolloState(html(plugins)),url);
 assert.equal(mismatched.trustRequirement.allowsEmpty,false);
 assert.equal(code(()=>buildFlightBookingMutation(mismatched)),'CHECKOUT_TRUST_ACTION_REQUIRED');
 assert.equal(buildFlightBookingMutation(mismatched,{domainInfoList:[{name:'trustServicePayload',refId:'genuine-payload'}]}).variables.domainInfoList[0].refId,'genuine-payload');
 plugins.context.context.deviceId='anonymous';delete plugins['experiment-store'].experimentStore.exposures.HYBRID_CHECKOUT_PASS_EMPTY_TRUST_PAYLOAD;
 assert.equal(code(()=>buildFlightBookingMutation(checkoutFromApolloState(parseCheckoutApolloState(html(plugins)),url))),'CHECKOUT_TRUST_ACTION_REQUIRED');
});
