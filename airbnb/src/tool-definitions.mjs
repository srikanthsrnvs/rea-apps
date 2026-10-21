const string = { type: 'string' }, boolean = { type: 'boolean' };
const dates = { checkin: string, checkout: string, adults: string, children: string, infants: string, pets: string };
const define = (command, description, properties = {}, required = []) => ({
  name: `airbnb_${command.replaceAll(' ', '_')}`, command, description,
  inputSchema: { type: 'object', properties: { ...properties, raw: boolean }, required, additionalProperties: false },
});
export const toolDefinitions = [
  define('login', 'Start native sign-in. Phone login requests a code and returns the official verification-widget link when required; no host browser or Android runtime.', { email: string, phone: string, country: string, replace: boolean }),
  define('auth status', 'Show the saved-session and pending-login status without exposing tokens.'),
  define('auth request-sms', 'Explicitly use the shipped phone-code gateway if an SMS has not arrived. May return a verification requirement; does not change the native login session.', { 'login-id': string }, ['login-id']),
  define('auth verification start', 'Return a temporary link containing the official verification widget for this pending login. The host uses HTTP only.', { 'login-id': string }, ['login-id']),
  define('auth verification resume', 'Read verification status, submit its genuine result once, and retry the frozen auth request at most once.', { 'login-id': string }, ['login-id']),
  define('auth verify', 'Submit the newest six-digit code once, then independently validate the account.', { 'login-id': string, code: string, 'code-file': string }, ['login-id']),
  define('auth validate', 'Retry only the account read after code verification already returned a candidate session.', { 'login-id': string }, ['login-id']),
  define('auth resend', 'Explicitly request another offered verification code, subject to a cooldown.', { 'login-id': string, method: string }, ['login-id']),
  define('auth cancel', 'Discard an unfinished CLI login without changing a saved account.', { 'login-id': string }, ['login-id']),
  define('logout', 'Remove the local CLI session; other Airbnb sessions are unaffected.'),
  define('account', 'Read and validate the signed-in Airbnb account.'),
  define('places search', 'Search destination suggestions and their reusable place IDs.', { query: string, country: string, limit: string }, ['query']),
  define('stays search', 'Search stays with dates, guest counts, prices, and an optional opaque page cursor.', { query: string, 'place-id': string, ...dates, cursor: string, limit: string, 'min-price': string, 'max-price': string, currency: string }),
  define('listing get', 'Read listing details, rules, and date-specific pricing.', { 'listing-id': string, ...dates }, ['listing-id']),
  define('listing calendar', 'Read the listing availability calendar.', { 'listing-id': string, month: string, year: string, count: string }, ['listing-id', 'month', 'year']),
  define('wishlists list', 'Read saved lists, using an offset for another page.', { offset: string }),
  define('wishlist get', 'Read one saved list.', { 'wishlist-id': string }, ['wishlist-id']),
  define('trips list', 'Read account trips, using the server cursor for another page.', { cursor: string, limit: string }),
  define('inbox list', 'Read inbox conversations and their latest message preview.', { cursor: string, 'page-size': string }),
  define('inbox search', 'Search the signed-in account inbox.', { query: string, cursor: string }, ['query']),
  define('booking preview', 'Read checkout prices, payment options and requirements without placing a booking.', { 'listing-id': string, ...dates, currency: string }, ['listing-id', 'checkin', 'checkout']),
  define('booking confirm', 'Place the exact reviewed stay only after user approval. Requires a supported saved card, price ceiling, currency, exact terms hash and explicit confirmation; no automatic retry.', { 'review-id': string, 'payment-option': string, 'max-total': string, currency: string, 'accept-terms': string, 'message-to-host': string, confirm: boolean }, ['review-id', 'payment-option', 'max-total', 'currency', 'accept-terms', 'confirm']),
  define('booking status', 'Read the recorded submission outcome. Optional confirmation lookup never resubmits a booking.', { 'review-id': string, lookup: boolean }, ['review-id']),
  define('cancellation preview', 'Read the reservation, offered reasons and exact server refund terms. Choose an offered reason to prepare an eligible review; does not cancel.', { 'confirmation-code': string, 'reason-id': string }, ['confirmation-code']),
  define('cancellation confirm', 'Cancel the reviewed reservation only after explicit user approval of its reason, refund and exact terms hash. Refreshes terms before its sole submission.', { 'review-id': string, 'accept-terms': string, confirm: boolean }, ['review-id', 'accept-terms', 'confirm']),
  define('cancellation status', 'Read the recorded cancellation outcome without resubmitting.', { 'review-id': string }, ['review-id']),
];
