// Response paths are bound to native /rt/eats/v2/search and eater-store samples.
// Keep server amounts unchanged: a formatted price is safer than inferring units.
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value) => (Array.isArray(value) ? value : []);
const compact = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
const copy = (value) =>
  value === undefined ? undefined : structuredClone(value);

function text(value) {
  if (typeof value === 'string') return value;
  if (!object(value)) return undefined;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.accessibilityText === 'string')
    return value.accessibilityText;
  const parts = array(value.richTextElements)
    .map((part) => text(part?.text?.text))
    .filter((part) => part !== undefined);
  return parts.length ? parts.join('') : undefined;
}

function requireObject(value, label) {
  if (!object(value)) {
    const error = new Error(`Uber Eats returned no ${label}`);
    error.code = 'EATS_RESPONSE_INVALID';
    throw error;
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    const error = new Error(`Uber Eats returned no ${label}`);
    error.code = 'EATS_RESPONSE_INVALID';
    throw error;
  }
  return value;
}

function badges(values) {
  return array(values)
    .map(text)
    .filter((value) => value !== undefined);
}

function restaurant(store, card = {}) {
  return compact({
    storeId: card.storeUuid ?? store.uuid,
    name: text(card.title) ?? text(store.title),
    isOrderable: store.isOrderable,
    notOrderableMessage: store.notOrderableMessage,
    enabledFulfillmentTypes: copy(store.enabledFulfillmentTypes),
    supportedDiningModes: copy(store.supportedDiningModes),
    categories: array(store.categories)
      .map((category) => category.name)
      .filter((name) => typeof name === 'string'),
    priceBucket: store.priceBucket,
    rating: store.rawRatingStats?.storeRatingScore,
    ratingCount: store.rawRatingStats?.ratingCount,
    ratingLabel: text(store.ratingBadge ?? store.storeBadges?.ratingBadge),
    etaRange: copy(store.etaRange),
    etaLabel: text(store.storeBadges?.etaBadge),
    location: copy(store.location),
    fareInfo: copy(store.fareInfo),
    badges: [
      ...badges(card.meta),
      ...badges(card.meta2),
      ...badges(card.meta3),
    ],
  });
}

/** Normalize one native CatalogItem, preserving its complete modifier hierarchy. */
export function normalizeEatsItem(value, context = {}) {
  const item = requireObject(value, 'catalog item');
  return compact({
    itemId: item.uuid,
    storeId: item.storeUuid ?? context.storeId,
    sectionId: item.sectionUuid ?? context.sectionId,
    subsectionId: item.subsectionUuid ?? context.subsectionId,
    name: text(item.title) ?? text(item.headingPrimary),
    description: item.itemDescription,
    price: item.price,
    priceLabel: text(item.priceTagline),
    // Preserve ambiguous labels rather than guessing which contains the price.
    labels: [
      text(item.labelPrimary),
      text(item.labelSecondary),
      text(item.labelTertiary),
    ].filter((label) => label !== undefined),
    isAvailable: item.isAvailable,
    isSoldOut: item.isSoldOut,
    itemAvailabilityState: item.itemAvailabilityState,
    hasCustomizations: item.hasCustomizations,
    maxPermitted: item.maxPermitted,
    purchaseInfo: copy(item.purchaseInfo),
    catalogItemCustomizationData: copy(item.catalogItemCustomizationData),
  });
}

function modifierGroups(values) {
  return requireArray(values, 'item customization groups').map((value) => {
    const group = requireObject(value, 'item customization group');
    const options = requireArray(
      group.optionsList?.options,
      'item customization options',
    );
    return compact({
      groupId: group.uuid,
      name: text(group.title),
      minPermitted: group.minPermitted,
      maxPermitted: group.maxPermitted,
      defaultQuantity: group.defaultQuantity,
      isAvailable: group.isAvailable,
      isSoldOut: group.isSoldOut,
      options: options.map((value) => {
        const option = requireObject(value, 'item customization option');
        return compact({
          optionId: option.uuid,
          name: text(option.title),
          price: option.price,
          defaultQuantity: option.defaultQuantity,
          quantity: option.quantity,
          minPermitted: option.minPermitted,
          maxPermitted: option.maxPermitted,
          isAvailable: option.isAvailable,
          isSoldOut: option.isSoldOut,
          childGroups: modifierGroups(option.childCustomizationList ?? []),
        });
      }),
    });
  });
}

/** Native eater-items response: select the requested item, never an upsell. */
export function normalizeEatsItemDetail(response, itemId, context = {}) {
  const root = requireObject(response, 'item detail response');
  const items = requireObject(root.itemsMap, 'item detail map');
  if (typeof itemId !== 'string' || !Object.hasOwn(items, itemId)) {
    const error = new Error(
      'Uber Eats item detail did not include the requested item',
    );
    error.code = 'EATS_ITEM_NOT_FOUND';
    throw error;
  }
  const item = requireObject(items[itemId], 'requested item detail');
  if (item.uuid !== itemId) {
    const error = new Error(
      'Uber Eats item detail identifier does not match the requested item',
    );
    error.code = 'EATS_RESPONSE_INVALID';
    throw error;
  }
  const groups = item.customizationsList;
  if (groups == null && array(item.customizationUuids).length) {
    const error = new Error(
      'Uber Eats item detail omitted its customization groups',
    );
    error.code = 'EATS_RESPONSE_INVALID';
    throw error;
  }
  return compact({
    ...normalizeEatsItem(item, context),
    priceLabel: text(item.extraInfo) ?? text(item.priceTagline),
    currencyInfo: copy(root.currencyInfo),
    modifierGroups: modifierGroups(groups ?? []),
    // Keep every native constraint, default, classification and nested branch.
    // The convenience tree above must never be used to reconstruct a lossy DTO.
    itemDetail: copy(item),
  });
}

/** Search results follow feed order; storesMap also contains unranked cache entries. */
export function normalizeEatsSearch(value) {
  const response = requireObject(value, 'search response');
  const feed = requireObject(response.feed, 'search feed');
  const stores = object(feed.storesMap) ? feed.storesMap : {};
  const restaurants = [];
  const unsupportedFeedTypes = new Set();
  for (const entry of requireArray(feed.feedItems, 'search feed items')) {
    if (entry?.type === 'DIVIDER' || entry?.type === 'SECTION_HEADER') continue;
    const payload = entry?.payload?.miniStoreWithItemsPayload;
    if (!object(payload) || !object(payload.store)) {
      if (typeof entry?.type === 'string') unsupportedFeedTypes.add(entry.type);
      continue;
    }
    const card = payload.store;
    const storeId = card.storeUuid;
    const store = object(stores[storeId]) ? stores[storeId] : {};
    const catalogItems = array(payload.standardItemsPayload?.catalogItems);
    const previews = new Map(
      array(payload.items).map((item) => [item.uuid, item]),
    );
    const items = catalogItems.map((item) => {
      const normalized = normalizeEatsItem(item, { storeId });
      const preview = previews.get(item.uuid);
      if (preview) normalized.previewLabels = badges(preview.subtitles);
      return normalized;
    });
    // Some native results provide only compact previews, without CatalogItems.
    const catalogIds = new Set(catalogItems.map((item) => item.uuid));
    for (const preview of array(payload.items)) {
      if (catalogIds.has(preview.uuid)) continue;
      items.push(
        compact({
          itemId: preview.uuid,
          storeId,
          name: text(preview.title),
          previewLabels: badges(preview.subtitles),
        }),
      );
    }
    restaurants.push({ ...restaurant(store, card), items });
  }
  return {
    restaurants,
    pagination: compact({
      reachedEndOfList: response.reachedEndOfList ?? feed.reachedEndOfList,
      cursors: copy(feed.cursors),
    }),
    unsupportedFeedTypes: [...unsupportedFeedTypes],
  };
}

/** Retain section grouping and server paging metadata without guessing cursors. */
export function normalizeEatsMenu(value) {
  const response = requireObject(value, 'menu response');
  const store = requireObject(response.store, 'menu store');
  const catalogMap = requireObject(store.catalogSectionsMap, 'menu catalog');
  const sections = [];
  const unsupportedCatalogTypes = new Set();
  for (const [sectionId, entries] of Object.entries(catalogMap)) {
    for (const entry of requireArray(entries, 'menu catalog section entries')) {
      const payload = entry?.payload?.standardItemsPayload;
      if (!object(payload)) {
        if (typeof entry?.type === 'string')
          unsupportedCatalogTypes.add(entry.type);
        continue;
      }
      sections.push(
        compact({
          sectionId: payload.sectionUUID ?? sectionId,
          catalogSectionId: entry.catalogSectionUUID,
          name: text(payload.title) ?? text(payload.titleV2),
          subtitle: text(payload.subtitle) ?? text(payload.subtitleV2),
          paginationEnabled: payload.paginationEnabled,
          items: array(payload.catalogItems).map((item) =>
            normalizeEatsItem(item, {
              storeId: store.uuid,
              sectionId: payload.sectionUUID ?? sectionId,
              subsectionId: entry.catalogSectionUUID,
            }),
          ),
        }),
      );
    }
  }
  return {
    restaurant: restaurant(store),
    menus: array(store.sections).map((section) =>
      compact({
        sectionId: section.uuid,
        name: text(section.title),
        subtitle: text(section.subtitle),
        subsectionIds: copy(section.subsectionUuids),
        isOnSale: section.isOnSale,
        isTop: section.isTop,
      }),
    ),
    sections,
    pagination: copy(store.catalogSectionPagingInfo) ?? {},
    unsupportedCatalogTypes: [...unsupportedCatalogTypes],
  };
}
