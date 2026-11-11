import { cartRows, fingerprint, ownerBinding, fail } from './ordering-protocol.mjs';

function selections(row) {
  let groups = row.selected_modifiers ?? [];
  if (typeof groups === 'string') {
    try { groups = JSON.parse(groups); } catch { fail('INVALID_RESPONSE', 'The cart returned unreadable choices.'); }
  }
  if (!Array.isArray(groups)) fail('INVALID_RESPONSE', 'The cart returned unreadable choices.');
  return groups.flatMap(group => (group.modifiers ?? [])
    .filter(option => option.is_selected === true || Number(option.count ?? option.quantity) > 0)
    .map(option => ({ group: group.name, option: option.name, count: Number(option.count ?? option.quantity ?? 1), groupId: group._id, optionId: option._id })))
    .sort((a, b) => `${a.groupId}:${a.optionId}`.localeCompare(`${b.groupId}:${b.optionId}`));
}

// Quantity is deliberately excluded: an absolute quantity edit keeps the same
// reference. Different customizations, carts, accounts and fulfillment do not.
export function cartItemRef(session, cart, row) {
  return `item-${fingerprint({ owner: ownerBinding(session), cart: cart.cartId,
    store: cart.store?._id, method: cart.orderType, address: cart.orderType === 'delivery' ? cart.address?.address_id : undefined,
    row: row.cart_product_id, product: row._id, name: row.product?.name, sku: row.product?.sku,
    size: row.modifier_size_id ?? null, choices: selections(row), instruction: row.product_instruction ?? '' }).slice(0, 24)}`;
}

export function cartContentsDigest(session, cart, response) {
  return fingerprint(cartRows(response).filter(row => row.quantity > 0)
    .map(row => ({ itemRef: cartItemRef(session, cart, row), quantity: row.quantity }))
    .sort((a, b) => a.itemRef.localeCompare(b.itemRef)));
}

function sizeLabel(row) {
  const size=row.product?.modifier_size?.find(size=>size._id===row.modifier_size_id)?.name;
  if(size)return size;
  // Native cart rows omit the product's size catalog but include the selected
  // size alongside modifier labels. Use it only when one label is unambiguous.
  const options=new Set(selections(row).map(choice=>choice.option));
  const remaining=Array.isArray(row.selected_modifiers_items)?row.selected_modifiers_items.filter(label=>typeof label==='string'&&!options.has(label)):[];
  return row.modifier_size_id&&remaining.length===1?remaining[0]:undefined;
}

export function cartView(session, cart, response) {
  const items = cartRows(response).filter(row => row.quantity > 0).map(row => ({
    itemRef: cartItemRef(session, cart, row), name: row.product?.name, quantity: row.quantity,
    size: sizeLabel(row), description: row.selected_modifiers_desc,
    choices: selections(row).map(({ group, option, count }) => ({ group, option, count })),
    instruction: row.product_instruction ?? '',
  }));
  return { status: 'cart_only', orderPrepared: false, orderPlaced: false,
    fulfillment: { type: cart.orderType, store: cart.store?.name,
      ...(cart.orderType === 'delivery' ? { address: cart.address } : {}) },
    items, totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    nextAction: 'Cart only; nothing ordered or reserved. Use cart_set_quantity with an itemRef to change a TOTAL quantity, or order_prepare_cart only when a checkout review is requested.' };
}
