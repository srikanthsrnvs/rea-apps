import { createHash } from 'node:crypto';

export const PEOPLE_QUERIES = Object.freeze({
  search: 'voyagerSearchDashClusters.c2c5d4b012c05a6a94396191208d45f6',
  profile: 'voyagerIdentityDashProfiles.069e83ac4609b7ab20a7240204e1ce8c',
  profileByIdentifier: 'voyagerIdentityDashProfiles.1adcc390339f2f37e7c8904f6f52a164',
  contactInfo: 'voyagerIdentityDashProfiles.8aa5843dfcd1e81a06db3a87fb2e0c20',
});

const filterNames = ['network', 'geoUrn', 'currentCompany', 'pastCompany', 'schoolFilter',
  'industry', 'profileLanguage', 'firstName', 'lastName', 'company', 'title',
  'connectionOf', 'followerOf', 'talksAbout', 'serviceCategory', 'schoolFreetext',
  'eventAttending', 'contactInterest', 'activelyHiringForJobTitles'];
const profilePattern = /^urn:li:fsd_profile:[A-Za-z0-9_-]+$/;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}.`);
  return n;
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : null; }
function profileUrn(value) { return typeof value === 'string' && profilePattern.test(value) ? value : null; }

/** Resolve only explicit normalized entity references; never traverse an entire account response. */
function reader(payload) {
  const included = Array.isArray(payload?.included) ? payload.included : Array.isArray(payload?.data?.included) ? payload.data.included : [];
  const index = new Map(included.filter(plain).filter(x => typeof x.entityUrn === 'string').map(x => [x.entityUrn, x]));
  const resolve = value => typeof value === 'string' ? index.get(value) ?? value : value;
  const read = (value, key) => {
    value = resolve(value);
    return plain(value) ? resolve(value[key] ?? value[`*${key}`]) : undefined;
  };
  const elements = value => {
    value = resolve(value);
    const items = Array.isArray(value) ? value : read(value, 'elements');
    return Array.isArray(items) ? items.map(resolve) : [];
  };
  return { resolve, read, elements };
}
function topField(payload, name) {
  const root = payload?.data?.data ?? payload?.data ?? payload;
  return root?.[name] ?? root?.[`*${name}`] ?? (root?.elements || root?.['*elements'] || root?.entityUrn ? root : undefined);
}
function unionValue(union, names, r) {
  union = r.resolve(union);
  if (!plain(union)) return undefined;
  for (const [key, value] of Object.entries(union)) {
    const name = key.replace(/^\*/, '').split('.').at(-1);
    if (names.includes(name)) return r.resolve(value);
  }
}
function targetProfile(entity, r) {
  const target = r.read(entity, 'target');
  const profile = unionValue(target, ['profile', 'Profile', 'profileValue'], r);
  return plain(profile) ? profile : null;
}
function publicIdentifier(value) {
  if (typeof value !== 'string') return null;
  if (/^[A-Za-z0-9_-]{1,200}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/in\/([^/]+)\/?$/);
    return match && /^[A-Za-z0-9_-]{1,200}$/.test(decodeURIComponent(match[1])) ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}
function person(entity, r) {
  const target = targetProfile(entity, r);
  const urn = profileUrn(target?.entityUrn) ?? profileUrn(target?.dashEntityUrn)
    ?? profileUrn(r.read(entity, 'profileUrn'));
  const identifier = publicIdentifier(target?.publicIdentifier) ?? publicIdentifier(entity.navigationUrl);
  if (!urn && !identifier) return null;
  return {
    name: text(r.read(entity, 'title')) ?? ([target?.firstName, target?.lastName].filter(Boolean).join(' ') || null),
    headline: text(r.read(entity, 'primarySubtitle')) ?? target?.headline ?? null,
    location: text(r.read(entity, 'secondarySubtitle')),
    summary: text(r.read(entity, 'summary')),
    profileUrn: urn,
    publicIdentifier: identifier,
    profileUrl: identifier ? `https://www.linkedin.com/in/${encodeURIComponent(identifier)}/` : null,
    searchResultUrn: typeof entity.entityUrn === 'string' ? entity.entityUrn : null,
    // A search-result URN is not a recipient identity. Retain the returned profile identity.
    recipient: urn ? { profileUrn: urn } : null,
  };
}
export function normalizePeopleSearch(payload) {
  const r = reader(payload);
  const collection = r.resolve(topField(payload, 'searchDashClustersByAll'));
  if (!plain(collection)) fail('UNSUPPORTED_RESPONSE', 'LinkedIn did not return a searchDashClustersByAll collection.');
  const people = [], seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 8) return;
    value = r.resolve(value);
    if (!plain(value)) return;
    const item = r.read(value, 'item');
    const entity = unionValue(item ?? value, ['entityResult', 'EntityResultViewModel', 'entityResultValue'], r);
    if (entity) {
      const result = person(entity, r);
      const id = result?.profileUrn ?? result?.publicIdentifier;
      if (id && !seen.has(id)) { seen.add(id); people.push(result); }
    }
    const cluster = unionValue(item ?? value, ['cluster', 'SearchClusterViewModel', 'clusterValue'], r);
    if (cluster) visit(cluster, depth + 1);
    for (const key of ['items', 'results', 'elements']) for (const child of r.elements(r.read(value, key))) visit(child, depth + 1);
  };
  for (const cluster of r.elements(collection)) visit(cluster);
  const metadata = r.read(collection, 'metadata') ?? {};
  const paging = r.read(collection, 'paging') ?? {};
  const upstreamContext = r.read(metadata, 'bserpPaginationContext');
  const bserpPaginationContext = plain(upstreamContext) ? Object.fromEntries(
    ['clusterPosition', 'itemPosition'].filter(key => Number.isSafeInteger(upstreamContext[key])).map(key => [key, upstreamContext[key]]),
  ) : null;
  if (metadata.blockedQuery === true) fail('SEARCH_BLOCKED', 'LinkedIn blocked this search query.');
  return { people, metadata: {
    paginationToken: typeof metadata.paginationToken === 'string' ? metadata.paginationToken : null,
    searchId: typeof metadata.searchId === 'string' ? metadata.searchId : null,
    primaryResultType: typeof metadata.primaryResultType === 'string' ? metadata.primaryResultType : null,
    bserpPaginationContext,
    total: Number.isSafeInteger(metadata.totalResultCount) ? metadata.totalResultCount : Number.isSafeInteger(paging.total) ? paging.total : null,
    start: Number.isSafeInteger(paging.start) ? paging.start : null,
    count: Number.isSafeInteger(paging.count) ? paging.count : null,
  } };
}
function filters(options) {
  const result = { resultType: ['PEOPLE'] };
  for (const key of filterNames) {
    if (options[key] === undefined) continue;
    const values = Array.isArray(options[key]) ? options[key] : [options[key]];
    if (!values.length || values.length > 100 || values.some(x => typeof x !== 'string' || !x.trim() || x.length > 1000)) fail('INVALID_ARGUMENT', `${key} must be a nonempty string or list of strings.`);
    result[key] = [...new Set(values)];
  }
  return result;
}
export async function searchPeople(client, options = {}) {
  if (typeof options.keywords !== 'string' || !options.keywords.trim() || options.keywords.length > 1000) fail('INVALID_ARGUMENT', 'keywords must be a nonempty string of at most 1000 characters.');
  const count = integer(options.count, 10, 1, 100, 'count');
  let start = integer(options.start, 0, 0, 1000000, 'start');
  const queryParameters = filters(options);
  const fingerprint = createHash('sha256').update(JSON.stringify([options.keywords.trim(), queryParameters, count])).digest('hex');
  let previous = null;
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== 'string' || options.cursor.length > 32768) fail('INVALID_CURSOR', 'Invalid people search cursor.');
    try { previous = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')); } catch { fail('INVALID_CURSOR', 'Invalid people search cursor.'); }
    if (previous?.v !== 1 || previous.fingerprint !== fingerprint || !Number.isSafeInteger(previous.start) || previous.start < 0 || previous.start > 1000000) fail('INVALID_CURSOR', 'Cursor does not match this search.');
    start = previous.start;
    if (previous.searchId) queryParameters.searchId = [previous.searchId];
    if (previous.primaryResultType) queryParameters.primaryResultType = [previous.primaryResultType];
  }
  // The live GraphQL schema expects key/value input entries, although the shipped
  // legacy Android DataEncoder path emits a map. Keep the native filter map for
  // cursor continuity and adapt only at this request boundary.
  const query = { flagshipSearchIntent: 'SEARCH_SRP', keywords: options.keywords.trim(), spellCorrectionEnabled: true,
    queryParameters: Object.entries(queryParameters).map(([key, value]) => ({ key, value })) };
  if (previous?.bserpPaginationContext) query.bserpPaginationContext = previous.bserpPaginationContext;
  const variables = { query, count, start };
  if (options.origin !== undefined) {
    if (typeof options.origin !== 'string' || !options.origin || options.origin.length > 200) fail('INVALID_ARGUMENT', 'origin must be a nonempty string of at most 200 characters.');
    variables.origin = options.origin;
  }
  if (previous?.paginationToken) variables.paginationToken = previous.paginationToken;
  const payload = await client.graphql({ queryId: PEOPLE_QUERIES.search, queryName: 'SearchClusterCollection', variables, field: 'searchDashClustersByAll' });
  const { people, metadata } = normalizePeopleSearch(payload);
  const nextStart = (metadata.start ?? start) + (metadata.count ?? count);
  const hasMore = metadata.paginationToken !== null || (metadata.total !== null && nextStart < metadata.total);
  const cursor = hasMore ? Buffer.from(JSON.stringify({ v: 1, fingerprint, ...metadata, start: nextStart })).toString('base64url') : null;
  return { people, total: metadata.total, start: metadata.start ?? start, count: people.length, nextCursor: cursor };
}
function cleanSection(value, r, depth = 0, seen = new Set()) {
  value = r.resolve(value);
  if (depth > 10) return null;
  if (Array.isArray(value)) return value.slice(0, 1000).map(x => cleanSection(x, r, depth + 1, new Set(seen)));
  if (!plain(value)) return value ?? null;
  if (seen.has(value)) return null;
  seen.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('$') || /tracking|dashEntityUrn|viewer/i.test(key)) continue;
    result[key.replace(/^\*/, '')] = cleanSection(item, r, depth + 1, new Set(seen));
  }
  return result;
}
export function normalizeProfile(payload, field = 'identityDashProfilesById') {
  const r = reader(payload);
  let profile = r.resolve(topField(payload, field));
  if (r.elements(profile).length) profile = r.elements(profile)[0];
  if (!plain(profile) || !profileUrn(profile.entityUrn)) fail('PROFILE_NOT_FOUND', 'LinkedIn did not return a profile.');
  const identifier = publicIdentifier(profile.publicIdentifier);
  const geo = r.read(r.read(profile, 'geoLocation'), 'geo');
  const sections = {};
  for (const name of ['profilePositionGroups', 'profilePositions', 'profileEducations', 'profileCertifications', 'profileSkills', 'profileLanguages', 'profileProjects', 'profilePublications', 'profileHonors', 'profileVolunteerExperiences', 'profileCourses', 'profileOrganizations', 'profilePatents', 'profileTestScores']) {
    const value = r.read(profile, name);
    if (value !== undefined) sections[name] = cleanSection(value, r);
  }
  return {
    profileUrn: profile.entityUrn,
    memberUrn: typeof profile.objectUrn === 'string' ? profile.objectUrn : null,
    publicIdentifier: identifier,
    profileUrl: identifier ? `https://www.linkedin.com/in/${encodeURIComponent(identifier)}/` : null,
    firstName: profile.firstName ?? null,
    lastName: profile.lastName ?? null,
    headline: profile.headline ?? null,
    summary: profile.summary ?? null,
    location: profile.locationName ?? geo?.defaultLocalizedName ?? geo?.name ?? null,
    industry: cleanSection(r.read(profile, 'industryV2') ?? r.read(profile, 'industry'), r),
    profilePicture: cleanSection(r.read(profile, 'profilePicture'), r),
    backgroundPicture: cleanSection(r.read(profile, 'backgroundPicture'), r),
    recipient: { profileUrn: profile.entityUrn },
    sections,
  };
}
function partialWarnings(payload) {
  const errors = payload?.errors ?? payload?.data?.errors ?? payload?.data?.data?.errors ?? [];
  const sections = new Set();
  for (const error of Array.isArray(errors) ? errors : []) {
    if (error?.extensions?.classification !== 'DataFetchingException' || !Array.isArray(error.path)) continue;
    for (const part of error.path.slice(1)) {
      if (typeof part === 'string' && /^(?:profile[A-Z][A-Za-z0-9]{0,100}|ringStatus|backgroundPicture|industryV2|geoLocation)$/.test(part)) sections.add(part);
    }
  }
  return [...sections].map(section => ({ code: 'SECTION_UNAVAILABLE', section }));
}
export async function getProfile(client, options = {}) {
  const supplied = options.urn ?? options.profileUrn ?? options.identifier;
  if (typeof supplied !== 'string') fail('INVALID_ARGUMENT', 'Provide a LinkedIn profile URN, public identifier, or profile URL.');
  const urn = profileUrn(supplied);
  const identifier = urn ? null : publicIdentifier(supplied);
  if (!urn && !identifier) fail('INVALID_ARGUMENT', 'Invalid LinkedIn profile identifier.');
  const field = urn ? 'identityDashProfilesById' : 'identityDashProfilesByMemberIdentity';
  const payload = await client.graphql({ queryId: urn ? PEOPLE_QUERIES.profile : PEOPLE_QUERIES.profileByIdentifier,
    queryName: urn ? 'FullProfileWithEntitiesV2' : 'FullProfileByMemberIdentity',
    variables: urn ? { profileUrn: urn } : { memberIdentity: identifier }, field, allowPartialData: true });
  const profile = normalizeProfile(payload, field);
  const warnings = partialWarnings(payload);
  if (options.contactInfo === true) {
    const response = await client.graphql({ queryId: PEOPLE_QUERIES.contactInfo, queryName: 'ProfileContactInfoById', variables: { profileUrn: profile.profileUrn }, field: 'identityDashProfilesById', allowPartialData: true });
    warnings.push(...partialWarnings(response));
    const r = reader(response);
    let contact = r.resolve(topField(response, 'identityDashProfilesById'));
    if (r.elements(contact).length) contact = r.elements(contact)[0];
    profile.contactInfo = {};
    for (const key of ['emailAddress', 'phoneNumbers', 'address', 'websites', 'twitterHandles', 'weChatContactInfo', 'instantMessengers', 'birthDateOn']) {
      if (r.read(contact, key) !== undefined) profile.contactInfo[key] = cleanSection(r.read(contact, key), r);
    }
  }
  if (warnings.length) {
    profile.warnings = [...new Map(warnings.map(warning => [warning.section, warning])).values()];
    profile.unavailableSections = profile.warnings.map(warning => warning.section);
  }
  return profile;
}
