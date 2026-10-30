import { validateEatsSelections } from './service.mjs';
const pick = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => value?.[key] !== undefined)
      .map((key) => [key, structuredClone(value[key])]),
  );
const itemKeys = [
  'itemId',
  'storeId',
  'sectionId',
  'subsectionId',
  'name',
  'description',
  'price',
  'priceLabel',
  'labels',
  'previewLabels',
  'isAvailable',
  'isSoldOut',
  'itemAvailabilityState',
  'hasCustomizations',
  'maxPermitted',
];
const item = (value) => pick(value, itemKeys);
const restaurant = (value) =>
  pick(value, [
    'storeId',
    'name',
    'isOrderable',
    'notOrderableMessage',
    'supportedDiningModes',
    'enabledFulfillmentTypes',
    'categories',
    'rating',
    'ratingCount',
    'ratingLabel',
    'etaRange',
    'etaLabel',
    'badges',
  ]);
const flags = {
  cartChanged: false,
  checkoutPrepared: false,
  orderPlaced: false,
  priceSource: 'menu_not_checkout',
  priceUnits:
    'Use formatted labels; unformatted native price fields have not been converted.',
};

function defaults(groups, depth = 0) {
  if (depth > 12) throw new Error('Customization nesting exceeds 12 levels');
  return groups.flatMap((group) => {
    const options = (group.options ?? [])
      .filter(
        (option) =>
          Number.isSafeInteger(option.defaultQuantity) &&
          option.defaultQuantity > 0,
      )
      .map((option) => ({
        uuid: option.optionId,
        quantity: option.defaultQuantity,
        customizationV2List: defaults(option.childGroups ?? [], depth + 1),
      }));
    return options.length
      ? [{ uuid: group.groupId, childOptions: { options } }]
      : [];
  });
}
// The normalized option tree is already compact. Keep every constraint/price.
function compactGroups(groups) {
  return structuredClone(groups);
}

export function eatsAgentView(command, result) {
  if (!result || typeof result !== 'object') return result;
  if (command === 'search')
    return {
      status: 'search_results_only',
      ...flags,
      restaurants: (result.restaurants ?? []).map((value) => ({
        ...restaurant(value),
        items: (value.items ?? []).map(item),
      })),
      ...pick(result, [
        'request',
        'nextOffset',
        'pagination',
        'unsupportedFeedTypes',
      ]),
      next: 'Offer a short shortlist or ask a useful preference question. Read the selected item with eats_menu before adding: search previews do not establish customization defaults, ingredients or final totals. Reuse identifiers and location; do not repeat completed searches.',
    };
  if (command === 'menu' && Array.isArray(result.modifierGroups)) {
    const response = {
      status: 'item_options_only',
      ...flags,
      ...item(result),
      ...pick(result, ['currencyInfo']),
      modifierGroups: compactGroups(result.modifierGroups),
      next: 'Choose required groups from these actual options. Prefer flat cart fields and named choices; copy standardItem for a standard recipe when provided; preserve literal preparation instructions. Otherwise fill the required choices using exact group/option IDs. Modifier quantities are per item, not multiplied by basket quantity. Use eats_cart with flat storeId/diningMode/deliveryAddress/items fields; no file or JSON string is needed. Only a successful cart response means added. Menu prices are not checkout totals.',
    };
    try {
      const standard = defaults(result.modifierGroups);
      validateEatsSelections(result, standard);
      response.cartItem = {
        ...pick(result, ['itemId', 'sectionId', 'subsectionId']),
        quantity: 1,
        specialInstructions: '',
        customizationV2s: standard,
      };
      response.standardItem = {
        ...pick(result, ['itemId', 'sectionId', 'subsectionId']),
        quantity: 1,
        specialInstructions: '',
        choices: [],
      };
      response.standardSelectionsVerified = true;
    } catch (error) {
      response.standardSelectionsVerified = false;
      response.defaultSelectionIssue = error.message;
    }
    return response;
  }
  if (command === 'menu' && Array.isArray(result.sections))
    return {
      status: 'menu_only',
      ...flags,
      restaurant: restaurant(result.restaurant),
      menus: result.menus,
      sections: result.sections.map((section) => ({
        ...pick(section, [
          'sectionId',
          'catalogSectionId',
          'name',
          'subtitle',
          'paginationEnabled',
        ]),
        items: (section.items ?? []).map(item),
      })),
      ...pick(result, ['pagination', 'unsupportedCatalogTypes']),
      next: 'Read the selected item and required choices with eats_menu itemId before creating or adding to a cart. Preserve all identifiers and paging context; do not infer ingredients or totals from names.',
    };
  return result;
}
