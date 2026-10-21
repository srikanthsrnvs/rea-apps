import { readState, saveState, withStateLock } from './state.mjs';
import { request } from './http.mjs';
import { privateInput } from './private-input.mjs';
import { QuilttError } from './errors.mjs';
export function connectorId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) throw new QuilttError('INVALID_CONNECTOR', 'Copy the Connector ID from the Quiltt Sandbox dashboard.');
  return value;
}
export async function inspectConnector(connector, { fetchImpl = fetch } = {}) {
  connectorId(connector); let response;
  try { response = await fetchImpl(`https://${connector}.quiltt.app/`, { redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new QuilttError('CONNECTOR_UNAVAILABLE', 'The official Quiltt Connector could not be reached.'); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new QuilttError('CONNECTOR_UNAVAILABLE', 'The official Quiltt Connector could not be loaded.'); }
  let html = ''; for await (const part of response.body ?? []) { html += Buffer.from(part).toString('utf8'); if (Buffer.byteLength(html) > 512_000) throw new QuilttError('INVALID_CONNECTOR', 'Unrecognized Connector configuration.'); }
  const root = html.match(/<div\b(?=[^>]*\bid="root")[^>]*>/u)?.[0];
  const attr = name => root?.match(new RegExp(`\\bdata-${name}="([^"]*)"`, 'u'))?.[1];
  if (attr('connector-id') !== connector || attr('environment-mode') !== 'SANDBOX' || !/^env_[A-Za-z0-9]+$/u.test(attr('environment-id') ?? '')) throw new QuilttError('SANDBOX_REQUIRED', 'This CLI currently accepts official Quiltt SANDBOX connectors only.');
  return { id: attr('environment-id'), mode: 'SANDBOX' };
}
export async function configure({ connector, ...input }, { requestImpl = request, readSecret = privateInput, inspect = inspectConnector } = {}) {
  connectorId(connector);
  const environment = await inspect(connector);
  let secret;
  if (input.file !== undefined || input.stdin || input.prompt) {
    secret = await readSecret(input);
    const key = await requestImpl('key', { token: secret });
    if (key.environment?.mode !== 'SANDBOX' || key.environment.id !== environment.id) throw new QuilttError('SANDBOX_REQUIRED', 'Use an API secret from the same Sandbox environment as this Connector.');
  }
  await withStateLock(async () => {
    const session = await readState('session');
    if (session && session.environmentId !== environment.id) throw new QuilttError('ENVIRONMENT_CHANGED', 'Log out before changing the configured Sandbox environment.');
    const previous = await readState('config');
    if (!secret && previous?.environment?.id === environment.id) secret = previous.secret;
    await saveState('config', { version: 1, connectorId: connector, secret, environment });
  });
  return { configured: true, connectorId: connector, environment, persistentServerAccess: Boolean(secret) };
}
export async function requireConfig() {
  const config = await readState('config');
  if (config?.version !== 1 || config.environment?.mode !== 'SANDBOX' || !config.environment.id?.startsWith('env_')) throw new QuilttError('CONFIG_REQUIRED', 'Configure a Sandbox Connector first.');
  connectorId(config.connectorId); return config;
}
