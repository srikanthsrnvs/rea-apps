import { shoppingRequest } from './protocol.mjs';

const text = value => typeof value === 'string' ? value : null;
const flag = value => typeof value === 'boolean' ? value : null;
const vehicleId = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Legacy location and viaLocations keys are recovered from the shipped Gson writer. */
export function legacyFareRequest(from, to, via = [], vehicleViewIds = []) {
  if (!Array.isArray(vehicleViewIds) || vehicleViewIds.some(id => vehicleId(id) === null)) {
    throw new Error('vehicleViewIds must be an array of nonnegative safe integers');
  }
  const route = shoppingRequest(from, to, via);
  const destination = route.waypointSpecs.at(-1);
  return {
    pickupLocation: { ...route.pickupWaypoint.locationSpec.point },
    destination: { ...destination.locationSpec.point },
    ...(route.waypointSpecs.length > 1 ? {
      viaLocations: route.waypointSpecs.slice(0, -1).map(point => ({ ...point.locationSpec.point })),
    } : {}),
    ...(vehicleViewIds.length ? { vehicleViewIds: [...new Set(vehicleViewIds)] } : {}),
  };
}

function fareVariants(payload) {
  const body = payload?.body ?? payload;
  if (!body || !Array.isArray(body.packageVariants)) {
    throw new Error('Unrecognized fare response: packageVariants is missing; use --raw to inspect the response');
  }
  return body.packageVariants.filter(value => value && typeof value === 'object' && !Array.isArray(value)).map(variant => {
    const pricing = variant.pricingInfo;
    const upfront = pricing?.fareInfo?.upfrontFare;
    const etd = Array.isArray(variant.featureSet)
      ? variant.featureSet.find(feature => feature?.featureData?.etd)?.featureData.etd : null;
    return {
      variantId: text(pricing?.packageVariantUuid),
      vehicleViewId: vehicleId(variant.vehicleViewId) ?? vehicleId(upfront?.vehicleViewId),
      productId: text(variant.productUuid),
      isDefault: flag(variant.isDefault),
      amount: text(upfront?.fare),
      currencyCode: text(upfront?.currencyCode),
      formattedFare: text(pricing?.fareInfo?.metadata?.formattedFare),
      primaryFare: text(pricing?.primaryFare),
      finalPriceText: text(pricing?.finalPrice?.defaultText),
      expiresAt: Number.isSafeInteger(upfront?.signature?.expiresAt) ? upfront.signature.expiresAt : null,
      tripTime: etd ? {
        estimatedTripTime: Number.isFinite(etd.estimatedTripTime) ? etd.estimatedTripTime : null,
        display: text(etd.etdDisplayString),
      } : null,
    };
  });
}

const hasPrice = fare => [fare.amount, fare.formattedFare, fare.primaryFare, fare.finalPriceText]
  .some(value => typeof value === 'string' && value.trim());

function fullResponse(payload) {
  const body = payload?.body ?? payload;
  const full = body?.response?.fullResponse ?? body?.fullResponse ?? body;
  if (!full || !Array.isArray(full.shoppingOrders)) {
    throw new Error('Unrecognized shopping response: shoppingOrders is missing; use --raw to inspect the response');
  }
  return full;
}

/** Summarize the observed full order-selection response without interpreting UI bindings. */
export function normalizeQuotes(payload, farePayload) {
  const full = fullResponse(payload);
  const variants = farePayload === undefined ? [] : fareVariants(farePayload);
  const matched = new Set();
  const membership = new Map();
  const groups = full.features?.orderSelection?.orderGroups;
  for (const group of Array.isArray(groups) ? groups : []) {
    const title = text(group?.titleText);
    if (!title || !Array.isArray(group.shoppingOrderIDs)) continue;
    for (const id of group.shoppingOrderIDs) {
      if (typeof id !== 'string') continue;
      const titles = membership.get(id) ?? new Set();
      titles.add(title);
      membership.set(id, titles);
    }
  }

  let skipped = 0;
  const products = [];
  for (const order of full.shoppingOrders) {
    if (!order || typeof order !== 'object' || Array.isArray(order)) {
      skipped++;
      continue;
    }
    const context = order.jobs?.singleTransport?.transportJob?.productContext;
    const properties = context?.properties;
    const orderId = text(order.id);
    const vehicleViewId = vehicleId(context?.legacy?.vehicleViewID);
    const prices = variants.filter(variant => vehicleViewId !== null && variant.vehicleViewId === vehicleViewId);
    for (const price of prices) matched.add(price);
    const defaults = prices.filter(variant => variant.isDefault);
    products.push({
      orderId,
      productId: text(context?.productTypeID),
      vehicleViewId,
      name: text(order.presentation?.displayName) ?? text(context?.presentation?.productDisplayName),
      description: text(order.presentation?.detailedDescription) ?? text(context?.presentation?.detailedProductDescription),
      availability: text(order.eligibility?.availability),
      passengerCapacity: Number.isSafeInteger(properties?.maxPassengerSeats) && properties.maxPassengerSeats >= 0
        ? properties.maxPassengerSeats : null,
      schedulable: flag(properties?.isSchedulable),
      reservationOnly: flag(properties?.isReservationOnly),
      groups: [...(membership.get(orderId) ?? [])],
      fare: defaults.length === 1 ? defaults[0] : prices.length === 1 ? prices[0] : null,
      fareVariants: prices,
      // ETD is the trip estimate, not time until a vehicle reaches pickup.
      pickupEta: null,
    });
  }
  const warnings = ['Pickup ETAs are not present in the recovered fields. Trip time estimates describe the journey, not the wait for pickup.'];
  if (farePayload === undefined) {
    warnings.unshift('This summary contains ride products only. Fare amounts require a separate fare-estimate response; use --raw to inspect backend data.');
  } else {
    const missing = products.filter(product => !product.fareVariants.some(hasPrice)).length;
    if (missing) warnings.push(`${missing} product${missing === 1 ? '' : 's'} have no matching fare with a price in this response.`);
  }
  if (skipped) warnings.push(`Skipped ${skipped} malformed shopping order${skipped === 1 ? '' : 's'}.`);
  return {
    productCount: products.length,
    fareVariantCount: variants.length,
    pricedVariantCount: variants.filter(hasPrice).length,
    products,
    unmatchedFareVariants: variants.filter(variant => !matched.has(variant)),
    warnings,
  };
}
