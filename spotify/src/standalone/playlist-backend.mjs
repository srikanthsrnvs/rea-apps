import { randomBytes } from "node:crypto";
import { NativeCatalogBackend, PATHFINDER_URL, QUERY_MANIFEST, normalizeCatalogItem } from "./catalog-backend.mjs";
import { spotifyUri, spotifyUris, spotifyId } from "./uri.mjs";

// Contracts inspected in the first-party web-player artifact pinned by the
// catalog manifest: mutation adapters, RootlistAPI, ListChangesBuilder, and
// generated playlist4 protobuf JSON serializers. No downloaded code executes.
export const PLAYLIST_MANIFEST = Object.freeze({
  version: 1, source: QUERY_MANIFEST.sources.web,
  operations: Object.freeze(Object.fromEntries(["addToPlaylist", "removeFromPlaylist", "moveItemsInPlaylist"].map((name) =>
    [name, Object.freeze({ name, operation: "mutation", sha256Hash: "b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a" })]))),
  endpoints: Object.freeze({
    playlist: "/playlist/v2/playlist", playlistChanges: "/playlist/v2/playlist/{id}/changes",
    rootlist: "/playlist/v2/user/{username}/rootlist", rootlistChanges: "/playlist/v2/user/{username}/rootlist/changes",
    basePermission: "/playlist-permission/v1/playlist/{id}/permission/base",
  }),
});

const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) }); };
const invalid = () => fail("INVALID_RESPONSE", "Spotify returned an invalid playlist response.");
const uncertain = () => fail("STATE_NOT_CONFIRMED", "The playlist change was sent but has not been confirmed. Read its state before retrying.");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nameText = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\x00-\x1f\x7f]/u.test(value))
    fail("INVALID_ARGUMENT", "A nonempty name of at most 300 characters is required.");
  return value;
};
const descriptionText = (value) => {
  if (typeof value !== "string" || value.length > 10000 || /\x00/u.test(value))
    fail("INVALID_ARGUMENT", "Description must be a string of at most 10000 characters.");
  return value;
};
const exactUid = (value) => {
  if (typeof value !== "string" || !value.length || value.length > 256 || /[\x00-\x20\x7f]/u.test(value))
    fail("INVALID_ARGUMENT", "An exact row UID from the playlist is required.");
  return value;
};
const delta = (ops) => ({ ops, info: { source: { client: "CLIENT", app: "rea-apps" } } });
const changes = (ops, revision) => ({ ...(revision ? { baseRevision: revision } : {}), deltas: [delta(ops)] });
const attributesOperation = (values, noValue = []) => ({
  kind: "UPDATE_LIST_ATTRIBUTES", updateListAttributes: { newAttributes: { values, ...(noValue.length ? { noValue } : {}) } },
});
const marker = (hash, name) => `spotify:start-group:${hash}${name === undefined ? "" : `:${encodeURIComponent(name.replace(/\s+/gu, " ")).replace(/%20/gu, "+")}`}`;
const endMarker = (hash) => `spotify:end-group:${hash}`;
function folderHash(uri) {
  if (typeof uri !== "string") fail("INVALID_ARGUMENT", "A Spotify folder URI is required.");
  const result = /^spotify:(?:user:[^:\s]+:)?folder:([a-fA-F0-9]{16})(?::[^\r\n]*)?$/u.exec(uri);
  if (!result) fail("INVALID_ARGUMENT", "A Spotify folder URI is required.");
  return result[1].toLowerCase();
}
const folderUri = (username, hash) => `spotify:user:${encodeURIComponent(username)}:folder:${hash}`;
const addOperation = (uris, placement = { addLast: true }, timestamp = Date.now()) => ({
  kind: "ADD", add: { ...placement, items: uris.map((uri) => ({ uri, attributes: { timestamp: String(timestamp), public: false } })) },
});
const removeOperation = (uris) => ({ kind: "REM", rem: { itemsAsKey: true, items: uris.map((uri) => ({ uri })) } });
function countUris(items) {
  const counts = new Map();
  for (const item of items) if (item.uri) counts.set(item.uri, (counts.get(item.uri) ?? 0) + 1);
  return counts;
}

export function parseRootlist(payload, username) {
  if (!object(payload) || typeof payload.revision !== "string" || !payload.revision ||
      !Array.isArray(payload.contents?.items)) invalid();
  const raw = payload.contents.items, meta = payload.contents.metaItems ?? [];
  if (payload.contents.truncated || (payload.contents.pos ?? 0) !== 0 ||
      (typeof payload.length === "number" && payload.length !== raw.length))
    fail("ROOTLIST_INCOMPLETE", "Spotify returned a partial playlist library. Folder changes require the complete rootlist.");
  const root = { type: "folder", uri: "root", name: "<root>", hash: null, parent: null,
    startIndex: -1, endIndex: raw.length, items: [] };
  const stack = [root], folders = new Map(), entries = [];
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (typeof item?.uri !== "string") invalid();
    const start = /^spotify:start-group:([a-fA-F0-9]{16}):(.*)$/u.exec(item.uri);
    const end = /^spotify:end-group:([a-fA-F0-9]{16})$/u.exec(item.uri);
    if (start) {
      const hash = start[1].toLowerCase();
      if (folders.has(hash)) invalid();
      let name; try { name = decodeURIComponent(start[2].replace(/\+/gu, " ")); } catch { invalid(); }
      const parent = stack.at(-1), node = { type: "folder", uri: folderUri(username, hash), name, hash,
        parent: parent.uri === "root" ? null : parent.uri, startIndex: index, endIndex: null, items: [] };
      parent.items.push(node); entries.push(node); folders.set(hash, node); stack.push(node);
    } else if (end) {
      if (stack.length < 2 || stack.at(-1).hash !== end[1].toLowerCase()) invalid();
      stack.pop().endIndex = index;
    } else if (/^spotify:playlist:[A-Za-z0-9]+$/u.test(item.uri)) {
      const details = meta[index] ?? {}, parent = stack.at(-1);
      const node = { uri: item.uri, type: "playlist", name: details.attributes?.name ?? null,
        description: details.attributes?.description ?? null, owner: details.ownerUsername ?? null,
        published: item.attributes?.public ?? false,
        folder: parent.uri === "root" ? null : parent.uri, index };
      parent.items.push(node); entries.push(node);
    }
  }
  if (stack.length !== 1) invalid();
  return { revision: payload.revision, raw, root, entries, folders };
}

export class NativePlaylistBackend {
  constructor({ request, catalog, spclientBaseUrl = "https://spclient.wg.spotify.com", pathfinderUrl = PATHFINDER_URL } = {}) {
    if (typeof request !== "function") throw new TypeError("An authenticated HTTP request helper is required.");
    this.request = request;
    this.catalog = catalog ?? new NativeCatalogBackend({ request, spclientBaseUrl, pathfinderUrl });
    this.base = spclientBaseUrl.replace(/\/$/u, "");
    this.pathfinderUrl = pathfinderUrl;
  }

  async #mutation(name, variables) {
    const definition = PLAYLIST_MANIFEST.operations[name];
    const result = await this.request(this.pathfinderUrl, { method: "POST", body: {
      operationName: name, variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: definition.sha256Hash } },
    } });
    if (result?.errors?.length) fail("QUERY_ERROR", "Spotify rejected the playlist change.");
    if (!object(result?.data)) invalid();
    return result.data;
  }

  async #snapshot(uri) {
    uri = spotifyUri(uri); spotifyId(uri, "playlist");
    const items = [];
    let metadata, revision, total;
    for (let offset = 0; ; offset = items.length) {
      const data = (await this.catalog.query("fetchPlaylist", { uri, offset, limit: 100,
        enableWatchFeedEntrypoint: false, includeEpisodeContentRatingsV2: false })).playlistV2;
      if (["NotFound", "GenericError"].includes(data?.__typename)) fail("NOT_FOUND", "Spotify did not return this playlist.");
      if (data?.__typename !== "Playlist" || !Array.isArray(data.content?.items) ||
          !Number.isSafeInteger(data.content.totalCount) || data.content.totalCount < 0 ||
          typeof data.revisionId !== "string" || !data.revisionId) invalid();
      if (metadata && revision !== data.revisionId)
        fail("PLAYLIST_CHANGED", "The playlist changed while reading it. Read it again before editing.");
      metadata ??= data; revision = data.revisionId; total = data.content.totalCount;
      if (total > 10000) fail("UNSUPPORTED", "Standalone playlist editing currently supports playlists of at most 10000 rows.");
      if (data.content.items.some((item) => !object(item) || typeof item.uid !== "string" || !item.uid)) invalid();
      items.push(...data.content.items.map((item) => ({ ...normalizeCatalogItem(item), uid: item.uid })));
      if (items.length >= total) break;
      if (!data.content.items.length) invalid();
    }
    if (items.length !== total || new Set(items.map(({ uid }) => uid)).size !== items.length) invalid();
    return { uri, revision, name: metadata.name, description: metadata.description ?? "", items, total };
  }

  async #rootlist() {
    const { username } = await this.catalog.profile();
    const payload = await this.request(`${this.base}/playlist/v2/user/${encodeURIComponent(username)}/rootlist`, {
      query: { decorate: "revision,length,attributes,timestamp,owner,capabilities", bustCache: Date.now() }, readTtlMs: 10000,
    });
    return { username, ...parseRootlist(payload, username) };
  }

  async #rootChanges(root, ops) {
    await this.request(`${this.base}/playlist/v2/user/${encodeURIComponent(root.username)}/rootlist/changes`,
      { method: "POST", body: changes(ops, root.revision) });
  }

  async #permissionReady(endpoint) {
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        const result = await this.request(endpoint);
        if (!object(result) || typeof result.permissionLevel !== "string") invalid();
        return result;
      } catch (error) {
        // New playlists can precede their permission resource. Retry only this
        // harmless read for the documented readiness window; never a write.
        if (Date.now() >= deadline || ![404, 500, 503].includes(error.details?.httpStatus)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  async playlists() {
    const root = await this.#rootlist();
    return { items: root.entries.map((node) => node.type === "folder"
      ? { type: "folder", uri: node.uri, name: node.name, folder: node.parent }
      : { ...node, index: undefined }), total: root.entries.length };
  }

  async contains(uris) {
    const selected = spotifyUris(uris);
    selected.forEach((uri) => spotifyId(uri, "playlist"));
    const root = await this.#rootlist(), found = new Set(root.entries.filter(({ type }) => type === "playlist").map(({ uri }) => uri));
    return selected.map((uri) => ({ uri, saved: found.has(uri) }));
  }

  async follow(name, args) {
    if (!["playlist-follow", "playlist-unfollow"].includes(name)) fail("INVALID_ARGUMENT", "Choose playlist-follow or playlist-unfollow.");
    const uri = spotifyUri(args.uri); spotifyId(uri, "playlist");
    const root = await this.#rootlist(), exists = root.entries.some((entry) => entry.type === "playlist" && entry.uri === uri);
    const saved = name === "playlist-follow";
    if (saved !== exists) await this.#rootChanges(root, [saved ? addOperation([uri]) : removeOperation([uri])]);
    const [result] = await this.contains([uri]);
    if (result.saved !== saved) uncertain();
    return result;
  }

  async create(args) {
    const name = nameText(args.name), description = args.description === undefined ? undefined : descriptionText(args.description);
    const response = await this.request(`${this.base}/playlist/v2/playlist`,
      { method: "POST", body: { ops: [attributesOperation({ name, ...(description ? { description } : {}) })] } });
    let uri;
    try { uri = spotifyUri(response?.uri); spotifyId(uri, "playlist"); } catch { invalid(); }
    try {
      const endpoint = `${this.base}/playlist-permission/v1/playlist/${spotifyId(uri, "playlist")}/permission/base`;
      const permission = await this.#permissionReady(endpoint);
      await this.request(endpoint, { method: "POST", body: { ...permission, permissionLevel: "BLOCKED" } });
      if ((await this.request(endpoint))?.permissionLevel !== "BLOCKED") uncertain();
      await this.follow("playlist-follow", { uri });
      let root = await this.#rootlist();
      if (root.entries.find((item) => item.uri === uri)?.published) {
        await this.#rootChanges(root, [{ kind: "UPDATE_ITEM_ATTRIBUTES", updateItemAttributes: {
          newAttributes: { values: { public: false } }, item: { uri },
        } }]);
        root = await this.#rootlist();
      }
      const saved = root.entries.find((item) => item.uri === uri);
      if (!saved || saved.published) uncertain();
      const result = await this.catalog.playlist({ uri });
      return { ...result, private: true, published: false };
    } catch (error) {
      // Never retry a non-idempotent create. Preserve the resulting URI so a
      // partial operation can be inspected and repaired explicitly.
      fail(error.code ?? "PLAYLIST_CREATE_INCOMPLETE", "A playlist was created, but its private setup did not finish. Inspect the created URI before retrying.", { createdUri: uri });
    }
  }

  async update(args) {
    const uri = spotifyUri(args.uri), id = spotifyId(uri, "playlist"), values = {}, noValue = [];
    if (args.name !== undefined) values.name = nameText(args.name);
    if (args.description !== undefined) {
      const description = descriptionText(args.description);
      if (description) values.description = description; else noValue.push("LIST_DESCRIPTION");
    }
    if (!Object.keys(values).length && !noValue.length) fail("INVALID_ARGUMENT", "Provide a playlist name or description.");
    await this.request(`${this.base}/playlist/v2/playlist/${id}/changes`,
      { method: "POST", body: changes([attributesOperation(values, noValue)]) });
    const result = await this.catalog.playlist({ uri });
    if ((args.name !== undefined && result.name !== args.name) ||
        (args.description !== undefined && (result.description ?? "") !== args.description)) uncertain();
    return result;
  }

  async add(args) {
    const uri = spotifyUri(args.uri); spotifyId(uri, "playlist");
    const uris = spotifyUris(args.uris);
    if (uris.some((item) => !/^spotify:(track|episode):/u.test(item)))
      fail("INVALID_ARGUMENT", "Playlists accept track or episode URIs.");
    const before = await this.#snapshot(uri);
    await this.#mutation("addToPlaylist", { playlistUri: uri, playlistItemUris: uris,
      newPosition: { moveType: "BOTTOM_OF_PLAYLIST", fromUid: null }, interactionId: null });
    const after = await this.#snapshot(uri), previous = countUris(before.items), added = countUris(uris.map((uri) => ({ uri }))), observed = countUris(after.items);
    if (![...added].every(([uri, count]) => (observed.get(uri) ?? 0) >= (previous.get(uri) ?? 0) + count)) uncertain();
    return { uri, added: uris, total: after.total, revision: after.revision };
  }

  async remove(args) {
    const uid = exactUid(args.uid), before = await this.#snapshot(args.uri);
    if (!before.items.some((item) => item.uid === uid)) fail("NOT_FOUND", "The playlist row UID was not found.");
    await this.#mutation("removeFromPlaylist", { playlistUri: before.uri, uids: [uid] });
    const after = await this.#snapshot(before.uri);
    if (after.items.some((item) => item.uid === uid)) uncertain();
    return { uri: before.uri, removedUid: uid, total: after.total, revision: after.revision };
  }

  async move(args) {
    const uid = exactUid(args.uid), index = args.index;
    if (!Number.isSafeInteger(index) || index < 0) fail("INVALID_ARGUMENT", "A nonnegative target index is required.");
    const before = await this.#snapshot(args.uri), from = before.items.findIndex((item) => item.uid === uid);
    if (from < 0) fail("NOT_FOUND", "The playlist row UID was not found.");
    if (index >= before.items.length) fail("INVALID_ARGUMENT", "Target index is outside the playlist.");
    if (index !== from) {
      const desired = before.items.filter((item) => item.uid !== uid);
      const newPosition = index === 0 ? { moveType: "TOP_OF_PLAYLIST", fromUid: null }
        : { moveType: "AFTER_UID", fromUid: desired[index - 1].uid };
      await this.#mutation("moveItemsInPlaylist", { playlistUri: before.uri, uids: [uid], newPosition });
      const after = await this.#snapshot(before.uri);
      if (after.items[index]?.uid !== uid) uncertain();
      return { uri: before.uri, uid, index, revision: after.revision };
    }
    return { uri: before.uri, uid, index, revision: before.revision };
  }

  async createFolder(args) {
    const name = nameText(args.name), root = await this.#rootlist(), hash = randomBytes(8).toString("hex");
    await this.#rootChanges(root, [addOperation([marker(hash, name), endMarker(hash)])]);
    const after = await this.#rootlist(), created = after.folders.get(hash);
    if (!created) uncertain();
    return { uri: created.uri, name: created.name, folder: created.parent };
  }

  async renameFolder(args) {
    const hash = folderHash(args.uri), name = nameText(args.name), root = await this.#rootlist(), folder = root.folders.get(hash);
    if (!folder) fail("NOT_FOUND", "The playlist folder was not found.");
    const old = root.raw[folder.startIndex].uri, renamed = marker(hash, name), temporary = marker(randomBytes(8).toString("hex"), name);
    await this.#rootChanges(root, [
      addOperation([temporary], { addBeforeItem: { uri: old } }), removeOperation([old]),
      addOperation([renamed], { addBeforeItem: { uri: temporary } }), removeOperation([temporary]),
    ]);
    const after = await this.#rootlist(), changed = after.folders.get(hash);
    if (changed?.name !== name.replace(/\s+/gu, " ")) uncertain();
    return { uri: changed.uri, name: changed.name, folder: changed.parent };
  }

  async moveFolder(args) {
    const root = await this.#rootlist();
    const movingFolder = typeof args.uri === "string" && args.uri.includes(":folder:");
    const folder = movingFolder ? root.folders.get(folderHash(args.uri)) : null;
    const playlist = movingFolder ? null : root.entries.find((entry) => entry.type === "playlist" && entry.uri === spotifyUri(args.uri));
    if (!folder && !playlist) fail("NOT_FOUND", "The playlist or folder was not found in your library.");
    const destination = args.folder === "root" ? root.root : root.folders.get(folderHash(args.folder));
    if (!destination) fail("NOT_FOUND", "The destination folder was not found.");
    const fromIndex = folder?.startIndex ?? playlist.index, length = folder ? folder.endIndex - folder.startIndex + 1 : 1,
      toIndex = destination.endIndex;
    if (folder && destination.startIndex >= folder.startIndex && destination.endIndex <= folder.endIndex)
      fail("INVALID_ARGUMENT", "A folder cannot be moved into itself or a descendant.");
    const expectedParent = destination.uri === "root" ? null : destination.uri;
    if ((folder?.parent ?? playlist?.folder ?? null) === expectedParent)
      return { uri: folder?.uri ?? playlist.uri, folder: expectedParent };
    await this.#rootChanges(root, [{ kind: "MOV", mov: { fromIndex, toIndex, length } }]);
    const after = await this.#rootlist(), observed = folder ? after.folders.get(folder.hash)
      : after.entries.find((entry) => entry.type === "playlist" && entry.uri === playlist.uri);
    if (!observed || (observed.parent ?? observed.folder ?? null) !== expectedParent) uncertain();
    return { uri: observed.uri, folder: expectedParent };
  }

  async run(name, args = {}) {
    switch (name) {
      case "playlists": return this.playlists();
      case "playlist-create": return this.create(args);
      case "playlist-update": return this.update(args);
      case "playlist-add": return this.add(args);
      case "playlist-remove": return this.remove(args);
      case "playlist-move": return this.move(args);
      case "playlist-follow": case "playlist-unfollow": return this.follow(name, args);
      case "folder-create": return this.createFolder(args);
      case "folder-rename": return this.renameFolder(args);
      case "folder-move": return this.moveFolder(args);
      default: fail("UNSUPPORTED", "Unsupported standalone playlist operation.");
    }
  }
}
