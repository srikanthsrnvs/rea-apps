const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const compact = (value) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
const copy = (value) =>
  value === undefined ? undefined : structuredClone(value);

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'EATS_RESPONSE_INVALID' });
}

function total(order) {
  const lines = Array.isArray(order.checkoutInfo)
    ? order.checkoutInfo
    : order.fareInfo?.checkoutInfo;
  if (!Array.isArray(lines)) return undefined;
  const totals = lines.filter((line) => line?.key === 'eats_fare.total');
  if (totals.length !== 1) return undefined;
  const value = totals[0];
  const amount =
    typeof value.rawValue === 'number' && Number.isFinite(value.rawValue)
      ? value.rawValue
      : undefined;
  const formatted = typeof value.value === 'string' ? value.value : undefined;
  if (amount === undefined && formatted === undefined) return undefined;
  return compact({
    amount,
    formatted,
    currency:
      typeof order.currencyCode === 'string' ? order.currencyCode : undefined,
  });
}

/** Native history amounts retain their original major-unit value and display. */
export function normalizeEatsHistory(response) {
  if (!object(response) || !Array.isArray(response.orders))
    invalid('Uber Eats returned no supported order history');
  const orders = response.orders.map((order) => {
    if (!object(order) || typeof order.uuid !== 'string' || !order.uuid)
      invalid('Uber Eats history returned an order without its identity');
    if (order.items !== undefined && !Array.isArray(order.items))
      invalid('Uber Eats history returned an invalid item list');
    return compact({
      orderId: order.uuid,
      displayId: order.displayId,
      storeId: order.store?.uuid,
      storeName: order.storeName ?? order.store?.title,
      diningMode: order.diningMode,
      fulfillmentType: order.fulfillmentType,
      completionStatus: copy(order.completionStatus),
      total: total(order),
      items: (order.items ?? []).map((item) => {
        if (!object(item))
          invalid('Uber Eats history returned an invalid item');
        return compact({
          itemId: item.uuid,
          lineId: item.shoppingCartItemUuid,
          sectionId: item.sectionUuid,
          subsectionId: item.subsectionUuid,
          name: item.title,
          quantity: item.quantity,
          price: item.price,
          isOrderable: item.isOrderable,
          customizationV2s: copy(
            item.customizationV2s ?? item.customizationsV2,
          ),
          // Legacy selections have a different shape; do not label them V2.
          ...(item.customizationV2s == null && item.customizationsV2 == null
            ? { customizations: copy(item.customizations) }
            : {}),
        });
      }),
    });
  });
  const pagination = response.paginationData;
  if (pagination !== undefined && !object(pagination))
    invalid('Uber Eats history returned invalid pagination');
  if (
    pagination?.nextCursor !== undefined &&
    pagination.nextCursor !== null &&
    typeof pagination.nextCursor !== 'string'
  )
    invalid('Uber Eats history returned an invalid continuation cursor');
  return compact({ orders, nextCursor: pagination?.nextCursor });
}

export function eatsTrackingCommands(workflowId) {
  return {
    command: `uber eats track --order-id ${workflowId}`,
    mapCommand: `uber eats track --action serve --order-id ${workflowId}`,
    streamCommand: `uber eats track --action stream --order-id ${workflowId}`,
  };
}

/** Preserve native status structures and a selected-order tracking entry point. */
export function normalizeEatsActiveOrders(response) {
  if (!object(response) || !Array.isArray(response.activeEaterOrdersMobileView))
    invalid('Uber Eats returned no supported active order list');
  const orders = response.activeEaterOrdersMobileView.map((order) => {
    if (!object(order)) invalid('Uber Eats returned an invalid active order');
    const orderId = order.orderUUID ?? order.uuid;
    if (typeof orderId !== 'string' || !orderId)
      invalid('Uber Eats active order has no supported identity');
    return compact({
      orderId,
      uuid: order.uuid,
      orderUUID: order.orderUUID,
      orderInfo: copy(order.orderInfo),
      activeOrderStatus: copy(order.activeOrderStatus),
      activeOrderOverview: copy(order.activeOrderOverview),
      orderPickupDetails: copy(order.orderPickupDetails),
      tracking: eatsTrackingCommands(order.uuid ?? orderId),
    });
  });
  return { orders, activeOrderCount: orders.length };
}
