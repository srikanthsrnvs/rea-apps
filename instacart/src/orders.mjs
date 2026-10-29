import { orderingQueries, requiredId } from './cart.mjs';

export async function listOrders(client, { first = 20, after, addressId } = {}) {
  if (!Number.isSafeInteger(first) || first < 1 || first > 100) {
    throw Object.assign(new Error('first must be an integer from 1 to 100.'), { code: 'INVALID_ARGUMENT' });
  }
  const variables = { first };
  if (after !== undefined) variables.after = requiredId(after, 'after');
  if (addressId !== undefined) variables.addressId = requiredId(addressId, 'addressId');
  const data = await client.graphql('OrderDeliveriesConnection', orderingQueries.OrderDeliveriesConnection, variables);
  const connection = data.orderDeliveriesConnection;
  return {
    orders: (connection?.nodes ?? []).map((order) => ({
      id: order.id,
      orderId: order.legacyOrderId,
      status: order.workflowState,
      serviceType: order.serviceType,
      retailer: order.retailer ? { id: order.retailer.id, name: order.retailer.name } : null,
      shopId: order.shop?.id,
      statusDisplay: order.viewSection?.statusWithDateString,
      totalDisplay: order.amounts?.viewSection?.totalLine?.amountString,
      expectedTotalDisplay: order.amounts?.viewSection?.userExpectedTotalLine?.amountString,
      permittedActions: order.actions?.permittedActions ?? [],
      items: order.orderItems?.map((item) => ({ id: item.id, name: item.currentItem?.name })),
    })),
    pageInfo: connection?.pageInfo ?? { hasNextPage: false, endCursor: null },
  };
}

export async function getOrder(client, { orderId } = {}) {
  requiredId(orderId, 'orderId');
  const data = await client.graphql('OrderDeliveries', orderingQueries.OrderDeliveries, { orderId });
  const order = data.orderDelivery;
  if (!order) return { order: null };
  return { order: {
    orderId,
    retailer: order.retailer?.name,
    statusDisplay: order.viewSection?.statusString,
    statusWithDateDisplay: order.viewSection?.statusWithDateString,
    permittedActions: order.actions?.permittedActions ?? [],
    items: order.orderItems?.map((item) => ({
      id: item.id,
      status: item.status,
      name: item.currentItem?.name,
      priceDisplay: item.currentItem?.viewSection?.customerPriceString,
    })),
  } };
}
