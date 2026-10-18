import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEatsSearch,
  normalizeEatsMenu,
  normalizeEatsItem,
  normalizeEatsItemDetail,
} from '../src/eats/discovery.mjs';

test('search follows ranked native cards rather than the oversized store cache', () => {
  const response = {
    reachedEndOfList: false,
    feed: {
      storesMap: {
        unused: { uuid: 'unused', title: 'Unranked cached restaurant' },
        second: { uuid: 'second', title: 'Cached second', isOrderable: false },
        first: {
          uuid: 'first',
          title: 'Cached first',
          rawRatingStats: { storeRatingScore: 4.8 },
        },
      },
      feedItems: [
        { type: 'SECTION_HEADER' },
        {
          type: 'MINI_STORE_WITH_ITEMS',
          payload: {
            miniStoreWithItemsPayload: {
              store: {
                storeUuid: 'second',
                title: { text: 'Second' },
                meta: [{ text: '20 min' }],
              },
              items: [
                {
                  uuid: 'dish',
                  title: { text: 'Coffee' },
                  subtitles: [{ text: '$4.50' }],
                },
              ],
              standardItemsPayload: {
                catalogItems: [
                  {
                    uuid: 'dish',
                    title: 'Coffee',
                    sectionUuid: 'breakfast',
                    hasCustomizations: true,
                  },
                ],
              },
            },
          },
        },
        { type: 'DIVIDER' },
        {
          type: 'MINI_STORE_WITH_ITEMS',
          payload: {
            miniStoreWithItemsPayload: {
              store: { storeUuid: 'first', title: { text: 'First' } },
              items: [
                {
                  uuid: 'preview-only',
                  title: { text: 'Toast' },
                  subtitles: [{ text: '$3' }],
                },
              ],
            },
          },
        },
      ],
    },
  };
  const result = normalizeEatsSearch(response);
  assert.deepEqual(
    result.restaurants.map((r) => r.storeId),
    ['second', 'first'],
  );
  assert.equal(result.restaurants[0].isOrderable, false);
  assert.equal(result.restaurants[0].items[0].sectionId, 'breakfast');
  assert.deepEqual(result.restaurants[0].items[0].previewLabels, ['$4.50']);
  assert.equal(result.restaurants[1].items[0].itemId, 'preview-only');
  assert.equal(result.pagination.reachedEndOfList, false);
  assert.equal(result.restaurants[1].rating, 4.8);
});

test('item details select the exact requested item and preserve full recursive constraints', () => {
  const item = {
    uuid: 'latte',
    title: 'Latte',
    price: 450,
    extraInfo: { text: '$4.50' },
    sectionUuid: 'breakfast',
    customizationsList: [
      {
        uuid: 'milk',
        title: 'Milk',
        minPermitted: 1,
        maxPermitted: 1,
        futureConstraint: { mutuallyExclusiveWith: ['cream'] },
        optionsList: {
          options: [
            {
              uuid: 'whole',
              title: 'Whole milk',
              price: 0,
              defaultQuantity: 0,
              maxPermitted: 1,
              childCustomizationList: [
                {
                  uuid: 'temperature',
                  title: 'Temperature',
                  minPermitted: 1,
                  maxPermitted: 1,
                  optionsList: {
                    options: [
                      {
                        uuid: 'hot',
                        title: 'Hot',
                        defaultQuantity: 1,
                        childCustomizationList: [],
                        unsupportedRule: { keep: true },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    nutritionalInfo: { allergens: ['milk'] },
  };
  const response = {
    itemsMap: { upsell: { uuid: 'upsell', title: 'Other' }, latte: item },
    currencyInfo: { currencyCode: 'USD', currencyNumDigitsAfterDecimal: 2 },
  };
  const result = normalizeEatsItemDetail(response, 'latte', {
    storeId: 'cafe',
  });
  assert.equal(result.itemId, 'latte');
  assert.equal(result.storeId, 'cafe');
  assert.equal(result.sectionId, 'breakfast');
  assert.equal(result.priceLabel, '$4.50');
  assert.deepEqual(result.currencyInfo, response.currencyInfo);
  assert.equal(result.modifierGroups[0].groupId, 'milk');
  assert.equal(result.modifierGroups[0].minPermitted, 1);
  assert.equal(result.modifierGroups[0].options[0].price, 0);
  assert.equal(result.modifierGroups[0].options[0].defaultQuantity, 0);
  assert.equal(
    result.modifierGroups[0].options[0].childGroups[0].options[0].optionId,
    'hot',
  );
  assert.deepEqual(result.itemDetail, item);
  result.itemDetail.customizationsList[0].futureConstraint.mutuallyExclusiveWith.push(
    'other',
  );
  assert.deepEqual(
    item.customizationsList[0].futureConstraint.mutuallyExclusiveWith,
    ['cream'],
  );
});

test('item detail refuses missing identifiers and missing required customization data', () => {
  assert.throws(
    () =>
      normalizeEatsItemDetail(
        { itemsMap: { other: { uuid: 'other' } } },
        'missing',
      ),
    { code: 'EATS_ITEM_NOT_FOUND' },
  );
  assert.throws(
    () =>
      normalizeEatsItemDetail(
        { itemsMap: { requested: { uuid: 'other' } } },
        'requested',
      ),
    { code: 'EATS_RESPONSE_INVALID' },
  );
  assert.throws(
    () =>
      normalizeEatsItemDetail(
        {
          itemsMap: {
            requested: { uuid: 'requested', customizationUuids: ['required'] },
          },
        },
        'requested',
      ),
    { code: 'EATS_RESPONSE_INVALID' },
  );
  assert.throws(
    () =>
      normalizeEatsItemDetail(
        {
          itemsMap: {
            requested: {
              uuid: 'requested',
              customizationsList: [{ uuid: 'group', optionsList: {} }],
            },
          },
        },
        'requested',
      ),
    { code: 'EATS_RESPONSE_INVALID' },
  );
  assert.deepEqual(
    normalizeEatsItemDetail(
      { itemsMap: { plain: { uuid: 'plain', customizationsList: [] } } },
      'plain',
    ).modifierGroups,
    [],
  );
});

test('search preserves server cursor and reports unsupported content instead of fabricating results', () => {
  const result = normalizeEatsSearch({
    feed: {
      storesMap: { one: { title: 'Not a result' } },
      feedItems: [{ type: 'NEW_UNSUPPORTED_LAYOUT' }],
      reachedEndOfList: true,
      cursors: { type: 'string', cursors: { bottom: 'opaque/+=' } },
    },
  });
  assert.deepEqual(result.restaurants, []);
  assert.equal(result.pagination.cursors.cursors.bottom, 'opaque/+=');
  assert.equal(result.pagination.reachedEndOfList, true);
  assert.deepEqual(result.unsupportedFeedTypes, ['NEW_UNSUPPORTED_LAYOUT']);
});

test('menu preserves repeated items in separate sections and exact menu identifiers', () => {
  const item = {
    uuid: 'pasta',
    title: 'Pasta',
    price: 3100,
    priceTagline: { text: 'US$ 31.00' },
    isSoldOut: false,
    isAvailable: true,
  };
  const result = normalizeEatsMenu({
    store: {
      uuid: 'restaurant',
      title: 'Example',
      supportedDiningModes: ['DELIVERY', 'PICKUP'],
      sections: [
        {
          uuid: 'dinner',
          title: 'Dinner',
          subsectionUuids: ['featured', 'pasta-category'],
          isOnSale: true,
        },
      ],
      catalogSectionsMap: {
        dinner: [
          { type: 'EATER_MESSAGE', catalogSectionUUID: 'promo', payload: {} },
          {
            type: 'HORIZONTAL_GRID',
            catalogSectionUUID: 'featured',
            payload: {
              standardItemsPayload: {
                title: { text: 'Featured' },
                sectionUUID: 'dinner',
                paginationEnabled: false,
                catalogItems: [item],
              },
            },
          },
          {
            type: 'VERTICAL_GRID',
            catalogSectionUUID: 'pasta-category',
            payload: {
              standardItemsPayload: {
                title: { text: 'Pasta' },
                sectionUUID: 'dinner',
                catalogItems: [item],
              },
            },
          },
        ],
      },
      catalogSectionPagingInfo: { isFirstPage: true, nextOffset: 7 },
    },
  });
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].items[0].subsectionId, 'featured');
  assert.equal(result.sections[1].items[0].subsectionId, 'pasta-category');
  assert.equal(result.sections[0].items[0].storeId, 'restaurant');
  assert.equal(result.sections[0].items[0].price, 3100);
  assert.equal(result.sections[0].items[0].priceLabel, 'US$ 31.00');
  assert.deepEqual(result.pagination, { isFirstPage: true, nextOffset: 7 });
  assert.deepEqual(result.unsupportedCatalogTypes, ['EATER_MESSAGE']);
  assert.deepEqual(result.menus[0].subsectionIds, [
    'featured',
    'pasta-category',
  ]);
});

test('item modifiers are lossless, recursive, isolated copies with zero bounds intact', () => {
  const customization = {
    customizationSetId: 'set',
    hasUnavailableCustomizations: false,
    customizationV2s: [
      {
        uuid: 'group',
        minPermitted: 0,
        maxPermitted: 2,
        customizationInstanceUUID: 'group-instance',
        quantityInfo: { chargeAbove: 1 },
        childOptions: {
          options: [
            {
              uuid: 'milk',
              quantity: 0,
              price: 0,
              optionInstanceUUID: 'option-instance',
              futureValidation: { value: 'keep' },
              customizationV2List: [
                {
                  uuid: 'nested',
                  minPermitted: 1,
                  maxPermitted: 1,
                  childOptions: {
                    options: [{ uuid: 'hot', defaultQuantity: 1 }],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
  const source = {
    uuid: 'coffee',
    title: 'Coffee',
    maxPermitted: 0,
    catalogItemCustomizationData: customization,
    labelPrimary: { richTextElements: [{ text: { text: { text: '$4.00' } } }] },
  };
  const result = normalizeEatsItem(source);
  assert.deepEqual(result.catalogItemCustomizationData, customization);
  assert.deepEqual(result.labels, ['$4.00']);
  assert.equal(result.maxPermitted, 0);
  result.catalogItemCustomizationData.customizationV2s[0].childOptions.options[0].quantity = 2;
  assert.equal(
    customization.customizationV2s[0].childOptions.options[0].quantity,
    0,
  );
});

test('changed response roots fail explicitly and do not look like successful empty searches', () => {
  assert.throws(() => normalizeEatsSearch({ data: { feed: {} } }), {
    code: 'EATS_RESPONSE_INVALID',
  });
  assert.throws(() => normalizeEatsMenu({ store: { uuid: 'one' } }), {
    code: 'EATS_RESPONSE_INVALID',
  });
  assert.throws(() => normalizeEatsItem(null), {
    code: 'EATS_RESPONSE_INVALID',
  });
  assert.throws(() => normalizeEatsSearch({ feed: {} }), {
    code: 'EATS_RESPONSE_INVALID',
  });
  assert.throws(
    () => normalizeEatsMenu({ store: { catalogSectionsMap: { changed: {} } } }),
    { code: 'EATS_RESPONSE_INVALID' },
  );
});
