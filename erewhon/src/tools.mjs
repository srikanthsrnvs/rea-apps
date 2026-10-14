const text={type:'string',minLength:1};
const identity={type:'string',minLength:1,maxLength:200};
const page={type:'integer',minimum:1,default:1};
const tool=(name,command,description,properties={},required=[])=>({name,command,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const reviewOptions={paymentMethodId:identity,scheduleTypeId:identity,time:text,scheduleDate:{type:'string',pattern:'^[0-9]{2}-[0-9]{2}-[0-9]{4}$'},shopperTipId:identity,driverTipId:identity,redeemPoints:{type:'number',minimum:0},couponCode:{type:'string',maxLength:100}};
const reviewFlags='[--payment-method-id ID --schedule-type-id ID --time SERVER_TIME --date MM-DD-YYYY --shopper-tip-id ID --driver-tip-id ID --redeem-points AMOUNT --coupon-code CODE]';
export const toolManifest={
  name:'erewhon',version:1,transport:'CLI',output:'JSON on stdout, JSON errors on stderr with nonzero exit status',
  authentication:'Run login with the user’s existing-account US phone number. Ask for the SMS code and submit it with the returned loginId. No browser or Android is required. Registration stops explicitly; token expiry is server-controlled and requires reauthentication when reported.',
  tools:[
    tool('auth_login','erewhon login --phone <phone> [--replace]','Request one SMS code for an existing account. Reuses an active attempt for the same phone. Do not repeat an uncertain request.',{phone:text,replace:{type:'boolean'}},['phone']),
    tool('auth_complete','erewhon auth complete --login-id <loginId> --code <code>','Submit the user’s four-digit code once, validate the returned session, and save it. Never infer success from SMS delivery.',{loginId:{type:'string',format:'uuid'},code:{type:'string',pattern:'^[0-9]{4}$'}},['loginId','code']),
    tool('auth_poll','erewhon auth poll --login-id <loginId>','Inspect a login attempt without sending another code.',{loginId:{type:'string',format:'uuid'}},['loginId']),
    tool('auth_cancel','erewhon auth cancel --login-id <loginId>','Cancel pending authentication; keep the prior session and order journals.',{loginId:{type:'string',format:'uuid'}},['loginId']),
    tool('auth_validate','erewhon auth validate --login-id <loginId>','Retry read-only validation of an already exchanged candidate; does not resubmit a code.',{loginId:{type:'string',format:'uuid'}},['loginId']),
    tool('auth_status','erewhon auth status','Read local authentication state without exposing credentials.'),
    tool('auth_logout','erewhon auth logout','Delete local credentials and pending login; preserve order journals.'),
    tool('profile','erewhon profile','Read account profile and masked payment summaries.'),
    tool('membership','erewhon membership','Read membership tier, expiry, balance, benefits and spending/savings summaries.'),
    tool('rewards','erewhon rewards --type <type> --page <page>','Read paginated reward accrual or redemption history. Redemption history does not spend rewards.',{type:{type:'string',enum:['accrual','redemption'],default:'accrual'},page}),
    tool('history','erewhon history --type <type> [--page <page> --date-key KEY --order-method-key KEY]','Read online or in-store purchase history. In-store history is paginated; online lists do not expose page support.',{type:{type:'string',enum:['online','instore'],default:'online'},page,dateKey:text,orderMethodKeys:{type:'array',items:text}}),
    tool('receipt','erewhon receipt --trn-cpk <trnCpk> --trn-pk <trnPk>','Retrieve a receipt using both transaction identifiers returned by in-store history.',{trnCpk:identity,trnPk:identity},['trnCpk','trnPk']),
    tool('stores','erewhon stores [--lat LAT --lon LON]','List stores and their catalog indexes. Optional coordinates must be supplied together.',{lat:{type:'number',minimum:-90,maximum:90},lon:{type:'number',minimum:-180,maximum:180}}),
    tool('addresses','erewhon addresses','List saved delivery addresses; does not create or edit them.'),
    tool('address_check','erewhon address check --request <file>','Check delivery serviceability. JSON file needs address1, city, state, zipcode, latitude and longitude; this does not create an address.',{file:text},['file']),
    tool('address_add','erewhon address add --request <file>','Check and explicitly save a delivery address. JSON file needs address1, city, state, zipcode, latitude, longitude and addressType; optional address2, deliveryInstructions, dropMethod and isDefault. It does not select delivery. Inspect addresses after an uncertain result; never repeat the addition.',{file:text},['file']),
    tool('fulfillment','erewhon fulfillment','Read current pickup/delivery selection and initialize this device’s cart context.'),
    tool('fulfillment_select','erewhon fulfillment select --type <type> [--store-id ID --address-id ID]','Select pickup at a returned store, or delivery to an existing returned address. If Erewhon returns store_selection_required, ask the user which offered store to use.',{type:{type:'string',enum:['pickup','delivery']},storeId:identity,addressId:identity},['type']),
    tool('categories','erewhon categories [--department SLUG]','Read catalog departments and categories.',{department:text}),
    tool('search','erewhon search --query <query> [--index INDEX --page 0 --limit 20 --department NAME --brand NAME --category NAME --sub-category NAME]','Search the selected store catalog with product/menu facets. Use the returned nextPage for more results; catalog prices are checked again at checkout.',{query:{type:'string',maxLength:500},index:identity,page:{type:'integer',minimum:0,default:0},limit:{type:'integer',minimum:1,maximum:200,default:20},department:text,brand:text,category:text,subCategory:text},['query']),
    tool('product','erewhon product --id <productId>','Read product details, available variants, modifiers and substitution options. Use the ECRSID or objectID from search as productId.',{productId:identity},['productId']),
    tool('cart','erewhon cart','Read the cart and cart-product IDs for quantity changes.'),
    tool('cart_add','erewhon cart add --product-id <productId> [--quantity 1 --instruction TEXT --modifier-size-id ID --modifiers-file FILE]','Add a product using server-issued modifier IDs. This changes the cart and does not place or pay for an order. Modifier file is a JSON array of {groupId,modifierId,count}.',{productId:identity,quantity:{type:'number',exclusiveMinimum:0,maximum:1000,default:1},instruction:{type:'string',maxLength:2000},modifierSizeId:identity,modifiersFile:text},['productId']),
    tool('cart_update','erewhon cart update --request <file>','Update specified cart rows while preserving others. File shape: {items:[{cartProductId,quantity}]}. Quantity zero can remove a specific customized row.',{file:text},['file']),
    tool('cart_remove','erewhon cart remove --cart-product-id <cartProductId>','Remove the exact cart row by setting its quantity to zero; preserve all other products and customized rows.',{cartProductId:identity},['cartProductId']),
    tool('checkout',`erewhon checkout ${reviewFlags}`,'Read server totals, fees, saved payment IDs and available pickup/delivery times. Select the returned date_mdy with --date when time windows repeat on different days. Optional changes save cart preferences without placing an order.',reviewOptions),
    tool('order_prepare',`erewhon order prepare ${reviewFlags}`,'Prepare a short-lived order plan. Show all products, modifiers, quantities, store/address, time, fees, total and masked payment method to the user for approval.',reviewOptions),
    tool('order_confirm','erewhon order confirm --plan-id <planId> --confirm','Place and pay for the explicitly approved unchanged order plan. Never repeat uncertain/pending outcomes. Additional payment authentication may require a browser on the user’s device.',{planId:{type:'string',format:'uuid'}},['planId']),
    tool('order_detail','erewhon order detail --id <orderId>','Read an existing online order.',{orderId:identity},['orderId']),
    tool('order_operation','erewhon order operation --operation-id <operationId>','Inspect and reconcile the recorded placement outcome. An unresolved operation blocks another placement; do not resend it.',{operationId:{type:'string',format:'uuid'}},['operationId']),
  ],
};
