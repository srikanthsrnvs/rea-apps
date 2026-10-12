import { InstagramError } from './errors.mjs';
import { parseInstagramJson } from './http.mjs';

export function parseWebsiteBootstrap(html, expectedUserId) {
  if (typeof html !== 'string' || html.length > 20 * 1024 * 1024) {
    throw new InstagramError('INVALID_RESPONSE', 'Invalid Instagram bootstrap page.');
  }
  const wanted = new Set(['PolarisViewer', 'DTSGInitialData', 'LSD', 'SiteData', 'CurrentUserInitialData']);
  const modules = new Map();
  let examined = 0;
  function visit(value, depth = 0) {
    if (depth > 128 || ++examined > 500_000) throw new InstagramError('INVALID_RESPONSE', 'Instagram bootstrap exceeds the supported structure bounds.');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && wanted.has(value[0]) && value[2] && typeof value[2] === 'object') modules.set(value[0], value[2]);
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const text = match[1].trim();
    if (!text.startsWith('{') && !text.startsWith('[')) continue;
    let data;
    try { data = parseInstagramJson(text); } catch { continue; }
    visit(data);
  }
  const viewer = modules.get('PolarisViewer');
  const user = viewer?.data;
  const id = user?.id ?? viewer?.id;
  if (!user || !/^\d+$/.test(String(id)) || !user.username || String(id) !== String(expectedUserId)) {
    throw new InstagramError('LOGIN_REQUIRED', 'Instagram did not validate the saved session’s account.');
  }
  return {
    user: { ...user, id: String(id) },
    tokens: {
      fbDtsg: modules.get('DTSGInitialData')?.token ?? null,
      lsd: modules.get('LSD')?.token ?? null,
    },
    siteData: modules.get('SiteData') ?? null,
  };
}
