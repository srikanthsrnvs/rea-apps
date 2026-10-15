import { coordinate } from './protocol.mjs';
import { authenticatedRequest } from './client.mjs';

// Native RoutingApi.fetchRouteline and RoutelineRequest/Location writers.
export function routelineRequest(from, to) {
  return {
    origin: coordinate(from),
    destination: coordinate(to),
    type: 'DRIVING',
  };
}
export async function fetchRouteline(
  from,
  to,
  { send = authenticatedRequest } = {},
) {
  const response = await send(
    '/rt/routing/fetch-routelines',
    routelineRequest(from, to),
    { readOnly: true },
  );
  if (
    typeof response.encodedPolyline !== 'string' ||
    !response.encodedPolyline ||
    response.encodedPolyline.length > 200000
  )
    throw new Error('Uber did not return a usable road routeline');
  return {
    encodedPolyline: response.encodedPolyline,
    source: 'uber_routing_recommendation',
  };
}
