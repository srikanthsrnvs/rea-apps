import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CATALOG_DOCUMENTS, search, stores, items, prices } from '../src/catalog.mjs';

const context = { shopId: 'store-one', postalCode: '90291', query: 'coffee' };
const sample = id => ({ id, productId: `product-${id}`, name: `Coffee ${id}`, availability: { available: true } });

// APQ documents are registered server-side: changing whitespace breaks these hashes.
test('native APQ document identities remain intact', () => {
  const expected = {
    SearchItems: '5903bf0afa2ff8f05056f29b040f1441a77d9456772bc6dfe96cbb3125025aad',
    Items: '96d0ae60c0b0b6558442282ff3b6f7b1f2c6ae61c7c28d1c7450d773c70ef27c',
    ShopCollectionUnscoped: '468d66c9fef79218163117cef91051ae0ed4c91b51e447e1b41908f8d0c78286',
    ItemDetail: '3b3e55ff87377af016d5bfb460f7fd73b5da6c1cb0ae0436a23ccf94350b46c7',
    ItemPrices: '6eb53a91fad5865e0c85d1097926fc007cfe735dcc38daf48e26cdaf1fa95a39',
  };
  for (const [name, hash] of Object.entries(expected)) assert.equal(createHash('sha256').update(CATALOG_DOCUMENTS[name]).digest('hex'), hash);
});

test('pagination preserves ranked snapshot across hydration order and missing items', async () => {
  const calls = [];
  const client = { async graphql(name, document, variables) {
    calls.push({ name, variables });
    if (name === 'SearchItems') return { itemSearch: { itemResultList: { itemIds: ['1', '2', '3', '4', '5'], items: [sample('1'), sample('2')] } } };
    assert.equal(name, 'Items');
    if (variables.ids.includes('3')) return { items: [sample('4'), sample('3')] };
    return { items: [] };
  } };
  const first = await search(client, { ...context, limit: 2 });
  assert.deepEqual(first.items.map(value => value.id), ['1', '2']);
  assert.equal(first.hasMore, true);
  const second = await search(client, { ...context, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(value => value.id), ['3', '4']);
  assert.equal(second.offset, 2);
  const third = await search(client, { ...context, limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.items, []);
  assert.deepEqual(third.missingItemIds, ['5']);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(calls.map(value => value.name), ['SearchItems', 'Items', 'Items']);
});

test('cursor cannot accidentally page a different search, shop, or expired snapshot', async () => {
  const client = { async graphql() { return { itemSearch: { itemResultList: { itemIds: ['1', '2'], items: [sample('1')] } } }; } };
  const first = await search(client, { ...context, limit: 1 });
  let used = false;
  const noNetwork = { async graphql() { used = true; throw new Error('Network should not run'); } };
  for (const change of [{ query: 'tea' }, { shopId: 'store-two' }, { includeAds: true }]) {
    await assert.rejects(search(noNetwork, { ...context, ...change, cursor: first.nextCursor }), /different search/);
  }
  const cursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url'));
  cursor.expiresAt = Date.now() - 1;
  await assert.rejects(search(noNetwork, { ...context, cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') }), /expired/);
  assert.equal(used, false);
});

test('price hydration uses the selected shop, zone and postal context', async () => {
  const calls = [];
  const client = { async graphql(name, document, variables) {
    calls.push({ name, variables });
    return { items: [sample('1')], itemPricesV2: [{ itemId: '1', viewSection: { priceString: '$5.00' } }] };
  } };
  await items(client, { shopId: 's', zoneId: 'z', postalCode: '90291', ids: ['1'] });
  assert.deepEqual(calls[0].variables, { ids: ['1'], shopId: 's', hydrateItemPrice: true, itemShopId: 's', itemZoneId: 'z', itemPostalCode: '90291' });
  assert.equal((await prices(client, { shopId: 's', zoneId: 'z', postalCode: '90291', ids: ['1'] })).prices[0].price, '$5.00');
  await assert.rejects(items(client, { shopId: 's', postalCode: '90291', ids: ['1'] }), /zoneId/);
});

test('store discovery retains separate delivery and pickup shop IDs', async () => {
  const client = { async graphql(name, doc, variables) {
    assert.equal(name, 'ShopCollectionUnscoped');
    assert.deepEqual(variables.coordinates, { latitude: 34, longitude: -118 });
    return { shopCollection: { shops: [
      { id: 'delivery-shop', serviceType: 'delivery', retailer: { id: 'r', name: 'Market' } },
      { id: 'pickup-shop', serviceType: 'pickup', retailer: { id: 'r', name: 'Market' } },
    ] } };
  } };
  const result = await stores(client, { postalCode: '90291', latitude: 34, longitude: -118, query: 'market', serviceType: 'pickup' });
  assert.deepEqual(result.stores.map(value => value.shopId), ['pickup-shop']);
});
