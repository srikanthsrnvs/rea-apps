import { createClient } from './client.mjs';
import { saveState } from './state.mjs';

export async function checkConnection() {
  const client = await createClient({ anonymous: true });
  const result = await client.request({ method: 'POST', path: '/services/accountservicing/v1/initialization',
    body: { version: '', serviceName: 'AccountServicing' } });
  if (!result.initialization || typeof result.initialization.version !== 'string') return { phase: 'unknown', reason: 'unrecognized_initialization' };
  await saveState('initialization', result.initialization);
  return { phase: 'ready', connected: true, authenticated: false,
    protocolVersion: '7.34.1', configurationVersion: result.initialization.version,
    runtime: 'Node HTTP; no browser or Android runtime' };
}
