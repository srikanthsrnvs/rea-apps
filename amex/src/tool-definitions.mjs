const string = { type: 'string' }, boolean = { type: 'boolean' };
const card = { card: string }, loginId = { 'login-id': string }, reviewId = { 'review-id': string };
const define = (command, description, properties = {}, required = []) => ({
  name: `amex_${command.replaceAll(' ', '_')}`, command, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
export const toolDefinitions = [
  define('connection', 'Test anonymous native API initialization. Does not authenticate or access an account.'),
  define('login', 'Start native user-ID/password login. Supply the password privately using a hidden terminal prompt, owner-only file or stdin. No password argument, browser or Android runtime. Account login is saved only after an independent account read.', {
    prompt: boolean, 'user-id': string, 'credentials-file': string, 'credentials-stdin': boolean,
    'password-file': string, 'password-stdin': boolean, replace: boolean,
  }),
  define('auth status', 'Read local login status; does not replay a request or validate an expired session.'),
  define('auth send-code', 'Send one verification code to a destination offered by Amex for the pending login.', { ...loginId, 'option-id': string }, ['login-id', 'option-id']),
  define('auth verify', 'Submit the newest offered verification code once, then independently read the account before saving login.', { ...loginId, code: string, 'code-file': string, 'code-stdin': boolean }, ['login-id']),
  define('auth validate', 'Retry only account validation for a pending candidate session; never repeat password or code verification.', loginId, ['login-id']),
  define('auth cancel', 'Discard the pending CLI login, preserving any previously saved session.', loginId, ['login-id']),
  define('logout', 'Remove the local session and account cache. Retains payment journals to prevent duplicate submissions.'),
  define('accounts', 'Read card accounts, balances and due information. Returns local card aliases, never native account tokens.'),
  define('transactions list', 'Read/search transactions. Continue with the opaque returned cursor; the cursor retains its card and search filters.', { ...card, description: string, 'start-date': string, 'end-date': string, sort: string, type: string, cursor: string }),
  define('transactions get', 'Read one transaction using its returned identifier and native FRAUD/PENDING/POSTED status.', { ...card, identifier: string, status: string, 'statement-end-date': string }, ['identifier', 'status']),
  define('statements list', 'Read available statement periods for one card.', card),
  define('payments history', 'Read payment history for one card.', card),
  define('payments activity', 'Read current payment activity for one card.', card),
  define('payment options', 'Read saved funding methods, amount/date choices and scheduled payments. Makes no payment.', card),
  define('payment preview', 'Prepare a five-minute review from offered inquiry choices. Makes no payment; display its exact card, funding method, amount, currency, date and terms to the user.', { 'inquiry-id': string, method: string, 'amount-option': string, amount: string, date: string }, ['inquiry-id', 'method', 'amount-option', 'date']),
  define('payment confirm', 'Submit the exact reviewed payment only after explicit user approval of the card, funding method, decimal amount, currency, date and terms. No automatic retry. Endpoint acceptance does not mean settled funds.', { ...reviewId, amount: string, currency: string, date: string, 'accept-terms': string, confirm: boolean }, ['review-id', 'amount', 'currency', 'date', 'accept-terms', 'confirm']),
  define('payment status', 'Read the recorded submission outcome without resubmitting. An uncertain outcome requires reconciliation with account activity.', reviewId, ['review-id']),
  define('payment cancel preview', 'Review cancellation of a scheduled payment only when Amex offers its delete action. Does not cancel.', { 'inquiry-id': string, payment: string }, ['inquiry-id', 'payment']),
  define('payment cancel confirm', 'Cancel the exact reviewed scheduled payment only after explicit user approval of its target and terms. No automatic retry.', { ...reviewId, 'accept-terms': string, confirm: boolean }, ['review-id', 'accept-terms', 'confirm']),
  define('payment cancel status', 'Read the recorded scheduled-payment cancellation outcome without resubmitting.', reviewId, ['review-id']),
];
