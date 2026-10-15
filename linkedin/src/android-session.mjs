import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LinkedInError } from './errors.mjs';
import { USER_AGENT } from './session.mjs';

const execute = promisify(execFile);
const STORE = '/data/user/0/com.linkedin.android/shared_prefs/CookiePreferences.xml';
function xmlText(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (raw, key) => {
    if (!key.startsWith('#')) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key.toLowerCase()] ?? raw;
    const n = Number.parseInt(key.slice(/^#x/i.test(key) ? 2 : 1), /^#x/i.test(key) ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
  });
}
/** Decode the shipped CookiePersistenceEncoder, not a browser cookie database. */
export function decodeAndroidCookieStore(xml, { now = Date.now() } = {}) {
  if (typeof xml !== 'string' || xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new LinkedInError('INVALID_SESSION', 'Invalid native LinkedIn cookie store.');
  const cookies = new Map();
  for (const match of xml.matchAll(/<string\b[^>]*\bname=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/string\s*>/g)) {
    let uri;
    try { uri = new URL(xmlText(match[1] ?? match[2])); } catch { continue; }
    // Android canonicalizes its persistent-store URI keys to http:// even for
    // secure cookies. This is an on-disk namespace; transport remains HTTPS.
    if (!['http:', 'https:'].includes(uri.protocol) || !(uri.hostname === 'linkedin.com' || uri.hostname.endsWith('.linkedin.com'))) continue;
    const fields = xmlText(match[3]).split(',');
    if (fields.length % 10 === 1 && fields.at(-1) === '') fields.pop();
    if (fields.length % 10) throw new LinkedInError('INVALID_SESSION', 'Native cookie persistence format changed.');
    for (let start = 0; start < fields.length; start += 10) {
      let decoded;
      try { decoded = fields.slice(start, start + 10).map(v => decodeURIComponent(v.replaceAll('+', ' '))); }
      catch { throw new LinkedInError('INVALID_SESSION', 'Native cookie encoding is invalid.'); }
      const [name, value, absoluteExpiry, domain, cookiePath, secure] = decoded;
      const expiry = Number(absoluteExpiry);
      if (!Number.isSafeInteger(expiry) || expiry * 1000 <= now) continue;
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)
        || !/^\.?([a-z0-9-]+\.)*linkedin\.com$/i.test(domain) || !cookiePath.startsWith('/')) continue;
      const cookie = { name, value, domain, path: cookiePath, secure: secure === 'true', expires: expiry, httpOnly: true };
      cookies.set(`${name}\0${domain}\0${cookiePath}`, cookie);
    }
  }
  if (![...cookies.values()].some(c => c.name === 'li_at')) throw new LinkedInError('AUTH_REQUIRED', 'The native app has no persisted LinkedIn login cookie yet. Finish signing in inside the test Android app.');
  return { cookies: [...cookies.values()], userAgent: USER_AGENT };
}
export async function readAndroidSession({ serial, adb = process.env.LINKEDIN_ADB || 'adb' } = {}) {
  if (typeof serial !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(serial)) throw new LinkedInError('INVALID_ARGUMENT', 'Provide an explicit ADB device serial.');
  let stdout;
  try { ({ stdout } = await execute(adb, ['-s', serial, 'exec-out', 'cat', STORE], { encoding: 'utf8', timeout: 15_000, maxBuffer: 2_000_000 })); }
  catch { throw new LinkedInError('ANDROID_SESSION_UNAVAILABLE', 'Could not read LinkedIn’s native session. This bootstrap requires a permitted test Android environment; it does not root or modify your device.'); }
  return decodeAndroidCookieStore(stdout);
}
