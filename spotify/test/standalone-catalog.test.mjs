import test from "node:test";
import assert from "node:assert/strict";
import { NativeCatalogBackend, QUERY_MANIFEST, PATHFINDER_URL, normalizeCatalogItem } from "../src/standalone/catalog-backend.mjs";

const trackUri = "spotify:track:2LD2gT7gwAurzdQDQtILds";
const playlistUri = "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M";
const track = () => ({ __typename: "Track", uri: trackUri, name: "Veridis Quo",
  artists: { items: [{ profile: { name: "Daft Punk" } }] },
  albumOfTrack: { name: "Discovery", coverArt: { sources: [{ url: "https://i.scdn.co/image/example" }] } },
  duration: { totalMilliseconds: 345186 }, playability: { playable: true } });
const wrappedTrack = () => ({ item: { __typename: "TrackResponseWrapper", data: track() } });
function mock(responder) {
  const calls = [];
  const backend = new NativeCatalogBackend({ request: async (url, options = {}) => {
    calls.push({ url, options });
    assert.doesNotMatch(url, /^https:\/\/api\.spotify\.com\//u);
    return responder(url, options, calls);
  }, spclientBaseUrl: "https://gew1-spclient.spotify.com" });
  return { backend, calls };
}

test("manifest identifies first-party desktop/web artifacts and only pinned persisted operations", () => {
  assert.equal(QUERY_MANIFEST.sources.desktop.applicationVersion, "1.3.5.3058");
  assert.equal(QUERY_MANIFEST.sources.desktop.artifactSha256, "dd25db62f22ee19683c0cfc73db9eb82400181618b6ee9930bb48fc641b98e73");
  assert.match(QUERY_MANIFEST.sources.web.artifact, /^https:\/\/open\.spotifycdn\.com\//u);
  assert.ok(Object.isFrozen(QUERY_MANIFEST.operations));
  for (const entry of Object.values(QUERY_MANIFEST.operations)) {
    assert.match(entry.sha256Hash, /^[a-f0-9]{64}$/u);
    assert.ok(QUERY_MANIFEST.sources[entry.source]);
  }
  assert.equal(QUERY_MANIFEST.operations.fetchLibraryTracks.sha256Hash, "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240");
});

test("search sends current desktop persisted operation through native Pathfinder and normalizes nested track metadata", async () => {
  const { backend, calls } = mock(() => ({ data: { searchV2: { tracksV2: {
    items: [wrappedTrack()], pagingInfo: { nextOffset: 11, limit: 1, offset: 10 }, totalCount: 100,
  } } } }));
  const result = await backend.search({ query: "Daft Punk", type: "track", offset: 10, limit: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PATHFINDER_URL);
  assert.equal(calls[0].options.method, "POST");
  const body = calls[0].options.body;
  assert.equal(body.operationName, "searchTracks");
  assert.equal(body.extensions.persistedQuery.sha256Hash, "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751");
  assert.equal(body.variables.searchTerm, "Daft Punk");
  assert.equal(body.variables.offset, 10);
  assert.equal(body.variables.includeEpisodeContentRatingsV2, false);
  assert.equal(result.tracks.items[0].uri, trackUri);
  assert.deepEqual(result.tracks.items[0].artists, ["Daft Punk"]);
  assert.equal(result.tracks.items[0].album, "Discovery");
  assert.equal(result.tracks.items[0].durationMs, 345186);
  assert.equal(result.tracks.nextOffset, 11);
});

test("profile derives account identity from this session without a copied username", async () => {
  const { backend, calls } = mock(() => ({ data: { me: { profile: {
    username: "testaccount", uri: "spotify:user:testaccount", name: "Test Account",
    avatar: { sources: [] }, privateDiagnostic: "SHOULD_NOT_ESCAPE",
  } } } }));
  assert.deepEqual(await backend.profile(), { username: "testaccount", uri: "spotify:user:testaccount", displayName: "Test Account", images: [] });
  assert.equal(calls[0].options.body.operationName, "profileAttributes");
  assert.deepEqual(calls[0].options.body.variables, {});
});

test("liked songs preserve unavailable rows, library timestamps and exact server pagination", async () => {
  const { backend, calls } = mock(() => ({ data: { me: { library: { tracks: {
    __typename: "UserLibraryTrackPage", totalCount: 30, pagingInfo: { offset: 20, limit: 2 }, items: [
      { addedAt: { isoString: "2026-01-01T00:00:00Z" }, track: { _uri: trackUri, data: track() } },
      { track: { _uri: "spotify:track:Unavailable1", data: { __typename: "NotFound" } } },
    ],
  } } } } }));
  const result = await backend.liked({ offset: 20, limit: 2 });
  assert.deepEqual(calls[0].options.body.variables, { offset: 20, limit: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].addedAt, "2026-01-01T00:00:00Z");
  assert.equal(result.items[1].uri, "spotify:track:Unavailable1");
  assert.equal(result.items[1].name, null);
  assert.equal(result.items[1].isPlayable, false);
  assert.equal(result.nextOffset, 22);
  assert.equal(result.total, 30);
});

test("playlist reads expose exact row UIDs and playlist revision without losing track metadata", async () => {
  const { backend, calls } = mock(() => ({ data: { playlistV2: { __typename: "Playlist", uri: playlistUri,
    name: "A Playlist", description: "Example", revisionId: "revision1", ownerV2: { data: { name: "Owner" } },
    content: { items: [{ uid: "row1", itemV2: { data: track() } }], totalCount: 1,
      pagingInfo: { offset: 0, limit: 20, nextOffset: null } },
  } } }));
  const result = await backend.playlist({ uri: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=example" });
  assert.equal(calls[0].options.body.variables.uri, playlistUri);
  assert.equal(result.items[0].uid, "row1");
  assert.equal(result.revision, "revision1");
  assert.equal(result.nextOffset, null);
  assert.equal(result.owner, "Owner");
});

test("library uses documented filter IDs and root page query with optional text search", async () => {
  const { backend, calls } = mock(() => ({ data: { me: { libraryV3: {
    items: [{ depth: 0, item: { data: { uri: playlistUri, name: "Saved Playlist" } } }], totalCount: 1,
    pagingInfo: { offset: 0, limit: 20 },
  } } } }));
  const result = await backend.library({ filter: "playlist", query: "Saved" });
  const variables = calls[0].options.body.variables;
  assert.deepEqual(variables.filters, ["Playlists"]);
  assert.equal(variables.flatten, true);
  assert.equal(variables.folderUri, null);
  assert.equal(variables.textFilter, "Saved");
  assert.equal(result.items[0].name, "Saved Playlist");
});

test("save sends one explicit mutation and verifies membership without replay on uncertain confirmation", async () => {
  let reads = 0;
  const { backend, calls } = mock((_url, { body }) => {
    if (body.operationName === "addToLibrary") return { data: { addToLibrary: {} } };
    reads++;
    return { data: { lookup: [{ data: { saved: false } }] } };
  });
  await assert.rejects(backend.run("save", { uris: trackUri }), { code: "STATE_NOT_CONFIRMED" });
  assert.equal(reads, 1);
  assert.equal(calls.filter(({ options }) => options.body.operationName === "addToLibrary").length, 1);
  assert.deepEqual(calls[0].options.body.variables, { libraryItemUris: [trackUri], interactionId: null });
  assert.deepEqual(await backend.contains({ uris: trackUri }), [{ uri: trackUri, saved: false }]);
});

test("unsave uses removeFromLibrary once and returns confirmed membership", async () => {
  const { backend, calls } = mock((_url, { body }) => body.operationName === "removeFromLibrary"
    ? { data: { removeFromLibrary: {} } } : { data: { lookup: [{ data: { saved: false } }] } });
  assert.deepEqual(await backend.run("unsave", { uris: [trackUri] }), [{ uri: trackUri, saved: false }]);
  assert.deepEqual(calls[0].options.body.variables, { libraryItemUris: [trackUri] });
  assert.equal(calls.length, 2);
});

test("generic query cannot invoke pinned mutations and errors cannot expose upstream diagnostics", async () => {
  const { backend, calls } = mock(() => ({ errors: [{ message: "SECRET-service-diagnostic" }] }));
  await assert.rejects(backend.query("addToLibrary", { libraryItemUris: [trackUri] }), { code: "UNSUPPORTED" });
  assert.equal(calls.length, 0);
  await assert.rejects(backend.search({ query: "Example" }), (error) => error.code === "QUERY_ERROR" && !error.message.includes("SECRET"));
  const missing = mock(() => ({ errors: [{ message: "PersistedQueryNotFound" }] })).backend;
  await assert.rejects(missing.liked(), { code: "QUERY_VERSION_UNSUPPORTED" });
});

test("recent contexts use native recent endpoint with authenticated profile identity and lookup metadata", async () => {
  const { backend, calls } = mock((url, { body }) => {
    if (body?.operationName === "profileAttributes") return { data: { me: { profile: { username: "testaccount" } } } };
    if (url.includes("/recently-played/v3/")) return { playContexts: [{ uri: trackUri, lastPlayedTime: 1234 }] };
    return { data: { lookup: [{ _uri: trackUri, data: track() }] } };
  });
  const result = await backend.recent();
  assert.equal(calls[1].url, "https://gew1-spclient.spotify.com/recently-played/v3/user/testaccount/recently-played");
  assert.equal(result[0].timestampMs, 1234);
  assert.equal(result[0].name, "Veridis Quo");
});

test("bad arguments and unimplemented operations fail before any network request", async () => {
  const { backend, calls } = mock(() => { throw new Error("Unexpected network"); });
  for (const args of [{ query: "" }, { query: "x", limit: 0 }, { query: "x", offset: -1 }, { query: "x", type: "unknown" }, { query: "x", type: "constructor" }])
    await assert.rejects(backend.search(args), { code: "INVALID_ARGUMENT" });
  await assert.rejects(backend.library({ filter: "constructor" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(backend.playlist({ uri: "https://evil.test/playlist/abc" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(backend.run("history"), { code: "UNSUPPORTED" });
  await assert.rejects(backend.run("queue"), { code: "UNSUPPORTED" });
  assert.equal(calls.length, 0);
  assert.equal(normalizeCatalogItem(null), null);
});
