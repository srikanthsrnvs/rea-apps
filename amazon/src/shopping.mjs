import { withClient } from './auth.mjs';
import { AmazonError } from './errors.mjs';
import { readRetailPage } from './retail.mjs';
import { buildSearchURL, parseSearchHTML, parseProductHTML } from './shopping-protocol.mjs';

export async function searchProducts({ query, cursor, page = 1 } = {}) {
  const url = buildSearchURL(query, { cursor, page });
  return withClient(async client => {
    const result = await readRetailPage(client, url);
    return parseSearchHTML(result.html, { url: result.url });
  });
}
export async function productDetails({ asin } = {}) {
  if (typeof asin !== 'string' || !/^[A-Z0-9]{10}$/.test(asin)) throw new AmazonError('INVALID_ARGUMENT', 'Provide an Amazon ASIN of ten uppercase letters or digits.');
  return withClient(async client => {
    const result = await readRetailPage(client, `https://www.amazon.com/dp/${asin}`);
    return parseProductHTML(result.html, { url: result.url });
  });
}
