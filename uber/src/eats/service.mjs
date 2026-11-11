import { resolveEatsChoices } from './choices.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { authenticatedOperation } from '../client.mjs';
import { coordinate } from '../protocol.mjs';
import { readState, saveState } from '../state.mjs';
import { loadPlan, savePlan, requireUUID } from '../plans.mjs';
import { executeMutation, inspectOperation } from '../mutations.mjs';
import {
  fetchPaymentProfiles,
  normalizePaymentProfiles,
} from '../payments.mjs';
import {
  normalizeEatsSearch,
  normalizeEatsMenu,
  normalizeEatsItemDetail,
} from './discovery.mjs';
import * as protocol from './cart-protocol.mjs';
import {
  normalizeEatsActiveOrders,
  normalizeEatsHistory,
  eatsTrackingCommands,
} from './orders.mjs';
import {
  eatsCancellationOptionsRequest,
  normalizeEatsCancellationOptions,
  eatsFulfillCancellationRequest,
  normalizeEatsCancellationResult,
} from './cancellation-protocol.mjs';

const edge = '/rt/eats/v2/eaters/';
const clone = (value) => structuredClone(value);
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

export function eatsDecimalE5(value) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,5})?$/.test(value)
  )
    throw error('Tip must be an explicit nonnegative decimal amount');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 100000n + BigInt(fraction.padEnd(5, '0'));
  if (amount > 9223372036854775807n) throw error('Tip amount is too large');
  return amount.toString();
}

export function eatsDecimalMinor(value, digits) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 5)
    throw error('Unsupported currency precision');
  const amount = BigInt(eatsDecimalE5(value));
  const factor = 10n ** BigInt(5 - digits);
  if (amount % factor !== 0n)
    throw error('Tip has more decimal places than this currency permits');
  return (amount / factor).toString();
}

function assertTip(draft, checkout, amountMinor, currency) {
  const native = draft.upfrontTipOption?.amount;
  if (
    !native ||
    protocol.eatsInteger64(native.amountE5) !== amountMinor ||
    native.currencyCode !== currency
  )
    throw error(
      'Uber did not retain the requested tip; no order has been placed',
      'EATS_TIP_UNVERIFIED',
    );
  const selected = checkout.selectedTip;
  if (selected) {
    if (
      protocol.eatsInteger64(selected.amountMinor) !== amountMinor ||
      selected.currency !== currency
    )
      throw error(
        'The displayed checkout tip differs from your requested amount',
        'EATS_TIP_UNVERIFIED',
      );
  } else {
    // Native UI leaves every tip option unselected for zero. Confirm both the
    // retained zero and equality of the server's pre-tip and final totals.
    const baseRows =
      checkout.fareBreakdown?.charges?.filter(
        (charge) =>
          charge.fareBreakdownChargeMetadata?.fareInfoID ===
          'eats_fare.presentation_total',
      ) ?? [];
    const amounts =
      baseRows.length === 1
        ? (baseRows[0].fareBreakdownChargeMetadata.analyticsInfo?.filter(
            (entry) =>
              entry.fareInfoID === 'eats_fare.presentation_total' &&
              entry.currencyAmount?.currencyCode === currency,
          ) ?? [])
        : [];
    const zeroConfirmed =
      amountMinor === '0' &&
      amounts.length === 1 &&
      protocol.eatsInteger64(amounts[0].currencyAmount.amountE5) ===
        checkout.total.amountE5;
    if (
      !zeroConfirmed &&
      !(amountMinor === '0' && draft.diningMode === 'PICKUP')
    )
      throw error(
        'Uber did not confirm the displayed tip amount',
        'EATS_TIP_UNVERIFIED',
      );
  }
}

function error(message, code = 'EATS_INVALID_ARGUMENT') {
  return Object.assign(new Error(message), { code });
}

export function eatsTargetHeaders(location) {
  if (
    !Number.isFinite(location?.latitude) ||
    Math.abs(location.latitude) > 90 ||
    !Number.isFinite(location?.longitude) ||
    Math.abs(location.longitude) > 180
  )
    throw error('A valid order location is required');
  return {
    'x-uber-target-location-latitude': String(location.latitude),
    'x-uber-target-location-longitude': String(location.longitude),
  };
}

function mode(value = 'delivery') {
  const result = value.toUpperCase();
  if (!['DELIVERY', 'PICKUP'].includes(result))
    throw error('Choose delivery or pickup');
  return result;
}

function assertOwner(draft, session) {
  if (draft.eaterId !== session.userUUID)
    throw error('Cart belongs to a different account');
  if (draft.state !== 'UNORDERED')
    throw error('Only an unordered cart can be edited');
}

function assertSimpleDraft(draft, owner) {
  const nonempty = (value) =>
    Array.isArray(value)
      ? value.length > 0
      : object(value)
        ? Object.keys(value).length > 0
        : value != null;
  if (
    (draft.orderCategory && draft.orderCategory !== 'DEFAULT') ||
    [
      draft.billSplitOption,
      draft.businessDetails,
      draft.bundleGroupInfo,
      draft.repeatSchedule,
      draft.targetDeliveryTimeRange,
      draft.spendingLimit,
    ].some(nonempty) ||
    (draft.extraPaymentProfiles?.length ?? 0) > 0 ||
    (draft.participantDetails?.length ?? 0) > 1 ||
    draft.shoppingCart?.participants?.some(
      (participant) => participant.userUUID !== owner,
    )
  )
    throw error(
      'Group, business, scheduled, bundled and split-payment carts require a supported specialized checkout',
      'EATS_CART_UNSUPPORTED',
    );
}

/** Validate selected options against the fresh native item, including nested groups. */
export function validateEatsSelections(detail, selections = []) {
  if (
    detail.itemDetail?.isSoldOut === true ||
    detail.itemDetail?.isAvailable === false
  )
    throw error('This item is unavailable');
  const visit = (groups, chosen, depth = 0) => {
    if (depth > 12 || !Array.isArray(chosen))
      throw error('Invalid modifier selections');
    const byId = new Map();
    for (const group of chosen) {
      if (!object(group) || byId.has(group.uuid))
        throw error('Duplicate or invalid modifier group');
      byId.set(group.uuid, group);
    }
    const known = new Set(groups.map((group) => group.groupId));
    if ([...byId.keys()].some((id) => !known.has(id)))
      throw error('Unknown modifier group');
    for (const group of groups) {
      const selected = byId.get(group.groupId)?.childOptions?.options ?? [];
      if (!Array.isArray(selected)) throw error('Invalid modifier options');
      const options = new Map(
        group.options.map((option) => [option.optionId, option]),
      );
      const ids = new Set();
      let count = 0;
      for (const option of selected) {
        const available = options.get(option.uuid);
        if (
          !available ||
          ids.has(option.uuid) ||
          !Number.isSafeInteger(option.quantity) ||
          option.quantity < 0
        )
          throw error('Unknown, duplicate or invalid modifier option');
        ids.add(option.uuid);
        count += option.quantity;
        if (
          option.quantity > 0 &&
          (available.isAvailable === false || available.isSoldOut === true)
        )
          throw error(
            `This modifier is unavailable: ${available.name ?? option.uuid}`,
          );
        if (
          option.quantity > 0 &&
          available.minPermitted !== undefined &&
          option.quantity < available.minPermitted
        )
          throw error(
            `Too few selections for ${available.name ?? option.uuid}`,
          );
        if (
          available.maxPermitted !== undefined &&
          option.quantity > available.maxPermitted
        )
          throw error(
            `Too many selections for ${available.name ?? option.uuid}`,
          );
        if (option.quantity > 0)
          visit(
            available.childGroups ?? [],
            option.customizationV2List ?? [],
            depth + 1,
          );
      }
      if (group.minPermitted !== undefined && count < group.minPermitted)
        throw error(
          `Select at least ${group.minPermitted} option(s) for ${group.name ?? group.groupId}`,
        );
      if (group.maxPermitted !== undefined && count > group.maxPermitted)
        throw error(
          `Select at most ${group.maxPermitted} option(s) for ${group.name ?? group.groupId}`,
        );
      if (
        count > 0 &&
        (group.isAvailable === false || group.isSoldOut === true)
      )
        throw error(
          `This modifier group is unavailable: ${group.name ?? group.groupId}`,
        );
    }
  };
  visit(detail.modifierGroups ?? [], selections);
}

function snapshot(draft, checkout) {
  const selection = { ...draft };
  for (const key of ['fare', 'lastEditedAt', 'lastModifiedTimestamp'])
    delete selection[key];
  return {
    draft: selection,
    total: checkout.total,
    tip: draft.upfrontTipOption,
  };
}

function assertCheckoutReady(checkout) {
  if (!checkout.total || BigInt(checkout.total.amountE5) < 0n)
    throw error('A complete checkout total is required');
  // Extra acknowledgements/payment challenges need an explicitly implemented
  // response flow. Never silently accept restrictions on behalf of a customer.
  for (const value of [
    checkout.orderConfirmations,
    checkout.restrictedItems,
    checkout.paymentAuthInfo,
  ]) {
    if (
      value !== undefined &&
      value !== null &&
      !(Array.isArray(value) && value.length === 0) &&
      !(object(value) && Object.keys(value).length === 0)
    )
      throw error(
        'This checkout requires additional confirmation or payment verification',
        'EATS_ACTION_REQUIRED',
      );
  }
}

export function createEatsService({
  operation = authenticatedOperation,
  read = readState,
  write = saveState,
  uuid = randomUUID,
  now = Date.now,
} = {}) {
  return async function execute(command, values = {}) {
    if (command === 'operation')
      return inspectOperation(values['operation-id'], { read });
    return operation(async ({ session, send }) => {
      if (!session.userUUID)
        throw error('Sign in again to initialize your account identity');
      const target = values.near ? coordinate(values.near) : undefined;
      const diningMode = mode(values.mode);
      const rawOr = (raw, normalize) => (values.raw ? raw : normalize(raw));
      const locatedSend =
        (location) =>
        (endpoint, body, options = {}) =>
          send(endpoint, body, {
            ...options,
            extraHeaders: {
              ...eatsTargetHeaders(location),
              ...options.extraHeaders,
            },
          });
      const listDrafts = async () => {
        const response = await send(`${edge}get-draft-orders-by-eater-uuid`, {
          request: { eaterUUID: session.userUUID, limit: 30 },
        });
        protocol.assertEatsValidation(response);
        if (!Array.isArray(response.draftOrders))
          throw error('No draft list returned', 'EATS_RESPONSE_INVALID');
        return response;
      };
      const getDraft = async (id) => {
        requireUUID(id, 'Draft ID');
        const response = await send(`${edge}get-draft-order-by-uuid`, {
          request: {
            draftOrderUUID: id,
            shouldReturnCustomerInfos: true,
            shouldReturnFareInfo: true,
            shouldReturnShoppingCart: true,
          },
        });
        const draft = protocol.normalizeEatsDraft(response);
        assertOwner(draft, session);
        assertSimpleDraft(response.draftOrder, session.userUUID);
        return { response, draft };
      };
      const getMenu = async (storeId, location, selectedMode, offset = 0) => {
        requireUUID(storeId, 'Store ID');
        const query = new URLSearchParams({
          diningMode: selectedMode,
          targetLocationLatitude: String(location.latitude),
          targetLocationLongitude: String(location.longitude),
          catalogSectionOffset: String(offset),
        });
        return locatedSend(location)(
          `/rt/eats/v2/eater-store/${storeId}?${query}`,
          undefined,
          { method: 'GET' },
        );
      };
      const getItem = async (
        storeId,
        itemId,
        sectionId,
        location,
        selectedMode,
      ) => {
        requireUUID(storeId, 'Store ID');
        requireUUID(itemId, 'Item ID');
        requireUUID(sectionId, 'Section ID');
        const response = await locatedSend(location)(
          '/rt/eats/v1/eater-items',
          {
            request: {
              storeUuid: storeId,
              itemUuids: [itemId],
              sectionUuid: sectionId,
              eaterUUID: session.userUUID,
              deliveryLatitude: location.latitude,
              deliveryLongitude: location.longitude,
              diningMode: selectedMode,
              itemRequestType: 'ITEM',
              itemRequestOptions: { includeCustomizationAttributes: true },
            },
          },
        );
        return {
          response,
          detail: normalizeEatsItemDetail(response, itemId, {
            storeId,
            sectionId,
          }),
        };
      };
      let cartInputSignature;
      const mutate = async (
        endpoint,
        body,
        location,
        validate = protocol.assertEatsValidation,
      ) => {
        const id = values['operation-id'] ?? uuid();
        const response = await executeMutation(
          {
            id,
            kind: 'eats-cart',
            endpoint,
            body,
            validate,
            context: {
              userUUID: session.userUUID,
              draftId: values['draft-id'],
              inputSignature: cartInputSignature,
            },
          },
          locatedSend(location),
          { read, write },
        );
        return { response, operationId: id };
      };
      const checkoutFor = async (draft, verifyDraft = false) => {
        const response = await locatedSend(draft.deliveryAddress)(
          `${edge}checkout-mobile-presentation`,
          protocol.eatsCheckoutPresentationRequest({ draftId: draft.draftId }),
        );
        const checkout = protocol.normalizeEatsCheckout(response);
        if (verifyDraft) {
          const matches = response.draftOrders?.filter(
            (entry) => entry.uuid === draft.draftId,
          );
          if (!Array.isArray(matches) || matches.length !== 1)
            throw error(
              'Checkout did not identify the selected cart',
              'EATS_RESPONSE_INVALID',
            );
          const presented = protocol.normalizeEatsDraft({
            draftOrder: matches[0],
          });
          assertOwner(presented, session);
          assertSimpleDraft(matches[0], session.userUUID);
          if (
            digest(snapshot(presented, checkout)) !==
            digest(snapshot(draft, checkout))
          )
            throw error(
              'Cart changed while fetching checkout. Review a fresh checkout.',
              'EATS_PLAN_CHANGED',
            );
        }
        return { response, checkout };
      };
      const paymentFor = async (id) => {
        requireUUID(id, 'Payment profile ID');
        const payments = normalizePaymentProfiles(
          await fetchPaymentProfiles(send),
        );
        const payment = payments.profiles.find((entry) => entry.id === id);
        if (!payment || payment.status !== 'active' || payment.expired === true)
          throw error(
            'Select an active, unexpired payment method using uber payments',
          );
        return payment;
      };

      if (command === 'locations') {
        const drafts = await listDrafts();
        const recent = new Map();
        for (const draft of drafts.draftOrders) {
          if (draft.eaterUUID !== session.userUUID || !draft.deliveryAddress)
            continue;
          const address = draft.deliveryAddress;
          recent.set(JSON.stringify(address), clone(address));
        }
        const bootstrap = await send(
          '/rt/eats/v1/get-delivery-bootstrap-context',
          {
            request: {
              callSource: 'ORIGIN_CALL_SOURCE_OTHER',
              ...(target ? { defaultDeliveryLocation: target } : {}),
            },
          },
          target ? { extraHeaders: eatsTargetHeaders(target) } : {},
        );
        return values.raw
          ? { bootstrap, drafts }
          : {
              deliveryLocation: bootstrap.deliveryLocation,
              recentDeliveryAddresses: [...recent.values()],
              source: 'Current bootstrap and existing unordered carts',
            };
      }
      if (command === 'search') {
        const offset = values.offset ?? 0,
          limit = values.limit ?? 20;
        const response = await locatedSend(target)('/rt/eats/v2/search', {
          targetLocation: target,
          userQuery: values.query,
          diningMode,
          searchType: 'GLOBAL_SEARCH',
          searchSource: 'SEARCH_BAR',
          pageInfo: { offset, pageSize: limit },
        });
        return values.raw
          ? response
          : {
              ...normalizeEatsSearch(response),
              request: {
                query: values.query,
                near: target,
                diningMode,
                offset,
                limit,
              },
              nextOffset:
                response.reachedEndOfList === false ? offset + limit : null,
            };
      }
      if (command === 'menu') {
        const storeId = values['store-id'];
        if (values['item-id']) {
          let sectionId = values['section-id'];
          if (!sectionId) {
            const menu = normalizeEatsMenu(
              await getMenu(storeId, target, diningMode),
            );
            const items = menu.sections.flatMap(
              (section) => section.items ?? [],
            );
            sectionId = items.find(
              (item) => item.itemId === values['item-id'],
            )?.sectionId;
          }
          if (!sectionId)
            throw error('Use the section ID returned with this menu item');
          const { response, detail } = await getItem(
            storeId,
            values['item-id'],
            sectionId,
            target,
            diningMode,
          );
          return values.raw ? response : detail;
        }
        return rawOr(
          await getMenu(storeId, target, diningMode, values.offset ?? 0),
          normalizeEatsMenu,
        );
      }
      if (command === 'cart') {
        const action = values.action ?? 'list';
        cartInputSignature = digest({
          action,
          draftId: values['draft-id'],
          lineId: values['line-id'],
          storeId: values['store-id'],
          request: values.request,
        });
        if (values['operation-id']) {
          requireUUID(values['operation-id'], 'Operation ID');
          const previous = await read(`operation-${values['operation-id']}`);
          if (previous) {
            if (
              previous.kind !== 'eats-cart' ||
              previous.context?.userUUID !== session.userUUID ||
              previous.context.inputSignature !== cartInputSignature
            )
              throw error(
                'Operation ID belongs to a different account or cart request',
              );
            if (previous.state === 'accepted')
              return {
                operationId: previous.id,
                status: 'accepted',
                recovered: true,
                result: clone(previous.response),
                next: 'Inspect the current cart with cart get or cart list.',
              };
            throw Object.assign(
              error(
                'This cart operation is already recorded; inspect it before making another change',
                previous.state === 'rejected'
                  ? 'operation_rejected'
                  : 'outcome_unknown',
              ),
              { operationId: previous.id },
            );
          }
        }
        if (action === 'list')
          return rawOr(await listDrafts(), (response) => ({
            carts: response.draftOrders.map((draft) =>
              protocol.normalizeEatsDraft({ draftOrder: draft }),
            ),
          }));
        if (action === 'get')
          return rawOr(
            (await getDraft(values['draft-id'])).response,
            protocol.normalizeEatsDraft,
          );
        const request = values.request ?? {};
        const allowed =
          action === 'create'
            ? [
                'storeId',
                'deliveryAddress',
                'diningMode',
                'paymentProfileId',
                'items',
              ]
            : action === 'add'
              ? ['items']
              : [
                  'lineId',
                  'quantity',
                  'specialInstructions',
                  'customizations',
                  'customizationV2s',
                ];
        if (
          !object(request) ||
          Object.keys(request).some((key) => !allowed.includes(key))
        )
          throw error(
            'The cart request contains unsupported fields for this action',
          );
        if (
          request.customizations !== undefined &&
          request.customizationV2s !== undefined
        )
          throw error('Supply one customization selection field');
        if (
          values['line-id'] &&
          request.lineId &&
          values['line-id'] !== request.lineId
        )
          throw error('Conflicting cart line identifiers');
        let draft;
        if (action !== 'create')
          draft = (await getDraft(values['draft-id'])).draft;
        const location = draft?.deliveryAddress ?? request.deliveryAddress;
        eatsTargetHeaders(location);
        const storeId = draft?.storeId ?? values['store-id'] ?? request.storeId;
        requireUUID(storeId, 'Store ID');
        if (draft && values['store-id'] && values['store-id'] !== draft.storeId)
          throw error('The selected store does not match this cart');
        if (
          !draft &&
          values['store-id'] &&
          request.storeId &&
          values['store-id'] !== request.storeId
        )
          throw error('Conflicting store identifiers');
        const selectedMode =
          draft?.diningMode ?? mode(request.diningMode ?? 'delivery');
        let body, endpoint;
        if (action === 'create' || action === 'add') {
          if (!Array.isArray(request.items) || !request.items.length)
            throw error('Supply at least one item');
          if (action === 'create') {
            const existing = (await listDrafts()).draftOrders.find(
              (entry) =>
                entry.restaurantUUID === storeId && entry.state === 'UNORDERED',
            );
            if (existing)
              throw error(
                `An existing cart for this restaurant must be reviewed first: ${existing.uuid}`,
                'EATS_CART_EXISTS',
              );
          }
          const items = [];
          for (const item of request.items) {
            const { detail } = await getItem(
              storeId,
              item.itemId,
              item.sectionId,
              location,
              selectedMode,
            );
            if (
              item.choices !== undefined &&
              (item.customizationV2s !== undefined ||
                item.customizations !== undefined)
            )
              throw error(
                'Use named choices or native customizations, not both',
              );
            const selections =
              item.choices !== undefined
                ? resolveEatsChoices(detail, item.choices)
                : (item.customizationV2s ?? item.customizations ?? []);
            validateEatsSelections(detail, selections);
            items.push(
              protocol.eatsCartItem({
                ...item,
                lineId: uuid(),
                storeId,
                title: detail.name,
                customizations: selections,
              }),
            );
          }
          body =
            action === 'create'
              ? protocol.eatsCreateDraftRequest({
                  eaterId: session.userUUID,
                  storeId,
                  items,
                  deliveryAddress: location,
                  diningMode: selectedMode,
                  paymentProfileId: request.paymentProfileId,
                  deliveryType: 'ASAP',
                })
              : protocol.eatsAddItemsRequest({
                  draftId: draft.draftId,
                  eaterId: session.userUUID,
                  cartId: draft.cartId,
                  storeId,
                  items,
                });
          endpoint =
            action === 'create'
              ? 'create-draft-order'
              : 'add-items-to-draft-order';
        } else if (action === 'update') {
          const lineId = values['line-id'] ?? request.lineId;
          const line = draft.items.find(
            (item) => item.shoppingCartItemUUID === lineId,
          );
          if (!line) throw error('Choose a line belonging to this cart');
          const { detail } = await getItem(
            storeId,
            line.skuUUID,
            line.sectionUUID,
            location,
            selectedMode,
          );
          const customizations =
            request.customizations ?? request.customizationV2s;
          validateEatsSelections(
            detail,
            customizations ?? line.customizationV2s ?? [],
          );
          body = protocol.eatsUpdateItemRequest({
            draftId: draft.draftId,
            eaterId: session.userUUID,
            cartId: draft.cartId,
            storeId,
            lineId,
            quantity: request.quantity,
            customizations,
            specialInstructions: request.specialInstructions,
          });
          endpoint = 'update-item-in-draft-order';
        } else if (action === 'remove') {
          const lineId = values['line-id'];
          if (!draft.items.some((item) => item.shoppingCartItemUUID === lineId))
            throw error('Choose a line belonging to this cart');
          body = protocol.eatsRemoveItemsRequest({
            draftId: draft.draftId,
            eaterId: session.userUUID,
            cartId: draft.cartId,
            storeId,
            lineIds: [lineId],
          });
          endpoint = 'remove-items-from-draft-order';
        } else if (action === 'discard') {
          body = { request: { draftOrderUUIDs: [draft.draftId] } };
          endpoint = 'discard-draft-orders';
        } else throw error('Unsupported cart action');
        const result = await mutate(`${edge}${endpoint}`, body, location);
        if (action === 'discard')
          return {
            discarded: true,
            draftId: draft.draftId,
            operationId: result.operationId,
          };
        const draftId = draft?.draftId ?? result.response.draftOrder?.uuid;
        if (!draftId)
          throw Object.assign(
            error(
              'Cart changed but no draft identity was returned; inspect the operation and cart list',
              'EATS_RESPONSE_INVALID',
            ),
            { operationId: result.operationId },
          );
        const fresh = await getDraft(draftId);
        return {
          ...(values.raw
            ? { response: result.response, draft: fresh.response }
            : { cart: fresh.draft }),
          operationId: result.operationId,
        };
      }
      if (command === 'checkout') {
        let { draft } = await getDraft(values['draft-id']);
        if (!draft.items.length) throw error('The cart is empty');
        const initial = await checkoutFor(draft);
        const tipE5 = eatsDecimalE5(values['tip-amount']);
        const first = draft.items[0];
        const { response: itemResponse } = await getItem(
          draft.storeId,
          first.skuUUID,
          first.sectionUUID,
          draft.deliveryAddress,
          draft.diningMode,
        );
        const currency = itemResponse.currencyInfo;
        if (currency?.currencyCode !== initial.checkout.total.currency)
          throw error(
            'Menu and checkout currency do not match',
            'EATS_RESPONSE_INVALID',
          );
        const tipMinor = eatsDecimalMinor(
          values['tip-amount'],
          currency.currencyNumDigitsAfterDecimal,
        );
        const payment = await paymentFor(
          values['payment-profile-id'] ?? draft.paymentProfileId,
        );
        // Updating the draft selects a tip/payment; it does not place an order.
        await mutate(
          `${edge}update-draft-order`,
          protocol.eatsUpdateDraftRequest({
            draftId: draft.draftId,
            paymentProfileId: payment.id,
            tipAmountMinor: tipMinor,
            tipCurrencyCode: currency.currencyCode,
          }),
          draft.deliveryAddress,
        );
        ({ draft } = await getDraft(draft.draftId));
        if (draft.paymentProfileId !== payment.id)
          throw error('Uber did not retain the selected payment method');
        const { response, checkout } = await checkoutFor(draft, true);
        assertCheckoutReady(checkout);
        assertTip(draft, checkout, tipMinor, currency.currencyCode);
        const review = {
          cart: draft,
          total: checkout.total,
          tip: { amountE5: tipE5, currency: checkout.total.currency },
          payment,
          fees: checkout.fareBreakdown,
          eta: checkout.eta,
          location: checkout.location,
          disclaimers: checkout.disclaimers,
        };
        const plan = await savePlan(
          'eats-order',
          session,
          {
            draftId: draft.draftId,
            signature: digest(snapshot(draft, checkout)),
            tipMinor,
            tipCurrency: currency.currencyCode,
            review,
            request: protocol.eatsPlaceOrderRequest({
              draftId: draft.draftId,
              storeInstructions:
                typeof draft.storeInstructions === 'string'
                  ? draft.storeInstructions
                  : undefined,
              singleUseItems: draft.isSingleUseItemsIncluded,
              interactionType: draft.interactionType,
            }),
          },
          { ttlMs: 90000, write },
        );
        return {
          status: 'confirmation_required',
          planId: plan.id,
          operationId: plan.operationId,
          expiresAt: new Date(plan.expiresAt).toISOString(),
          ...review,
          ...(values.raw ? { checkout: response } : {}),
          next: `uber eats order --action confirm --plan-id ${plan.id} --confirm`,
        };
      }
      if (command === 'order') {
        if (values.action === 'confirm') {
          if (values.confirm !== true)
            throw error('Explicit --confirm is required');
          const plan = await loadPlan(
            values['plan-id'],
            'eats-order',
            session,
            { read, now: now() },
          );
          const previous = await read(`operation-${plan.operationId}`);
          if (previous?.state === 'accepted') {
            const result = protocol.normalizeEatsOrderResult(previous.response);
            return {
              ...result,
              operationId: plan.operationId,
              tracking: eatsTrackingCommands(
                result.workflowId ?? result.draftId,
              ),
            };
          }
          if (previous)
            throw Object.assign(
              error(
                'Order outcome is already recorded; inspect its operation before taking another action',
                'outcome_unknown',
              ),
              { operationId: plan.operationId },
            );
          const { draft } = await getDraft(plan.draftId);
          const { checkout } = await checkoutFor(draft, true);
          assertCheckoutReady(checkout);
          assertTip(draft, checkout, plan.tipMinor, plan.tipCurrency);
          if (digest(snapshot(draft, checkout)) !== plan.signature)
            throw error(
              'Cart, location, payment, tip or total changed. Prepare a fresh checkout for approval.',
              'EATS_PLAN_CHANGED',
            );
          await paymentFor(draft.paymentProfileId);
          if (now() >= plan.expiresAt)
            throw error(
              'Plan expired; prepare checkout again for approval',
              'EATS_PLAN_EXPIRED',
            );
          const response = await executeMutation(
            {
              id: plan.operationId,
              kind: 'eats-order',
              endpoint: `${edge}checkout-orders-by-draft-orders`,
              body: plan.request,
              validate: protocol.normalizeEatsOrderResult,
              beforeSend: () => {
                if (now() >= plan.expiresAt)
                  throw error(
                    'Plan expired before order submission; prepare checkout again',
                    'EATS_PLAN_EXPIRED',
                  );
              },
              context: {
                userUUID: session.userUUID,
                draftId: draft.draftId,
                review: plan.review,
              },
            },
            locatedSend(draft.deliveryAddress),
            { read, write },
          );
          const result = protocol.normalizeEatsOrderResult(response);
          for (const orderId of new Set(
            [result.orderId, result.workflowId].filter(Boolean),
          ))
            await write(`eats-order-${orderId}`, {
              userUUID: session.userUUID,
              orderId,
              location: draft.deliveryAddress,
              storeId: draft.storeId,
              operationId: plan.operationId,
            });
          return {
            ...result,
            operationId: plan.operationId,
            tracking: eatsTrackingCommands(result.workflowId ?? result.draftId),
          };
        }
        if (values.action === 'history') {
          const query = new URLSearchParams({
            limit: String(values.limit ?? 10),
          });
          if (values.cursor) query.set('cursor', values.cursor);
          return rawOr(
            await send(
              `/rt/eats/v1/eaters/${session.userUUID}/orders?${query}`,
              undefined,
              { method: 'GET' },
            ),
            normalizeEatsHistory,
          );
        }
        if (values.action === 'cancel') {
          const optionsPath = '/rt/eats/v1/orders/{uuid}/resolution/options';
          const actionsPath = '/rt/eats/v1/orders/{uuid}/resolution/actions';
          const getOptions = async (orderId, location) =>
            normalizeEatsCancellationOptions(
              await locatedSend(location)(
                optionsPath,
                eatsCancellationOptionsRequest(orderId),
              ),
              orderId,
            );
          const requireActive = async (orderId) => {
            const active = normalizeEatsActiveOrders(
              await send(`${edge}active-orders`, { request: {} }),
            );
            const matches = active.orders.filter((order) =>
              [order.orderId, order.uuid, order.orderUUID].includes(orderId),
            );
            if (matches.length !== 1)
              throw error(
                'This order is not uniquely present in active orders; no cancellation was sent',
                'EATS_CANCELLATION_UNAVAILABLE',
              );
          };
          if (!values['plan-id']) {
            const orderId = requireUUID(values['order-id'], 'Order ID');
            await requireActive(orderId);
            const context = await read(`eats-order-${orderId}`);
            const location =
              target ??
              (context?.userUUID === session.userUUID
                ? context.location
                : undefined);
            if (!location)
              throw error(
                'Provide --near LAT,LON using this order’s delivery address to prepare its cancellation',
              );
            const options = await getOptions(orderId, location);
            const plan = await savePlan(
              'eats-cancel',
              session,
              {
                orderId,
                location,
                terms: options.terms,
                signature: digest(options.terms),
              },
              { ttlMs: 60000, write },
            );
            return {
              status: 'confirmation_required',
              orderId,
              planId: plan.id,
              operationId: plan.operationId,
              expiresAt: new Date(plan.expiresAt).toISOString(),
              terms: plan.terms,
              next: `uber eats order --action cancel --plan-id ${plan.id} --confirm`,
            };
          }
          if (values.confirm !== true)
            throw error('Explicit --confirm is required');
          const plan = await loadPlan(
            values['plan-id'],
            'eats-cancel',
            session,
            { read, now: now() },
          );
          const previous = await read(`operation-${plan.operationId}`);
          if (previous) {
            if (previous.state === 'accepted')
              return {
                status: 'cancellation_submitted',
                orderId: plan.orderId,
                operationId: plan.operationId,
                recovered: true,
                next: 'Read order status and history to verify its terminal state.',
              };
            throw Object.assign(
              error(
                'Cancellation outcome is already recorded; inspect its operation',
                'outcome_unknown',
              ),
              { operationId: plan.operationId },
            );
          }
          await requireActive(plan.orderId);
          const options = await getOptions(plan.orderId, plan.location);
          if (digest(options.terms) !== plan.signature)
            throw error(
              'Cancellation terms changed; prepare a fresh cancellation for approval',
              'EATS_PLAN_CHANGED',
            );
          await executeMutation(
            {
              id: plan.operationId,
              kind: 'eats-cancellation',
              endpoint: actionsPath,
              body: eatsFulfillCancellationRequest(options.action),
              validate: (response) =>
                normalizeEatsCancellationResult(response, options.action),
              beforeSend: () => {
                if (now() >= plan.expiresAt)
                  throw error(
                    'Cancellation plan expired before submission',
                    'EATS_PLAN_EXPIRED',
                  );
              },
              context: {
                userUUID: session.userUUID,
                orderId: plan.orderId,
                terms: plan.terms,
              },
            },
            locatedSend(plan.location),
            { read, write },
          );
          const history = normalizeEatsHistory(
            await send(
              `/rt/eats/v1/eaters/${session.userUUID}/orders?limit=10`,
              undefined,
              { method: 'GET' },
            ),
          );
          const completed = history.orders.find(
            (order) => order.orderId === plan.orderId,
          );
          const cancelled =
            completed?.completionStatus?.completionState === 'EATER_CANCELLED';
          return {
            status: cancelled ? 'cancelled' : 'cancellation_submitted',
            orderId: plan.orderId,
            operationId: plan.operationId,
            terms: plan.terms,
            ...(completed
              ? { completionStatus: completed.completionStatus }
              : {}),
            ...(!cancelled
              ? {
                  next: 'Read order status and history to verify the terminal state; do not submit another cancellation.',
                }
              : {}),
          };
        }
        const response = await send(`${edge}active-orders`, { request: {} });
        if (values.raw) return response;
        const active = normalizeEatsActiveOrders(response);
        if (!values['order-id']) return active;
        requireUUID(values['order-id'], 'Order ID');
        const orders = active.orders.filter((order) =>
          [order.orderId, order.uuid, order.orderUUID].includes(
            values['order-id'],
          ),
        );
        if (orders.length > 1)
          throw error(
            'Uber returned ambiguous order identity',
            'EATS_RESPONSE_INVALID',
          );
        return {
          orders,
          activeOrderCount: orders.length,
          requestedOrderId: values['order-id'],
          ...(orders.length
            ? {}
            : {
                next: 'This order is absent from active orders. Inspect order history for its completion status.',
              }),
        };
      }
      throw error(`Unknown Eats command: ${command}`);
    });
  };
}

export const executeEats = createEatsService();
