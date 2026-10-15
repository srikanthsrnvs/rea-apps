import test from 'node:test';
import assert from 'node:assert/strict';
import { searchPeople, getProfile, normalizePeopleSearch, normalizeProfile, PEOPLE_QUERIES } from '../src/people.mjs';

const urn = 'urn:li:fsd_profile:ACoExample';
// Constructed fixtures exercise the shipped model topology; these are not a live account capture.
function searchFixture(metadata = {}) {
  return { data: { data: { searchDashClustersByAll: {
    '*elements': ['urn:li:cluster:1'], paging: { start: 0, count: 10, total: 12 }, metadata,
  } } }, included: [
    { entityUrn: 'urn:li:cluster:1', items: [
      { item: { '*com.linkedin.voyager.dash.search.EntityResultViewModel': 'urn:li:result:1' } },
      { item: { '*com.linkedin.voyager.dash.search.EntityResultViewModel': 'urn:li:result:1' } },
      { item: { 'com.linkedin.voyager.dash.search.SearchIllustrationCard': { title: 'Not a person' } } },
    ] },
    { entityUrn: 'urn:li:result:1', title: { text: 'Example Person' }, primarySubtitle: { text: 'Engineer' },
      secondarySubtitle: { text: 'Los Angeles' }, target: { '*profile': urn }, navigationUrl: 'https://www.linkedin.com/in/example-person/' },
    { entityUrn: urn, firstName: 'Example', lastName: 'Person', publicIdentifier: 'example-person' },
    // An unrelated included profile must never leak into the requested search/profile.
    { entityUrn: 'urn:li:fsd_profile:other', firstName: 'Unrelated' },
  ] };
}

test('normalizes explicit entity joins, skips non-people cards and deduplicates', () => {
  const result = normalizePeopleSearch(searchFixture());
  assert.equal(result.people.length, 1);
  assert.deepEqual(result.people[0], {
    name: 'Example Person', headline: 'Engineer', location: 'Los Angeles', summary: null,
    profileUrn: urn, publicIdentifier: 'example-person', profileUrl: 'https://www.linkedin.com/in/example-person/',
    searchResultUrn: 'urn:li:result:1', recipient: { profileUrn: urn },
  });
});
test('decodes the native entityResult and nested cluster union wire keys', () => {
  const response = { searchDashClustersByAll: { elements: [{ items: [
    { item: { cluster: { items: [{ item: { entityResult: {
      title: { text: 'Native Person' }, target: { profile: { entityUrn: urn, publicIdentifier: 'native-person' } },
    } } }] } } },
  ] }] } };
  assert.equal(normalizePeopleSearch(response).people[0].name, 'Native Person');
});
test('preserves pagination context and rejects cursors from a different search', async () => {
  const calls = [];
  const client = { async graphql(request) { calls.push(request); return searchFixture({ paginationToken: 'server-token', searchId: 's1', primaryResultType: 'PEOPLE', bserpPaginationContext: { clusterPosition: 1, itemPosition: 3 } }); } };
  const first = await searchPeople(client, { keywords: 'engineer', network: ['F'], geoUrn: '103644278' });
  assert.equal(calls[0].queryId, PEOPLE_QUERIES.search);
  assert.equal(calls[0].queryName, 'SearchClusterCollection');
  assert.deepEqual(calls[0].variables.query.queryParameters, [
    { key: 'resultType', value: ['PEOPLE'] }, { key: 'network', value: ['F'] }, { key: 'geoUrn', value: ['103644278'] },
  ]);
  await searchPeople(client, { keywords: 'engineer', network: ['F'], geoUrn: '103644278', cursor: first.nextCursor });
  assert.equal(calls[1].variables.start, 10);
  assert.equal(calls[1].variables.paginationToken, 'server-token');
  assert.deepEqual(calls[1].variables.query.bserpPaginationContext, { clusterPosition: 1, itemPosition: 3 });
  assert.deepEqual(calls[1].variables.query.queryParameters.find(item => item.key === 'searchId'), { key: 'searchId', value: ['s1'] });
  await assert.rejects(searchPeople(client, { keywords: 'changed', cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
});
test('an empty returned page can have a next token; no token or total stops pagination', async () => {
  const client = { graphql: async () => ({ searchDashClustersByAll: { elements: [], metadata: {} } }) };
  assert.equal((await searchPeople(client, { keywords: 'a' })).nextCursor, null);
  client.graphql = async () => ({ searchDashClustersByAll: { elements: [], metadata: { paginationToken: 'next' } } });
  assert.ok((await searchPeople(client, { keywords: 'a' })).nextCursor);
});
test('search does not treat a result URN as a profile or recipient identity', () => {
  const response = { searchDashClustersByAll: { elements: [{ items: [{ item: { entityResult: { entityUrn: 'urn:li:result:1', title: { text: 'Unknown' } } } }] }] } };
  assert.deepEqual(normalizePeopleSearch(response).people, []);
});
test('live-shaped null target preserves the profile URL without guessing a recipient URN', () => {
  const response = { data: { searchDashClustersByAll: { elements: [{ items: [{ item: { entityResult: {
    entityUrn: 'urn:li:fsd_entityResultViewModel:opaque', trackingUrn: 'urn:li:member:123',
    title: { text: 'Example Person' }, target: null, navigationUrl: 'https://www.linkedin.com/in/example-person/',
  } } }] }], paging: { start: 0, count: 5, total: 250 }, metadata: { paginationToken: null, searchId: 's1', primaryResultType: 'PEOPLE' } } } };
  const result = normalizePeopleSearch(response);
  assert.equal(result.people[0].publicIdentifier, 'example-person');
  assert.equal(result.people[0].profileUrn, null);
  assert.equal(result.people[0].recipient, null);
  assert.equal(result.metadata.total, 250);
});
test('blocked and unknown responses fail instead of returning invented empty success', () => {
  assert.throws(() => normalizePeopleSearch({ data: {} }), { code: 'UNSUPPORTED_RESPONSE' });
  assert.throws(() => normalizePeopleSearch({ searchDashClustersByAll: { elements: [], metadata: { blockedQuery: true } } }), { code: 'SEARCH_BLOCKED' });
});
test('profile identifier selects shipped finder and resolves profile sections', async () => {
  const calls = [];
  const client = { async graphql(request) {
    calls.push(request);
    return { data: { identityDashProfilesByMemberIdentity: { '*elements': [urn] } }, included: [
      { entityUrn: urn, firstName: 'Example', lastName: 'Person', publicIdentifier: 'example-person', headline: 'Engineer',
        '*profileEducations': 'urn:li:education:1' },
      { entityUrn: 'urn:li:education:1', elements: [{ schoolName: 'Example University', trackingId: 'private' }] },
    ] };
  } };
  const result = await getProfile(client, { identifier: 'https://www.linkedin.com/in/example-person/' });
  assert.equal(calls[0].queryId, PEOPLE_QUERIES.profileByIdentifier);
  assert.equal(calls[0].queryName, 'FullProfileByMemberIdentity');
  assert.deepEqual(calls[0].variables, { memberIdentity: 'example-person' });
  assert.equal(result.profileUrn, urn);
  assert.deepEqual(result.sections.profileEducations.elements, [{ schoolName: 'Example University' }]);
});
test('profile URN uses full profile query; contact info is an explicit separate read', async () => {
  const calls = [];
  const client = { async graphql(request) { calls.push(request); return { identityDashProfilesById: { entityUrn: urn, firstName: 'Example', emailAddress: { emailAddress: 'example@example.test' } } }; } };
  const result = await getProfile(client, { urn, contactInfo: true });
  assert.equal(calls[0].queryId, PEOPLE_QUERIES.profile);
  assert.equal(calls[0].queryName, 'FullProfileWithEntitiesV2');
  assert.equal(calls[1].queryId, PEOPLE_QUERIES.contactInfo);
  assert.equal(calls[1].queryName, 'ProfileContactInfoById');
  assert.deepEqual(result.contactInfo, { emailAddress: { emailAddress: 'example@example.test' } });
});
test('usable primary profile survives an optional section error with sanitized warnings', async () => {
  let call;
  const client = { async graphql(request) {
    call = request;
    return { data: { identityDashProfilesById: { entityUrn: urn, firstName: 'Example', profileRingStatusCollection: null } }, errors: [
      { message: 'Private server details must not be emitted', path: ['identityDashProfilesById', 'profileRingStatusCollection'], extensions: { classification: 'DataFetchingException' } },
    ] };
  } };
  const result = await getProfile(client, { urn });
  assert.equal(call.allowPartialData, true);
  assert.equal(result.firstName, 'Example');
  assert.deepEqual(result.unavailableSections, ['profileRingStatusCollection']);
  assert.deepEqual(result.warnings, [{ code: 'SECTION_UNAVAILABLE', section: 'profileRingStatusCollection' }]);
  assert.ok(!JSON.stringify(result).includes('Private server'));
});
test('rejects foreign URLs, invalid filters and unsupported profiles before requests', async () => {
  const client = { graphql() { assert.fail('must not request'); } };
  await assert.rejects(getProfile(client, { identifier: 'https://linkedin.com.attacker.test/in/example/' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(searchPeople(client, { keywords: 'engineer', count: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(searchPeople(client, { keywords: 'engineer', network: [] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => normalizeProfile({ included: [{ entityUrn: urn }] }), { code: 'PROFILE_NOT_FOUND' });
});
