import { randomUUID, createHash } from 'node:crypto';
import { AmazonError } from './errors.mjs';
import { withClient } from './auth.mjs';
import { saveState, readState } from './state.mjs';
import { readRetailPage } from './retail.mjs';
import { retailURL } from './shopping-protocol.mjs';
import { parseOrdersPage, parseOrderDetailsPage } from './orders-protocol.mjs';

export function accountKey(session) {
  if (!session?.customerId || !session.profile?.deviceSerial) throw new AmazonError('LOGIN_REQUIRED', 'A validated Amazon account is required.');
  return createHash('sha256').update(`${session.customerId}\n${session.profile.deviceSerial}`).digest('hex');
}
export async function orderDetails({ orderRef } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(orderRef ?? '')) throw new AmazonError('INVALID_ARGUMENT', 'Use an orderRef returned by orders list.');
  return withClient(async (client, session) => {
    const saved = await readState(`order-${orderRef}`);
    if (!saved || saved.owner !== accountKey(session) || Date.parse(saved.expiresAt) <= Date.now()) throw new AmazonError('ORDER_REFERENCE_EXPIRED', 'Read orders list again to obtain a current reference for this account.');
    const page = await readRetailPage(client, saved.order.actions.details);
    const result = parseOrderDetailsPage(page.html, { url: page.url, orderId: saved.order.orderId });
    return { ...result, orderRef };
  }, { authenticated: true });
}
export async function listOrders({ cursor } = {}) {
  const url = retailURL(cursor ?? 'https://www.amazon.com/your-orders/orders');
  const parsed = new URL(url);
  if (!/^\/your-orders\/(orders|search)(\/ref=[^/]*)?\/?$/.test(parsed.pathname) || ['ac', 'action', 'cancel', 'orderID', 'orderId', 'oid'].some(key => parsed.searchParams.has(key))) throw new AmazonError('INVALID_ARGUMENT', 'Use the orders pagination URL returned by Amazon.');
  return withClient(async (client, session) => {
    const page = await readRetailPage(client, url);
    const result = parseOrdersPage(page.html, { url: page.url });
    const owner = accountKey(session);
    for (const order of result.orders) {
      const orderRef = randomUUID();
      await saveState(`order-${orderRef}`, { owner, order, retrievedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
      order.orderRef = orderRef;
    }
    return result;
  }, { authenticated: true });
}
