import { AmazonError } from './errors.mjs';
import { nativeUserAgent, retailURL } from './shopping-protocol.mjs';

// This is an HTTP header compatibility profile, not a running browser. The
// current cart/checkout routes reject the app UA while accepting this profile.
export const desktopHeaders = Object.freeze({
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
});
export async function readRetailPage(client, input, { desktop = false } = {}) {
  let url = retailURL(input);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await client.request(url, { responseType: 'response', headers: desktop ? desktopHeaders : {
      accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9', 'user-agent': nativeUserAgent(),
    } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new AmazonError('UNEXPECTED_RESPONSE', 'Amazon returned an incomplete redirect.');
      url = retailURL(location, url);
      if (new URL(url).pathname.startsWith('/ap/')) throw new AmazonError('AUTH_REQUIRED', 'Amazon requires a fresh shopping session.');
      continue;
    }
    if (!response.status || response.status >= 400) {
      if (/automated access|validateCaptcha|robot check/i.test(response.text)) throw new AmazonError('AMAZON_CHALLENGE', 'Amazon returned an automated-access or verification page.', { httpStatus: response.status });
      throw new AmazonError('HTTP_ERROR', 'Amazon could not return this shopping page.', { httpStatus: response.status });
    }
    return { html: response.text, url };
  }
  throw new AmazonError('REDIRECT_LIMIT', 'Amazon redirected this request too many times.');
}
