import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createSessionStore } from './session.mjs';
import { parseCallback, CALLBACK } from './auth-protocol.mjs';
import { ChartsError, publicError, boundedResult } from './errors.mjs';
import { readCallbackStdin } from './cli.mjs';

const clientDirectory = () => process.env.CHARTS_CLIENT_STATE_DIR || path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'charts-client');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const binding = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');

export function validateClientConfig(config) {
  if (!config || config.version !== 1 || !/^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,255}$/u.test(config.sshTarget ?? '')
    || !/^\/[A-Za-z0-9_./ -]{1,1023}$/u.test(config.remoteCli ?? '') || config.remoteCli.includes('/../')
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(config.profile ?? '')) {
    throw new ChartsError('INVALID_ARGUMENT', 'Configure a trusted SSH host/alias, an absolute remote Charts executable path, and a simple profile name.');
  }
  return config;
}

export function parseClientLink(value) {
  let url;
  try { url = new URL(value); } catch { throw new ChartsError('INVALID_ARGUMENT', 'Invalid Charts login link.'); }
  const profile = url.searchParams.get('profile'), loginId = url.searchParams.get('login_id');
  if (url.protocol !== 'rea-charts:' || url.hostname !== 'authorize' || url.pathname !== '/'
    || url.username || url.password || url.port || url.hash || !uuid(loginId)
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(profile ?? '') || url.searchParams.size !== 2
    || url.searchParams.getAll('profile').length !== 1 || url.searchParams.getAll('login_id').length !== 1) {
    throw new ChartsError('INVALID_ARGUMENT', 'The login link must contain only a configured profile and one login ID.');
  }
  return { profile, loginId };
}

export function validateApproval(value) {
  let url;
  try { url = new URL(value); } catch { throw new ChartsError('PROTOCOL_ERROR', 'Invalid TradingView approval URL.'); }
  if (url.origin !== 'https://auth.tradingview.com' || url.pathname !== '/accounts/tvd/connect/'
    || url.username || url.password || url.hash || url.searchParams.size !== 3
    || url.searchParams.get('locale') !== 'en' || url.searchParams.get('redirect_url') !== CALLBACK
    || !/^[a-f0-9]{64}$/u.test(url.searchParams.get('key') ?? '')
    || ['locale', 'key', 'redirect_url'].some(key => url.searchParams.getAll(key).length !== 1)) {
    throw new ChartsError('PROTOCOL_ERROR', 'The host did not return an official TradingView native approval URL.');
  }
  return url.href;
}

// Remote credentials travel on stdin only. The remote command and target come
// from an owner-only local configuration, never from a browser URL.
export async function remoteCommand(config, args, input = '', { spawnImpl = spawn, timeoutMs = 60000 } = {}) {
  validateClientConfig(config);
  const command = [config.remoteCli, ...args].map(quote).join(' ');
  return new Promise((resolve, reject) => {
    const child = spawnImpl('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '--', config.sshTarget, command],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, settled = false;
    const timer = setTimeout(() => finish(new ChartsError('CLIENT_CONNECTION', 'The SSH handoff timed out. Check client status before retrying.')), timeoutMs);
    function finish(error, result) {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    }
    child.on('error', () => finish(new ChartsError('CLIENT_CONNECTION', 'Unable to start SSH. Configure key-based SSH access first.')));
    // Errors may contain remote output; retain only the public JSON from stdout.
    child.stderr.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) finish(new ChartsError('OUTPUT_LIMIT', 'SSH output exceeded the client limit.'));
    });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return finish(new ChartsError('OUTPUT_LIMIT', 'SSH output exceeded the client limit.'));
      output += chunk.toString('utf8');
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', code => {
      if (code !== 0) return finish(new ChartsError('CLIENT_CONNECTION', 'The remote command failed. Use charts auth status on the host; callbacks are never automatically resent.'));
      try {
        const result = JSON.parse(output);
        if (!result || typeof result !== 'object' || typeof result.status !== 'string') throw new Error();
        finish(null, result);
      } catch { finish(new ChartsError('PROTOCOL_ERROR', 'The remote command did not return a bounded Charts JSON response.')); }
    });
  });
}

export function createLoginClient({ store = createSessionStore(clientDirectory()), remote = remoteCommand, now = Date.now } = {}) {
  const config = async () => {
    const value = await store.read('config');
    if (!value) throw new ChartsError('CLIENT_NOT_CONFIGURED', 'Install and configure the Charts login receiver on this Mac first.');
    return validateClientConfig(value);
  };
  return {
    async configure(value) {
      validateClientConfig(value);
      return store.lock(async () => {
        const active = await store.read('active');
        if (active && active.expiresAt > now() && !['completed', 'cancelled'].includes(active.phase)) {
          throw new ChartsError('LOGIN_IN_PROGRESS', 'Cancel the active client login before changing its trusted SSH destination.');
        }
        await store.write('config', value);
        return { status: 'configured', profile: value.profile, sshTarget: value.sshTarget, remoteCli: value.remoteCli };
      });
    },
    async authorize(value) {
      const link = parseClientLink(value);
      return store.lock(async () => {
        const trusted = await config();
        if (trusted.profile !== link.profile) throw new ChartsError('CLIENT_PROFILE', 'This login link names a profile that is not configured on this Mac.');
        const active = await store.read('active');
        if (active && active.expiresAt > now() && !['completed', 'cancelled'].includes(active.phase)) {
          throw new ChartsError('LOGIN_IN_PROGRESS', 'A login is already active on this Mac. Complete it or cancel it before opening another link.');
        }
        const pending = await remote(trusted, ['auth', 'poll', '--login-id', link.loginId]);
        if (pending.status !== 'awaiting_callback' || pending.loginId !== link.loginId || pending.clientProfile !== link.profile) {
          throw new ChartsError('LOGIN_CHANGED', 'The host login has changed or already completed. Ask the agent for the current login link.');
        }
        const approvalUrl = validateApproval(pending.approvalUrl), expiresAt = Date.parse(pending.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 11 * 60000) {
          throw new ChartsError('LOGIN_EXPIRED', 'This login link expired. Ask the agent to start a new login.');
        }
        await store.write('active', { version: 1, loginId: link.loginId, expiresAt, phase: 'awaiting_callback', configBinding: binding(trusted) });
        return { status: 'authorization_required', action: 'open', approvalUrl, expiresAt, sshTarget: trusted.sshTarget };
      });
    },
    async callback(value) {
      parseCallback(value);
      return store.lock(async () => {
        const trusted = await config(), active = await store.read('active');
        if (!active || active.phase !== 'awaiting_callback' || active.expiresAt <= now() || active.configBinding !== binding(trusted)) {
          throw new ChartsError('CALLBACK_NOT_EXPECTED', 'No active matching Charts login is waiting on this Mac. The callback was not forwarded.');
        }
        // Persist before sending. A timeout or crash must never resend the grant.
        await store.write('active', { ...active, phase: 'forwarding' });
        let result;
        try { result = await remote(trusted, ['auth', 'complete', '--login-id', active.loginId, '--callback-stdin', '--timeout-ms', '60000'], value); }
        catch (error) { await store.write('active', { ...active, phase: 'outcome_unknown' }); throw error; }
        const complete = result.status === 'authenticated';
        await store.write('active', { ...active, phase: complete ? 'completed' : 'needs_attention' });
        return { status: result.status, action: 'done', authenticated: complete,
          message: complete ? 'TradingView is connected to the host.' : 'The host needs attention. Run charts auth status there before starting another login.' };
      });
    },
    async status({ online = false } = {}) {
      return store.lock(async () => {
        const trusted = await config(), active = await store.read('active');
        let remoteStatus;
        if (online && active) {
          remoteStatus = await remote(trusted, ['auth', 'poll', '--login-id', active.loginId]);
          if (remoteStatus.status === 'authenticated') await store.write('active', { ...active, phase: 'completed' });
        }
        return { status: 'ok', profile: trusted.profile, sshTarget: trusted.sshTarget, remoteCli: trusted.remoteCli,
          active: active ? { loginId: active.loginId, expiresAt: active.expiresAt,
            phase: remoteStatus?.status === 'authenticated' ? 'completed' : active.expiresAt <= now() && active.phase === 'awaiting_callback' ? 'expired' : active.phase } : null,
          ...(remoteStatus ? { remoteStatus } : {}) };
      });
    },
    async cancel() {
      return store.lock(async () => {
        await store.removeRecord('active');
        return { status: 'cancelled', message: 'The client handoff was cancelled. This does not revoke the saved host account.' };
      });
    },
  };
}

export async function runClient(argv = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: { 'ssh-target': { type: 'string' }, 'remote-cli': { type: 'string' }, profile: { type: 'string' }, online: { type: 'boolean' } } });
    const client = createLoginClient(); let result;
    const command = positionals.join(' ');
    if (command === 'configure') result = await client.configure({ version: 1, sshTarget: values['ssh-target'], remoteCli: values['remote-cli'], profile: values.profile ?? 'orin' });
    else if (command === 'status') result = await client.status({ online: values.online });
    else if (command === 'cancel') {
      result = await client.cancel();
      if (process.platform === 'darwin') {
        await new Promise(resolve => {
          const child = spawn(path.join(os.homedir(), 'Applications', 'Charts Login.app', 'Contents', 'MacOS', 'ChartsLogin'),
            ['--cancel-receiver'], { stdio: 'ignore' });
          child.once('error', resolve); child.once('close', resolve);
        });
      }
    }
    else if (command === 'receive') {
      const input = JSON.parse(await readCallbackStdin());
      if (!input || typeof input.url !== 'string') throw new ChartsError('INVALID_ARGUMENT', 'Expected one native login event.');
      result = input.url.startsWith('rea-charts:') ? await client.authorize(input.url) : await client.callback(input.url);
    } else throw new ChartsError('INVALID_ARGUMENT', 'Use charts-client configure --ssh-target HOST --remote-cli /absolute/path/charts, status [--online], or cancel.');
    console.log(JSON.stringify(boundedResult(result)));
  } catch (error) {
    const detail = publicError(error);
    console.log(JSON.stringify({ status: 'error', message: detail.message, error: detail }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runClient();
