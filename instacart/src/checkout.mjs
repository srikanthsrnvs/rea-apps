import { createHash, randomUUID } from 'node:crypto';
import { getCart, orderingQueries, requiredId } from './cart.mjs';
import { addresses, shop } from './catalog.mjs';
import { saveState } from './state.mjs';

function text(formatted) {
  return (formatted?.sections ?? []).map(section => section.text ?? section.content ?? '').join('');
}

function objects(value, result = []) {
  if (Array.isArray(value)) for (const child of value) objects(child, result);
  else if (value && typeof value === 'object') {
    result.push(value);
    for (const child of Object.values(value)) objects(child, result);
  }
  return result;
}

function resource(initialization, suffix) {
  return initialization.checkoutResourceCollection?.resources?.find(value => value.__typename?.endsWith(suffix));
}

function selection(initialization, suffix) {
  return initialization.checkoutResourceSelections?.selections?.find(value => value.__typename?.endsWith(suffix));
}

export function checkoutReview(initialization, invoice, { cart, store, address, previewId, createdAt }) {
  const presenter = invoice.checkoutTotalsPresenter;
  const invoiceView = presenter?.viewSection;
  const paymentAmounts = presenter?.invoicingPaymentMethodsApplied?.items ?? [];
  const instruments = objects(resource(initialization, 'PaymentsResource')?.buyFlowInstruments)
    .filter(value => value.instrumentReference && value.viewSection && (value.isSelected || paymentAmounts.some(item => item.instrumentReference === value.instrumentReference)));
  const paymentMethods = instruments.map(instrument => ({
    type: instrument.instrumentType,
    title: text(instrument.viewSection.titleFormattedAttributesString),
    subtitle: text(instrument.viewSection.subtitleFormattedAttributesString),
    amount: paymentAmounts.find(item => item.instrumentReference === instrument.instrumentReference)?.amountAppliedV2,
  }));
  const tipSelection = selection(initialization, 'TipsSelection');
  const tip = resource(initialization, 'TipsResource')?.tipResponse?.tipOptions
    ?.find(option => option.tipInputToken === tipSelection?.tipInputToken);
  const customTip = tipSelection?.customTipAmount;
  const tipDisplay = customTip?.amount !== undefined
    ? `${customTip.amount} ${customTip.currencyCode ?? ''}`.trim()
    : text(tip?.viewSection?.amountFormattedAttributesString) || tip?.viewSection?.labelString || null;
  const serviceSelection = selection(initialization, 'ServiceOptionSelection');
  const service = objects(resource(initialization, 'PricedServiceOptionsResource')?.pricedServiceOptions)
    .find(value => value.serviceOptionToken === serviceSelection?.serviceOptionSelectionToken);
  const pendingRequirements = initialization.checkoutResourceRequirements?.pendingRequirements ?? [];
  const requirements = pendingRequirements.map(value => ({
    type: value.__typename,
    identifier: value.resourceRequirementIdentifier,
  }));
  const dropoff = selection(initialization, 'DeliveryInstructionsSelection');
  const amount = presenter?.invoiceInfo?.paymentsInfo?.authAmount;
  const paymentSummary = resource(initialization, 'PaymentsResource')?.buyFlowInstruments?.payWithSection?.payWithRow?.viewSection?.stringSet;
  const selectedPaymentDisplay = text(paymentSummary?.payWithRowFormattedAttributesString)
    || paymentSummary?.subtitleString || paymentSummary?.titleString || null;
  const pickupLocation = resource(initialization, 'AddressResource')?.retailerLocation;
  const review = {
    previewId,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 15 * 60_000).toISOString(),
    previewOnly: true,
    orderPlaced: false,
    store: { id: store.shopId, name: store.name },
    serviceType: initialization.checkoutData?.serviceType,
    address: {
      id: address.id,
      streetAddress: address.streetAddress,
      apartmentNumber: address.apartmentNumber || undefined,
      postalCode: address.postalCode,
      cityState: address.viewSection?.cityStateString,
    },
    pickupLocation: initialization.checkoutData?.serviceType === 'pickup' && pickupLocation ? {
      streetAddress: pickupLocation.streetAddress, city: pickupLocation.city, state: pickupLocation.state,
    } : undefined,
    items: cart.items,
    itemCount: cart.itemCount,
    window: service ? {
      date: service.viewSection?.postCheckoutDateString,
      time: service.viewSection?.postCheckoutTimeString,
      display: service.viewSection?.postCheckoutWindowString
        || text(service.viewSection?.windowFormattedAttributesString),
      feeDisplay: text(service.viewSection?.priceFormattedAttributesString),
    } : null,
    deliveryInstructions: dropoff ? {
      dropoffOption: dropoff.selectedDropoffOption,
      instructions: dropoff.additionalDeliveryInstructions,
    } : null,
    tip: { display: tipDisplay, ...(customTip?.amount !== undefined ? { amount: customTip.amount, currency: customTip.currencyCode } : {}) },
    payment: { display: selectedPaymentDisplay, methods: paymentMethods },
    charges: (invoiceView?.checkoutTotalsV2?.checkoutTotals ?? []).map(line => ({
      label: text(line.labelFormattedAttributesString),
      amountDisplay: text(line.updatedAmount?.adjustedAmountFormattedAttributesString)
        || text(line.amountFormattedAttributesString) || text(line.amountStringFormatted),
    })),
    totalDisplay: text(invoiceView?.checkoutSnippets?.placeOrderButton?.totalAmountFormattedAttributesString) || null,
    authorizationHold: amount ? { amount: amount.amount, minorUnits: amount.amountMinorUnits, currency: amount.currency } : null,
    disclaimers: (invoiceView?.disclaimers ?? []).flatMap(disclaimer =>
      (disclaimer.passages ?? []).map(passage => text(passage.lineStringFormatted))).filter(Boolean),
    missingRequirements: requirements,
    incompleteReviewFields: [],
  };
  if (!review.totalDisplay) review.totalDisplay = review.charges.find(line => /^total$/i.test(line.label))?.amountDisplay ?? null;
  if (!review.window?.display) review.incompleteReviewFields.push('serviceWindow');
  if (!tipDisplay) review.incompleteReviewFields.push('tip');
  if (!selectedPaymentDisplay && !paymentMethods.length) review.incompleteReviewFields.push('payment');
  if (!review.totalDisplay || !review.authorizationHold) review.incompleteReviewFields.push('invoiceTotal');
  return review;
}

// Creates a server-side draft and retrieves the invoice. This function never
// calls FinalizeCheckout, submits a payment, or silently changes selections.
export async function prepareCheckout(client, {
  cartId, shopId, addressId, service = 'delivery',
} = {}, { save = saveState, now = () => new Date().toISOString() } = {}) {
  for (const [name, value] of Object.entries({ cartId, shopId, addressId })) requiredId(value, name);
  if (!['delivery', 'pickup'].includes(service)) {
    throw Object.assign(new Error('service must be delivery or pickup.'), { code: 'INVALID_ARGUMENT' });
  }
  const cart = (await getCart(client, { cartId, includeTotals: false })).cart;
  if (!cart?.items?.length) throw Object.assign(new Error('Add items to the cart before preparing checkout.'), { code: 'EMPTY_CART' });
  const store = (await shop(client, { shopId })).shop;
  if (!store || store.serviceType !== service || store.retailerId !== cart.retailerId) {
    throw Object.assign(new Error('Choose a shop matching this cart retailer and service mode.'), { code: 'CART_SHOP_MISMATCH' });
  }
  const address = (await addresses(client)).addresses.find(value => value.id === addressId);
  if (!address) throw Object.assign(new Error('Choose an existing address returned by addresses.'), { code: 'ADDRESS_NOT_FOUND' });
  const variables = {
    cartId, shopId,
    userLocation: { addressId, postalCode: address.postalCode },
    serviceType: service.toUpperCase(),
  };
  const result = await client.graphql('InitializeCheckout', orderingQueries.InitializeCheckout, variables);
  const initialization = result.initializeCheckout;
  if (initialization?.__typename !== 'CheckoutInitializeCheckoutSuccessResponse' || !initialization.checkoutData?.checkoutSessionId) {
    throw Object.assign(new Error('Instacart could not prepare this checkout. Check the selected address and service.'),
      { code: 'CHECKOUT_PREPARATION_FAILED', upstreamType: initialization?.__typename });
  }
  const selectedAddressId = selection(initialization, 'AddressSelection')?.addressId;
  if (selectedAddressId && selectedAddressId !== addressId) {
    throw Object.assign(new Error('Instacart selected a different address; review it in the app before continuing.'), { code: 'CHECKOUT_ADDRESS_MISMATCH' });
  }
  const invoiceResult = await client.graphql('CheckoutDraftOrderInvoiceV2', orderingQueries.CheckoutDraftOrderInvoiceV2,
    { checkoutSessionId: initialization.checkoutData.checkoutSessionId });
  const invoice = invoiceResult.checkoutDraftOrderInvoiceV2;
  if (invoice?.__typename !== 'OrdersOrderInvoice' || !invoice.checkoutTotalsPresenter) {
    throw Object.assign(new Error('Instacart did not return a checkout invoice.'), { code: 'CHECKOUT_INVOICE_UNAVAILABLE' });
  }
  const previewId = randomUUID();
  const createdAt = now();
  const review = checkoutReview(initialization, invoice, { cart, store, address, previewId, createdAt });
  const fingerprint = createHash('sha256').update(JSON.stringify({ cart, review })).digest('hex');
  await save(`checkout_${previewId}`, {
    version: 1, kind: 'preview', status: 'prepared', accountId: client.state?.userId,
    createdAt, expiresAt: review.expiresAt, fingerprint, variables, review, initialization, invoice,
  });
  return review;
}
