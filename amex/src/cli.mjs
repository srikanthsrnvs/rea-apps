import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';
import { AmexError } from './errors.mjs';
import { toolDefinitions } from './tool-definitions.mjs';
import { checkConnection } from './bootstrap.mjs';
import * as auth from './auth.mjs';
import * as reads from './read.mjs';
import * as payments from './payment.mjs';

export function parse(argv) {
  const options = { pretty: { type: 'boolean' }, help: { type: 'boolean' } };
  for (const def of toolDefinitions) for (const [name, schema] of Object.entries(def.inputSchema.properties)) options[name] = { type: schema.type };
  let parsed;
  try { parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true }); }
  catch { throw new AmexError('INVALID_ARGUMENT', 'Invalid arguments. Run amex tools. Password arguments are never accepted.'); }
  const command = parsed.positionals.join(' '), o = parsed.values;
  if (!command || ['help', 'tools'].includes(command) || o.help) return { command: 'tools', o };
  const def = toolDefinitions.find(item => item.command === command);
  if (!def) throw new AmexError('UNKNOWN_COMMAND', 'Unknown command. Run amex tools.');
  const seen = new Set();
  for (const token of parsed.tokens.filter(item => item.kind === 'option')) {
    if (seen.has(token.name)) throw new AmexError('INVALID_ARGUMENT', 'Duplicate option.');
    seen.add(token.name);
    if (token.name !== 'pretty' && !Object.hasOwn(def.inputSchema.properties, token.name)) throw new AmexError('INVALID_ARGUMENT', `--${token.name} is not accepted by this command.`);
  }
  for (const key of def.inputSchema.required) if (o[key] === undefined) throw new AmexError('INVALID_ARGUMENT', `Provide --${key}.`);
  return { command, o };
}
async function readCode(o) {
  if ([o.code !== undefined, o['code-file'] !== undefined, o['code-stdin'] === true].filter(Boolean).length !== 1) throw new AmexError('INVALID_ARGUMENT', 'Choose one of --code, --code-file or --code-stdin.');
  if (o.code !== undefined) return o.code;
  if (o['code-stdin']) {
    let code = '';
    for await (const chunk of process.stdin) { code += chunk.toString(); if (code.length > 100) throw new AmexError('INVALID_ARGUMENT', 'Code input is too large.'); }
    return code.trim();
  }
  let file;
  try {
    file = await fs.open(o['code-file'], constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 100 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new AmexError('INVALID_ARGUMENT', 'Use a small owner-only code file (chmod 600).');
    return (await file.readFile('utf8')).trim();
  } catch (error) {
    if (error instanceof AmexError) throw error;
    throw new AmexError('INVALID_ARGUMENT', 'The private code file could not be read.');
  } finally { await file?.close(); }
}
export async function dispatch(argv) {
  const { command, o } = parse(argv);
  switch (command) {
    case 'tools': return { status: 'experimental; account login and financial submission require live validation', tools: toolDefinitions };
    case 'connection': return checkConnection();
    case 'login': return auth.startLogin({ userId: o['user-id'], credentialsFile: o['credentials-file'], credentialsStdin: o['credentials-stdin'], passwordFile: o['password-file'], passwordStdin: o['password-stdin'], prompt: o.prompt, replace: o.replace });
    case 'auth status': return auth.authStatus();
    case 'auth send-code': return auth.sendCode({ loginId: o['login-id'], optionId: o['option-id'] });
    case 'auth verify': return auth.verifyCode({ loginId: o['login-id'], code: await readCode(o) });
    case 'auth validate': return auth.validateLogin({ loginId: o['login-id'] });
    case 'auth cancel': return auth.cancelLogin({ loginId: o['login-id'] });
    case 'logout': return auth.logout();
    case 'accounts': return reads.readAccounts();
    case 'transactions list': return reads.readTransactions({ card: o.card, description: o.description, startDate: o['start-date'], endDate: o['end-date'], sort: o.sort, transactionType: o.type, cursor: o.cursor });
    case 'transactions get': return reads.readTransactionDetails({ card: o.card, identifier: o.identifier, status: o.status, statementEndDate: o['statement-end-date'] });
    case 'statements list': return reads.readStatementPeriods({ card: o.card });
    case 'payments history': return reads.readPaymentHistory({ card: o.card });
    case 'payments activity': return reads.readPaymentActivity({ card: o.card });
    case 'payment options': return payments.paymentOptions({ card: o.card });
    case 'payment preview': return payments.previewPayment({ inquiryId: o['inquiry-id'], method: o.method, amountOption: o['amount-option'], amount: o.amount, date: o.date });
    case 'payment confirm': return payments.confirmPayment({ reviewId: o['review-id'], amount: o.amount, currency: o.currency, date: o.date, acceptTerms: o['accept-terms'], confirm: o.confirm });
    case 'payment status': return payments.paymentStatus({ reviewId: o['review-id'] });
    case 'payment cancel preview': return payments.previewCancellation({ inquiryId: o['inquiry-id'], payment: o.payment });
    case 'payment cancel confirm': return payments.confirmCancellation({ reviewId: o['review-id'], acceptTerms: o['accept-terms'], confirm: o.confirm });
    case 'payment cancel status': return payments.cancellationStatus({ reviewId: o['review-id'] });
    default: throw new AmexError('UNKNOWN_COMMAND', 'Unknown command. Run amex tools.');
  }
}
export async function run(argv = process.argv.slice(2)) {
  try { console.log(JSON.stringify(await dispatch(argv), null, argv.includes('--pretty') ? 2 : undefined)); }
  catch (error) {
    const known = error instanceof AmexError, invalid = error instanceof TypeError || error instanceof RangeError;
    const originalReviewId = error.details?.originalReviewId;
    const details = known && error.code === 'AMEX_DUPLICATE_FINANCIAL_ACTION'
      && typeof originalReviewId === 'string' && /^[a-f0-9-]{36}$/u.test(originalReviewId)
      ? { originalReviewId } : undefined;
    console.error(JSON.stringify({ error: { code: known ? error.code : invalid ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR',
      message: known || invalid ? error.message : 'The command could not complete.', ...(details ? { details } : {}) } }));
    process.exitCode = 1;
  }
}
