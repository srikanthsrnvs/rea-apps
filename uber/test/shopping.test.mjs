import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRouteQuotes, fetchShoppingQuotes } from '../src/shopping.mjs';
import { shoppingRequest } from '../src/protocol.mjs';
test('CLI quotes and booking share the same ordered route and pricing reads', async () => {
  const calls = [];
  const send = async (endpoint, body) => {
    calls.push({ endpoint, body });
    return endpoint.includes('order_selection')
      ? {
          response: {
            fullResponse: {
              shoppingOrders: [
                {
                  id: 'one',
                  jobs: {
                    singleTransport: {
                      transportJob: {
                        productContext: { legacy: { vehicleViewID: 125 } },
                      },
                    },
                  },
                },
              ],
            },
          },
        }
      : { packageVariants: [] };
  };
  const request = shoppingRequest('37,-122', '38,-121', ['37.5,-121.5']);
  const direct = await fetchShoppingQuotes(send, request);
  const route = await fetchRouteQuotes(send, {
    from: '37,-122',
    to: '38,-121',
    via: ['37.5,-121.5'],
  });
  assert.deepEqual(direct, route);
  assert.deepEqual(calls.slice(0, 2), calls.slice(2));
  assert.equal(calls[1].body.pickupLocation.latitude, 37);
});
test('missing product catalog fails before a second pricing request', async () => {
  let calls = 0;
  await assert.rejects(
    fetchShoppingQuotes(
      async () => {
        calls++;
        return {};
      },
      shoppingRequest('37,-122', '38,-121'),
    ),
    /no product catalog/,
  );
  assert.equal(calls, 1);
});
