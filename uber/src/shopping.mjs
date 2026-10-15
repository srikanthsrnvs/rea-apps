import { shoppingRequest } from './protocol.mjs';
import { normalizeQuotes, legacyFareRequest } from './quotes.mjs';

export async function fetchRouteQuotes(send, { from, to, via = [] }) {
  return fetchShoppingQuotes(send, shoppingRequest(from, to, via));
}

export async function fetchShoppingQuotes(send, request) {
  const pointString = (point) => `${point?.latitude},${point?.longitude}`;
  const from = pointString(request.pickupWaypoint?.locationSpec?.point);
  const waypoints = request.waypointSpecs ?? [];
  const to = pointString(waypoints.at(-1)?.locationSpec?.point);
  const via = waypoints
    .slice(0, -1)
    .map((waypoint) => pointString(waypoint.locationSpec?.point));
  const shopping = await send('/rt/shopping-service/order_selection/', {
    request,
  });
  const orders = shopping.response?.fullResponse?.shoppingOrders;
  if (!Array.isArray(orders))
    throw new Error('Shopping response has no product catalog');
  const ids = [
    ...new Set(
      orders
        .map(
          (order) =>
            order.jobs?.singleTransport?.transportJob?.productContext?.legacy
              ?.vehicleViewID,
        )
        .filter(Number.isSafeInteger),
    ),
  ];
  if (!ids.length)
    throw new Error('Shopping response has no vehicle view IDs for pricing');
  const fares = await send(
    '/rt/riders/me/fare-estimate',
    legacyFareRequest(from, to, via, ids),
  );
  return {
    request,
    shopping,
    fares,
    summary: normalizeQuotes(shopping, fares),
  };
}
