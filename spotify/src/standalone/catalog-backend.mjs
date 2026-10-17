// HTTP catalog/library adapter. Query identities and variables are pinned to
// shipped first-party artifacts; no renderer or downloaded JavaScript executes.
export const PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v2/query";
const desktopSource = Object.freeze({
  applicationVersion: "1.3.5.3058",
  artifact: "Spotify.app/Contents/Resources/Apps/xpui.spa",
  artifactSha256: "dd25db62f22ee19683c0cfc73db9eb82400181618b6ee9930bb48fc641b98e73",
  member: "xpui-routes-search.js",
  memberSha256: "10a424beedc76486f175fc557a177b69fd883e215841ecd75bce6f8c907041b1",
});
const webSource = Object.freeze({
  artifact: "https://open.spotifycdn.com/cdn/build/web-player/web-player.0079e2e5.js",
  artifactSha256: "1129f07952e06b00be6af909364b0a6285f80636164613019cf4fa5fefe64062",
  inspectedOn: "2026-10-17",
});
const definitions = {
  searchDesktop: ["eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03", "desktop"],
  searchTracks: ["b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751", "desktop"],
  searchAlbums: ["202cb3305e31e5a0767ba7925f28bd728cf8f8b0217e6da43909056071cd70e9", "desktop"],
  searchArtists: ["7bf95d754fdbe32c8b161fbbe54d1ae50974900df4dce4c8f1afcbcad153224d", "desktop"],
  searchPlaylists: ["d520014e748f9ea44f7707d8df1819867ac1205e8b7f3e28f22fe5fc858921b1", "desktop"],
  searchEpisodes: ["dbc56e15e7c1254f11d499e8647343bbf28a5594e14a8f5c8b1e7eee67a55740", "desktop"],
  searchPodcasts: ["0195d9f61b43606d490bca64c3456e3593528cea6cc05c7e822c7c42beed0f4e", "desktop"],
  searchUsers: ["8f358dd82e62f61dd4ceaa9f8cd0889e644c9b707f1b724fbfb356a757cb7e5a", "desktop"],
  searchAudiobooks: ["e05ac765d02c084f8783d3c1572b23d57761c43f47eb8b87ce2f9ccced3fa068", "desktop"],
  profileAttributes: ["08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0", "web"],
  fetchLibraryTracks: ["087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240", "web"],
  libraryV3: ["390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455", "web"],
  fetchPlaylist: ["21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf", "web"],
  areEntitiesInLibrary: ["134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed", "web"],
  fetchEntitiesForRecentlyPlayed: ["cf5d2e94ffd82788470788ae1f6090cc3e9e774fb8fd383580634c6e6f50f7be", "web"],
  recents: ["698be5892a3cc95331deebeff463d05dfdd5febf5254bea30b895b5a93dfb584", "web"],
  addToLibrary: ["896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148", "web", "mutation"],
  removeFromLibrary: ["896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148", "web", "mutation"],
};
export const QUERY_MANIFEST = Object.freeze({
  version: 1,
  sources: Object.freeze({ desktop: desktopSource, web: webSource }),
  operations: Object.freeze(Object.fromEntries(Object.entries(definitions).map(([name, [sha256Hash, source, operation = "query"]]) =>
    [name, Object.freeze({ name, operation, sha256Hash, source })]))),
});

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const invalidResponse = () => fail("INVALID_RESPONSE", "Spotify returned an invalid catalog response.");
const unsupported = () => fail("UNSUPPORTED", "This operation is not implemented by Spotify's standalone catalog adapter.");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function paging(args = {}) {
  const offset = args.offset ?? 0, limit = args.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    fail("INVALID_ARGUMENT", "Pagination requires a nonnegative offset and a limit from 1 to 1000.");
  return { offset, limit };
}
function resourceUri(value, requiredType) {
  if (typeof value !== "string") fail("INVALID_ARGUMENT", "A supported Spotify URI or URL is required.");
  if (value.startsWith("https://open.spotify.com/")) {
    let url; try { url = new URL(value); } catch { fail("INVALID_ARGUMENT", "Invalid Spotify URL."); }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("intl-")) parts.shift();
    if (url.username || url.password || url.port || parts.length !== 2) fail("INVALID_ARGUMENT", "Invalid Spotify URL.");
    value = `spotify:${parts[0]}:${parts[1]}`;
  }
  const match = /^spotify:(track|album|artist|playlist|episode|show|audiobook|user):([A-Za-z0-9]+)$/u.exec(value);
  if (!match || (requiredType && match[1] !== requiredType)) fail("INVALID_ARGUMENT", "A supported Spotify resource URI is required.");
  return value;
}
function uriList(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  if (!items.length || items.length > 1000) fail("INVALID_ARGUMENT", "Supply between 1 and 1000 Spotify URIs.");
  return items.map((uri) => resourceUri(uri));
}
const rows = (value) => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
const safeText = (value) => typeof value === "string" ? value : null;

export function normalizeCatalogItem(entry) {
  if (!isObject(entry)) return null;
  const wrapper = entry.track ?? entry.itemV2 ?? entry.item ?? entry.entity ?? entry;
  const data = wrapper.data ?? wrapper;
  if (!isObject(data)) return null;
  const uri = safeText(data.uri ?? wrapper._uri ?? entry.uri ?? entry._uri);
  const identity = data.identityTrait?.__typename === "IdentityTrait" ? data.identityTrait : null;
  const contributors = rows(identity?.contributors);
  const artists = rows(data.artists).length ? rows(data.artists) : contributors;
  const album = data.albumOfTrack ?? data.album;
  const image = rows(data.coverArt?.sources)[0] ?? rows(album?.coverArt?.sources)[0]
    ?? rows(data.images?.items?.[0]?.sources)[0] ?? rows(data.visuals?.avatarImage?.sources)[0]
    ?? rows(data.visualIdentityTrait?.squareCoverImage?.image?.data?.sources)[0];
  const consumption = data.consumptionExperienceTrait;
  const durationMs = data.duration?.totalMilliseconds ?? data.duration?.milliseconds
    ?? data.trackDuration?.totalMilliseconds ?? data.episodeDuration?.totalMilliseconds
    ?? (consumption?.duration ? (consumption.duration.seconds ?? 0) * 1000 + Math.floor((consumption.duration.nanoSeconds ?? 0) / 1e6) : null);
  return {
    uri, type: uri?.split(":")[1] ?? null,
    name: safeText(data.name ?? data.profile?.name ?? data.title ?? identity?.name),
    artists: artists.map((artist) => safeText(artist.name ?? artist.profile?.name ?? artist.data?.name)).filter(Boolean),
    album: safeText(album?.name ?? identity?.contentHierarchyParent?.identityTrait?.name),
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    uid: safeText(entry.uid ?? data.uid), provider: safeText(data.provider),
    isPlayable: typeof data.playability?.playable === "boolean" ? data.playability.playable
      : typeof data.isPlayable === "boolean" ? data.isPlayable
        : ["NotFound", "GenericError", "RestrictedContent", "UnknownType"].includes(data.__typename) ? false : null,
    ...(image?.url ? { imageUrl: image.url } : {}),
    ...(entry.addedAt ? { addedAt: entry.addedAt.isoString ?? entry.addedAt } : {}),
    ...(data.ownerV2?.data || data.owner ? { owner: data.ownerV2?.data?.name ?? data.ownerV2?.data?.username
      ?? data.owner?.displayName ?? data.owner?.username ?? null } : {}),
    ...(typeof entry.depth === "number" ? { depth: entry.depth } : {}),
  };
}

function normalizePage(data, { offset, limit }) {
  if (!isObject(data) || !Array.isArray(data.items)) invalidResponse();
  const total = data.totalCount ?? null;
  const actualOffset = data.pagingInfo?.offset ?? offset;
  const hasNext = Object.hasOwn(data.pagingInfo ?? {}, "nextOffset");
  return {
    items: data.items.map(normalizeCatalogItem).filter(Boolean),
    offset: actualOffset, limit: data.pagingInfo?.limit ?? limit, total,
    nextOffset: hasNext ? data.pagingInfo.nextOffset
      : data.items.length && (total === null || actualOffset + data.items.length < total) ? actualOffset + data.items.length : null,
  };
}

export class NativeCatalogBackend {
  constructor({ request, spclientBaseUrl = "https://spclient.wg.spotify.com", pathfinderUrl = PATHFINDER_URL } = {}) {
    if (typeof request !== "function") throw new TypeError("An authenticated HTTP request helper is required.");
    this.request = request;
    this.spclientBaseUrl = spclientBaseUrl.replace(/\/$/u, "");
    this.pathfinderUrl = pathfinderUrl;
  }

  async #graphql(name, variables, mutation = false) {
    const definition = QUERY_MANIFEST.operations[name];
    if (!definition || (!mutation && definition.operation !== "query"))
      fail("UNSUPPORTED", "The requested read query is not in the pinned Spotify query manifest.");
    if (!isObject(variables)) fail("INVALID_ARGUMENT", "Query variables must be a JSON object.");
    const response = await this.request(this.pathfinderUrl, {
      method: "POST", body: { operationName: name, variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: definition.sha256Hash } } },
    });
    if (response?.errors?.length) {
      if (response.errors.some((error) => error?.message === "PersistedQueryNotFound"))
        fail("QUERY_VERSION_UNSUPPORTED", "Spotify no longer recognizes this pinned query version. Update the CLI query manifest.");
      fail("QUERY_ERROR", "Spotify rejected the catalog query.");
    }
    if (!isObject(response?.data)) invalidResponse();
    return response.data;
  }

  async query(name, variables = {}) { return this.#graphql(name, variables); }

  async profile() {
    const data = (await this.#graphql("profileAttributes", {})).me?.profile;
    if (!isObject(data) || typeof data.username !== "string" || !data.username) invalidResponse();
    return { username: data.username, uri: safeText(data.uri), displayName: safeText(data.name),
      images: rows(data.avatar?.sources).map(({ url, width, height }) => ({ url, width, height })) };
  }

  async search(args = {}) {
    const { offset, limit } = paging(args), type = args.type ?? "all";
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 1000)
      fail("INVALID_ARGUMENT", "Search terms are required and must not exceed 1000 characters.");
    const operations = { all: "searchDesktop", track: "searchTracks", album: "searchAlbums", artist: "searchArtists",
      playlist: "searchPlaylists", episode: "searchEpisodes", show: "searchPodcasts", user: "searchUsers", audiobook: "searchAudiobooks" };
    const operation = Object.hasOwn(operations, type) ? operations[type] : undefined;
    if (!operation) fail("INVALID_ARGUMENT", "Unsupported Spotify search category.");
    const data = (await this.#graphql(operation, {
      searchTerm: args.query, offset, limit, numberOfTopResults: limit,
      includeAudiobooks: true, includeArtistHasConcertsField: false, includeLocalConcertsField: false,
      includePreReleases: false, includeAlbumPreReleases: false, includeAuthors: false,
      includeEpisodeContentRatingsV2: false,
    })).searchV2;
    if (!isObject(data)) invalidResponse();
    const result = { query: args.query, offset, limit };
    for (const [key, native] of Object.entries({ tracks: "tracksV2", albums: "albumsV2", artists: "artists",
      playlists: "playlists", episodes: "episodes", shows: "podcasts", users: "users", audiobooks: "audiobooks", topResults: "topResultsV2" })) {
      if (data[native]) result[key] = normalizePage(data[native], { offset, limit });
    }
    return result;
  }

  async liked(args = {}) {
    const page = paging(args);
    const data = (await this.#graphql("fetchLibraryTracks", page)).me?.library?.tracks;
    return normalizePage(data, page);
  }

  async library(args = {}) {
    const page = paging(args);
    const filters = { playlist: "Playlists", album: "Albums", artist: "Artists", show: "Podcasts & Shows" };
    const filter = Object.hasOwn(filters, args.filter) ? filters[args.filter] : undefined;
    if (args.filter && !filter) fail("INVALID_ARGUMENT", "Unsupported library filter.");
    if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 1000))
      fail("INVALID_ARGUMENT", "Library search terms must be a string of at most 1000 characters.");
    const data = (await this.#graphql("libraryV3", {
      filters: filter ? [filter] : [], order: null, textFilter: args.query || null,
      features: ["YOUR_EPISODES_V2", "PRERELEASES", "PRERELEASES_V2", "EVENTS"], ...page,
      flatten: !!args.query, expandedFolders: [], folderUri: null, includeFoldersWhenFlattening: true,
    })).me?.libraryV3;
    return normalizePage(data, page);
  }

  async playlist(args = {}) {
    const page = paging(args), uri = resourceUri(args.uri, "playlist");
    const data = (await this.#graphql("fetchPlaylist", {
      uri, ...page, enableWatchFeedEntrypoint: false, includeEpisodeContentRatingsV2: false,
    })).playlistV2;
    if (!isObject(data) || ["NotFound", "GenericError"].includes(data.__typename))
      fail("NOT_FOUND", "Spotify did not return this playlist.");
    return { uri: data.uri ?? uri, name: safeText(data.name), description: safeText(data.description),
      owner: data.ownerV2?.data?.name ?? data.ownerV2?.data?.username ?? null,
      revision: safeText(data.revisionId), ...normalizePage(data.content, page) };
  }

  async contains(args = {}) {
    const uris = uriList(args.uris);
    if (uris.some((uri) => !/^spotify:(track|album|artist|episode|show):/u.test(uri)))
      fail("UNSUPPORTED", "Library membership currently supports tracks, albums, artists, episodes and shows.");
    const lookup = (await this.#graphql("areEntitiesInLibrary", { uris })).lookup;
    if (!Array.isArray(lookup) || lookup.length !== uris.length || lookup.some((row) => typeof row?.data?.saved !== "boolean")) invalidResponse();
    return uris.map((uri, index) => ({ uri, saved: lookup[index].data.saved }));
  }

  async changeSaved(name, args = {}) {
    const uris = uriList(args.uris);
    if (uris.some((uri) => !/^spotify:(track|album|artist|episode|show):/u.test(uri)))
      fail("UNSUPPORTED", "Library changes currently support tracks, albums, artists, episodes and shows.");
    await this.#graphql(name === "save" ? "addToLibrary" : "removeFromLibrary",
      { libraryItemUris: uris, ...(name === "save" ? { interactionId: null } : {}) }, true);
    // A failed confirmation must never replay the mutation automatically.
    const observed = await this.contains({ uris });
    if (!observed.every((entry) => entry.saved === (name === "save")))
      fail("STATE_NOT_CONFIRMED", "The library change was sent but has not been confirmed. Read membership before retrying.");
    return observed;
  }

  async recent() {
    const profile = await this.profile();
    const result = await this.request(`${this.spclientBaseUrl}/recently-played/v3/user/${encodeURIComponent(profile.username)}/recently-played`,
      { query: { format: "json", offset: 0, limit: 50, filter: "default,collection-new-episodes" } });
    if (!Array.isArray(result?.playContexts)) invalidResponse();
    const contexts = result.playContexts;
    const uris = contexts.map(({ uri }) => uri).filter((uri) => typeof uri === "string" && !/^spotify:user:/u.test(uri));
    const lookup = uris.length ? (await this.#graphql("fetchEntitiesForRecentlyPlayed", { uris })).lookup : [];
    if (!Array.isArray(lookup)) invalidResponse();
    const metadata = new Map(lookup.map((row) => [row._uri ?? row.data?.uri, normalizeCatalogItem(row)]));
    return contexts.map((context) => ({ ...(metadata.get(context.uri) ?? { uri: context.uri,
      type: context.uri?.split(":")[1] ?? null, name: null }), timestampMs: context.lastPlayedTime ?? null }));
  }

  async run(name, args = {}) {
    switch (name) {
      case "profile": return this.profile();
      case "search": return this.search(args);
      case "liked": return this.liked(args);
      case "library": return this.library(args);
      case "playlists": return this.library({ ...args, filter: "playlist" });
      case "playlist": return this.playlist(args);
      case "contains": return this.contains(args);
      case "save": case "unsave": return this.changeSaved(name, args);
      case "recent": return this.recent();
      case "query": return this.query(args.name, args.variables ?? {});
      case "queries": return { manifestVersion: QUERY_MANIFEST.version,
        sources: QUERY_MANIFEST.sources,
        items: Object.values(QUERY_MANIFEST.operations).filter(({ operation }) => operation === "query") };
      default: unsupported();
    }
  }
}
