import {shoppingRequest} from './protocol.mjs';
import {normalizeQuotes,legacyFareRequest} from './quotes.mjs';

export async function fetchRouteQuotes(send,{from,to,via=[]}) {
  const request=shoppingRequest(from,to,via);
  const shopping=await send('/rt/shopping-service/order_selection/',{request});
  const orders=shopping.response?.fullResponse?.shoppingOrders;
  if (!Array.isArray(orders)) throw new Error('Shopping response has no product catalog');
  const ids=[...new Set(orders.map(order=>order.jobs?.singleTransport?.transportJob?.productContext?.legacy?.vehicleViewID).filter(Number.isSafeInteger))];
  if (!ids.length) throw new Error('Shopping response has no vehicle view IDs for pricing');
  const fares=await send('/rt/riders/me/fare-estimate',legacyFareRequest(from,to,via,ids));
  return {request,shopping,fares,summary:normalizeQuotes(shopping,fares)};
}
