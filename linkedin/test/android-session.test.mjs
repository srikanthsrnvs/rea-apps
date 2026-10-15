import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAndroidCookieStore, readAndroidSession } from '../src/android-session.mjs';

function encodedCookie({ name = 'li_at', value = 'native-opaque', expires = 2_000_000_000, domain = '.linkedin.com' } = {}) {
  return [name, value, String(expires), domain, '/', 'true', '0', '', '', ''].map(encodeURIComponent).join(',') + ',';
}
test('native URI records decode ten URL-encoded fields with absolute expiry seconds', () => {
  const xml = `<map><string name="https://www.linkedin.com">${encodedCookie()}${encodedCookie({ name: 'JSESSIONID', value: '"ajax:123"' })}</string></map>`;
  const { cookies } = decodeAndroidCookieStore(xml, { now: 1_900_000_000_000 });
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0].expires, 2_000_000_000);
  assert.equal(cookies[1].value, '"ajax:123"');
});
test('foreign records, expired cookies and pre-login stores are not authenticated', () => {
  assert.throws(() => decodeAndroidCookieStore(`<map><string name="https://example.test">${encodedCookie()}</string></map>`), { code: 'AUTH_REQUIRED' });
  assert.throws(() => decodeAndroidCookieStore(`<map><string name="https://www.linkedin.com">${encodedCookie({ expires: 100 })}</string></map>`), { code: 'AUTH_REQUIRED' });
  assert.throws(() => decodeAndroidCookieStore('<!DOCTYPE map><map/>'), { code: 'INVALID_SESSION' });
  assert.throws(() => decodeAndroidCookieStore('<map><string name="https://www.linkedin.com">not,the,codec</string></map>'), { code: 'INVALID_SESSION' });
});
test('Android canonical http URI keys and final empty port-list fields are decoded without losing a field', () => {
  const encoded = encodedCookie().slice(0, -1);
  const result = decodeAndroidCookieStore(`<map><string name="http://www.linkedin.com">${encoded}</string></map>`, { now: 1_900_000_000_000 });
  assert.equal(result.cookies[0].name, 'li_at');
});
test('native bootstrap requires an explicit serial and uses no shell interpolation', async () => {
  await assert.rejects(readAndroidSession({ serial: 'device; cat secret' }), { code: 'INVALID_ARGUMENT' });
});
