import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { InstagramError } from './errors.mjs';
import { InstagramClient } from './http.mjs';
import { sessionFromExport, sessionStatus } from './session.mjs';
import { readState, saveState, removeState, stateDirectory, withStateLock } from './state.mjs';
import { createPairingAuth, pairingStatus } from './pairing.mjs';

export const pairingAuth = createPairingAuth({ store: {
  read: readState, save: saveState, remove: removeState, lock: withStateLock,
} });

export function loginInstructions() {
  return {
    browserApprovalRequired: true,
    browserRequiredOnHost: false,
    startCommand: 'instagram login',
    completeCommand: 'instagram auth wait',
    instructions: [
      'Run instagram login on the headless host to generate an approvalUrl and code.',
      'Send approvalUrl to the user. They sign in and approve on Instagram’s own website in their browser.',
      'Run instagram auth wait on the host, or call instagram auth poll periodically, to validate and save the approved session.',
      'Search, Explore and inbox commands then use HTTP without a browser or Android.',
    ],
    note: 'The user must confirm the code and click Continue until Instagram shows Success. Reopen the same link if sign-in redirects to Home.',
  };
}

export async function importSession(input, { validate = session => new InstagramClient(session).me() } = {}) {
  const session = sessionFromExport(input);
  const result = await validate(session);
  if (!result?.user || !/^\d+$/.test(String(result.user.pk ?? result.user.id))
    || typeof result.user.username !== 'string') {
    throw new InstagramError('INVALID_RESPONSE', 'The imported session did not validate an account.');
  }
  session.account = { id: String(result.user.pk ?? result.user.id), username: result.user.username };
  session.validatedAt = new Date().toISOString();
  return session;
}

export async function importSessionFile(filename) {
  const metadata = await fs.stat(filename);
  if (metadata.size > 1024 * 1024) throw new InstagramError('INVALID_SESSION', 'Session exports must be smaller than 1 MiB.');
  let input;
  try { input = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch { throw new InstagramError('INVALID_SESSION', 'Could not read a JSON browser session export.'); }
  return withStateLock(async () => {
    let validated;
    const session = await importSession(input, {
      validate: async candidate => {
        const client = new InstagramClient(candidate);
        const result = await client.me();
        validated = client.session;
        return result;
      },
    });
    await saveState('session', { ...session, ...validated });
    await removeState('login');
    return sessionStatus(validated);
  });
}

export async function browserLogin({ timeoutSeconds = 900, executablePath } = {}) {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new InstagramError('DISPLAY_REQUIRED', 'Use instagram login without --browser on this headless host, approve its link on your own device, then run instagram auth wait.');
  }
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch {
    throw new InstagramError('BROWSER_HELPER_MISSING', 'Install optional dependencies with npm install in the Instagram directory, then run login --browser on a computer with Chrome.');
  }
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  const profile = path.join(stateDirectory, 'browser');
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  const loginId = randomUUID();
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false, ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    });
  } catch {
    throw new InstagramError('BROWSER_START_FAILED', 'Could not open the dedicated Chrome profile. Install Chrome or provide --browser-path; close another login helper if one is running.');
  }
  try {
    await withStateLock(() => saveState('login', { id: loginId }));
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.bringToFront();
    process.stderr.write('Finish Instagram login in the dedicated Chrome window. The CLI will save the validated session and close that window.\n');
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const deadline = Date.now() + timeoutSeconds * 1000;
    let checkedCookie = null;
    let approvalError;
    while (Date.now() < deadline) {
      const active = await withStateLock(() => readState('login'));
      if (active?.id !== loginId) throw new InstagramError('LOGIN_CANCELLED', 'This login was cancelled by another authentication operation.');
      if (page.isClosed()) throw new InstagramError('LOGIN_CANCELLED', 'The login window was closed before authentication completed.');
      const cookies = await context.cookies('https://www.instagram.com');
      const sessionCookie = cookies.find(cookie => cookie.name === 'sessionid');
      if (sessionCookie?.value && sessionCookie.value !== checkedCookie) {
        checkedCookie = sessionCookie.value;
        try {
          const session = sessionFromExport({ cookies, userAgent });
          const client = new InstagramClient(session);
          await client.me();
          await withStateLock(async () => {
            if ((await readState('login'))?.id !== loginId) throw new InstagramError('LOGIN_CANCELLED', 'This login was cancelled by another authentication operation.');
            await saveState('session', client.session);
            await removeState('login');
          });
          return { ...sessionStatus(client.session), browserRequiredAtRuntime: false };
        } catch (error) {
          if (!(error instanceof InstagramError)) throw error;
          approvalError = error;
          process.stderr.write(`The browser has a session, but API validation returned ${error.code}. Finish any Instagram security checks in the window.\n`);
        }
      }
      await delay(1500);
    }
    throw approvalError ?? new InstagramError('LOGIN_TIMEOUT', 'Browser approval did not finish before the timeout. Run login --browser again.');
  } finally {
    await context.close();
    await withStateLock(async () => {
      if ((await readState('login'))?.id === loginId) await removeState('login');
    });
  }
}

export async function authStatus() {
  return withStateLock(async () => {
    const login = await readState('login');
    const pairing = pairingStatus(login);
    if (pairing.status === 'expired') await removeState('login');
    return { ...sessionStatus(await readState('session')), pairing };
  });
}

export async function logout() {
  await withStateLock(async () => {
    await removeState('login');
    await removeState('session');
    await fs.rm(path.join(stateDirectory, 'browser'), { recursive: true, force: true });
  });
  return { loggedIn: false, localCredentialsRemoved: true };
}
