import { legacyFareRequest } from './quotes.mjs';

export function selectBookingProduct(
  summary,
  { product, vehicleViewId, variantId } = {},
) {
  if ((product === undefined) === (vehicleViewId === undefined))
    throw new Error('Choose exactly one of --product or --vehicle-view-id');
  const matches = summary.products.filter((p) =>
    product !== undefined
      ? p.name?.toLowerCase() === product.toLowerCase()
      : p.vehicleViewId === vehicleViewId,
  );
  if (matches.length !== 1)
    throw new Error(
      'Car option is missing or ambiguous; inspect quote and select its vehicle view ID',
    );
  const selected = matches[0];
  if (
    selected.availability !== 'AVAILABLE' ||
    selected.reservationOnly === true
  )
    throw new Error('Selected car is not available for an immediate ride');
  const variants = selected.fareVariants;
  const choices = variantId
    ? variants.filter((v) => v.variantId === variantId)
    : selected.fare
      ? [selected.fare]
      : [];
  if (choices.length !== 1)
    throw new Error(
      'Fare selection is missing or ambiguous; choose a variant ID from quote',
    );
  return { product: selected, fare: choices[0] };
}

export function validateSignedFare(
  variant,
  { from, to, via = [], vehicleViewId, now = Date.now() },
) {
  const upfront = variant?.pricingInfo?.fareInfo?.upfrontFare;
  if (!upfront || upfront.vehicleViewId !== vehicleViewId)
    throw new Error('Signed fare does not match the selected car');
  if (
    typeof upfront.fare !== 'string' ||
    !/^\d+(\.\d+)?$/.test(upfront.fare) ||
    !/^[A-Z]{3}$/.test(upfront.currencyCode ?? '')
  )
    throw new Error('Signed fare has no recognized amount and currency');
  if (
    typeof upfront.signature?.signature !== 'string' ||
    !upfront.signature.signature ||
    !Number.isSafeInteger(upfront.signature.expiresAt)
  )
    throw new Error('Fare has no recognized server signature');
  const expiresAt = upfront.signature.expiresAt * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now + 5000)
    throw new Error(
      'Signed fare expired or is too close to expiry; prepare a new booking',
    );
  const route = legacyFareRequest(from, to, via);
  const same = (actual, expected) =>
    Number.isFinite(actual) && Math.abs(actual - expected) < 0.000001;
  if (
    !same(upfront.originLat, route.pickupLocation.latitude) ||
    !same(upfront.originLng, route.pickupLocation.longitude) ||
    !same(upfront.destinationLat, route.destination.latitude) ||
    !same(upfront.destinationLng, route.destination.longitude)
  )
    throw new Error('Signed fare does not match the requested route');
  // Keep intermediate stops visible and refuse a quote for a different itinerary.
  const actual = upfront.viaLocations ?? [];
  const expected = route.viaLocations ?? [];
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some(
      (p, i) =>
        !same(p.latitude, expected[i].latitude) ||
        !same(p.longitude, expected[i].longitude),
    )
  )
    throw new Error('Signed fare does not match the intermediate stops');
  return {
    upfrontFare: upfront,
    amount: upfront.fare,
    currencyCode: upfront.currencyCode,
    expiresAt,
  };
}
