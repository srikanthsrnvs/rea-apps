import test from "node:test";
import assert from "node:assert/strict";
import { NativePlaylistBackend, parseRootlist, PLAYLIST_MANIFEST } from "../src/standalone/playlist-backend.mjs";

const playlist = "spotify:playlist:ExamplePlaylist1";
const trackA = "spotify:track:ExampleTrackA", trackB = "spotify:track:ExampleTrackB";
const hashA = "0000000000000001", hashB = "0000000000000002";
const folderA = `spotify:user:account:folder:${hashA}`;
const folderB = `spotify:user:account:folder:${hashB}`;
const item = (uid, uri = trackA) => ({ uid, itemV2: { data: { __typename: "Track", uri, name: uri } } });
const rootPayload = (uris = [playlist]) => ({ revision: "AAAAAQ==", length: uris.length,
  contents: { pos: 0, truncated: false, items: uris.map((uri) => ({ uri, attributes: { public: false } })),
    metaItems: uris.map(() => ({ attributes: { name: "Playlist" }, ownerUsername: "account" })) } });
function fixture({ items = [item("uidA"), item("uidB", trackB)], root = rootPayload(), onMutation } = {}) {
  const state = { items, revision: 1, root, permission: { permissionLevel: "VIEWER", revision: "permissionRevision" },
    name: "Playlist", description: "Before", calls: [], rootReads: 0 };
  const catalog = {
    profile: async () => ({ username: "account" }),
    playlist: async () => ({ uri: playlist, name: state.name, description: state.description, items: [] }),
    query: async (_name, variables) => ({ playlistV2: { __typename: "Playlist", uri: playlist, name: state.name,
      revisionId: `revision${state.revision}`, description: state.description,
      content: { totalCount: state.items.length, items: state.items.slice(variables.offset, variables.offset + variables.limit) } } }),
  };
  const backend = new NativePlaylistBackend({ catalog, spclientBaseUrl: "https://gew1-spclient.spotify.com",
    request: async (url, options = {}) => {
      assert.doesNotMatch(url, /^https:\/\/api\.spotify\.com\//u);
      state.calls.push({ url, options });
      if (url.endsWith("/permission/base")) {
        if (options.method === "POST") state.permission = { ...options.body };
        return state.permission;
      }
      if (url.endsWith("/rootlist")) { state.rootReads++; return state.root; }
      if (url.endsWith("/rootlist/changes")) {
        if (onMutation) return onMutation(state, url, options);
        const op = options.body.deltas[0].ops[0];
        let uris = state.root.contents.items.map(({ uri }) => uri);
        if (op.kind === "ADD") uris.push(...op.add.items.map(({ uri }) => uri));
        else if (op.kind === "REM") uris = uris.filter((uri) => !op.rem.items.some((item) => item.uri === uri));
        state.root = rootPayload(uris);
        return { revision: "AAAAAg==" };
      }
      if (url.endsWith("/playlist/v2/playlist")) return { uri: playlist };
      if (url.endsWith("/changes")) {
        const attributes = options.body.deltas[0].ops[0].updateListAttributes.newAttributes;
        if (attributes.values.name !== undefined) state.name = attributes.values.name;
        if (attributes.values.description !== undefined) state.description = attributes.values.description;
        if (attributes.noValue?.includes("LIST_DESCRIPTION")) state.description = "";
        return { revision: "AAAAAg==" };
      }
      const { operationName, variables } = options.body;
      if (onMutation) return onMutation(state, url, options);
      if (operationName === "addToPlaylist") state.items.push(...variables.playlistItemUris.map((uri, index) => item(`new${index}`, uri)));
      if (operationName === "removeFromPlaylist") state.items = state.items.filter(({ uid }) => !variables.uids.includes(uid));
      if (operationName === "moveItemsInPlaylist") {
        const moved = state.items.find(({ uid }) => uid === variables.uids[0]);
        state.items = state.items.filter(({ uid }) => uid !== moved.uid);
        const index = variables.newPosition.moveType === "TOP_OF_PLAYLIST" ? 0
          : state.items.findIndex(({ uid }) => uid === variables.newPosition.fromUid) + 1;
        state.items.splice(index, 0, moved);
      }
      state.revision++;
      return { data: { [operationName]: {} } };
    } });
  return { backend, state, catalog };
}

test("rootlist parser preserves nested folder hierarchy, exact names and playlist ownership", () => {
  const payload = rootPayload([
    `spotify:start-group:${hashA}:Jazz+%26+Soul`, playlist,
    `spotify:start-group:${hashB}:%E6%97%A5%E6%9C%AC`, "spotify:playlist:NestedPlaylist", `spotify:end-group:${hashB}`,
    `spotify:end-group:${hashA}`, "spotify:playlist:RootPlaylist",
  ]);
  const tree = parseRootlist(payload, "account");
  assert.equal(tree.folders.get(hashA).name, "Jazz & Soul");
  assert.equal(tree.folders.get(hashB).name, "日本");
  assert.equal(tree.folders.get(hashB).parent, folderA);
  assert.equal(tree.folders.get(hashA).endIndex, 5);
  assert.equal(tree.entries.find(({ uri }) => uri === playlist).folder, folderA);
  assert.equal(tree.entries.at(-1).folder, null);
  assert.equal(tree.entries.length, 5);
});

test("truncated, unbalanced and duplicate rootlist markers cannot drive folder edits", () => {
  assert.throws(() => parseRootlist({ ...rootPayload(), contents: { ...rootPayload().contents, truncated: true } }, "account"), { code: "ROOTLIST_INCOMPLETE" });
  assert.throws(() => parseRootlist(rootPayload([`spotify:start-group:${hashA}:Folder`]), "account"), { code: "INVALID_RESPONSE" });
  assert.throws(() => parseRootlist(rootPayload([`spotify:end-group:${hashA}`]), "account"), { code: "INVALID_RESPONSE" });
  assert.throws(() => parseRootlist(rootPayload([`spotify:start-group:${hashA}:Folder`, `spotify:start-group:${hashA}:Duplicate`]), "account"), { code: "INVALID_RESPONSE" });
});

test("playlist add uses pinned native GraphQL mutation and confirms duplicate-aware URI counts", async () => {
  const { backend, state } = fixture();
  const result = await backend.run("playlist-add", { uri: playlist, uris: [trackA, trackA] });
  assert.equal(result.total, 4);
  assert.equal(state.calls.length, 1);
  const body = state.calls[0].options.body;
  assert.equal(body.operationName, "addToPlaylist");
  assert.equal(body.extensions.persistedQuery.sha256Hash, PLAYLIST_MANIFEST.operations.addToPlaylist.sha256Hash);
  assert.deepEqual(body.variables.newPosition, { moveType: "BOTTOM_OF_PLAYLIST", fromUid: null });
  assert.deepEqual(body.variables.playlistItemUris, [trackA, trackA]);
});

test("remove targets exact UID even when another row has the same URI", async () => {
  const { backend, state } = fixture({ items: [item("first"), item("second")] });
  await backend.run("playlist-remove", { uri: playlist, uid: "first" });
  assert.deepEqual(state.items.map(({ uid }) => uid), ["second"]);
  assert.deepEqual(state.calls[0].options.body.variables.uids, ["first"]);
});

test("row moves produce correct final index in both directions and skip existing position", async () => {
  const { backend, state } = fixture({ items: [item("A"), item("B"), item("C")] });
  await backend.run("playlist-move", { uri: playlist, uid: "A", index: 2 });
  assert.deepEqual(state.items.map(({ uid }) => uid), ["B", "C", "A"]);
  assert.deepEqual(state.calls[0].options.body.variables.newPosition, { moveType: "AFTER_UID", fromUid: "C" });
  await backend.run("playlist-move", { uri: playlist, uid: "A", index: 0 });
  assert.deepEqual(state.items.map(({ uid }) => uid), ["A", "B", "C"]);
  await backend.run("playlist-move", { uri: playlist, uid: "A", index: 0 });
  assert.equal(state.calls.length, 2);
});

test("an accepted-but-unconfirmed mutation is never automatically replayed", async () => {
  const { backend, state } = fixture({ onMutation: () => ({ data: { removeFromPlaylist: {} } }) });
  await assert.rejects(backend.remove({ uri: playlist, uid: "uidA" }), { code: "STATE_NOT_CONFIRMED" });
  assert.equal(state.calls.length, 1);
});

test("playlist mutation refuses a snapshot that changes revision during pagination", async () => {
  const { backend, state, catalog } = fixture();
  let page = 0;
  catalog.query = async () => ({ playlistV2: { __typename: "Playlist", revisionId: `r${++page}`,
    content: { totalCount: 101, items: [item(`row${page}`)] } } });
  await assert.rejects(backend.remove({ uri: playlist, uid: "row1" }), { code: "PLAYLIST_CHANGED" });
  assert.equal(state.calls.length, 0);
});

test("updating a description to empty uses LIST_DESCRIPTION removal rather than a default value", async () => {
  const { backend, state } = fixture();
  const result = await backend.update({ uri: playlist, name: "Changed", description: "" });
  assert.equal(result.name, "Changed");
  assert.equal(result.description, "");
  assert.deepEqual(state.calls[0].options.body.deltas[0].ops[0].updateListAttributes.newAttributes,
    { values: { name: "Changed" }, noValue: ["LIST_DESCRIPTION"] });
});

test("private creation verifies BLOCKED permission before following and never exposes it as published", async () => {
  const { backend, state } = fixture({ root: rootPayload([]) });
  const result = await backend.create({ name: "Private Playlist" });
  assert.equal(result.private, true);
  assert.equal(result.published, false);
  assert.equal(state.permission.permissionLevel, "BLOCKED");
  const writes = state.calls.filter(({ options }) => options.method === "POST");
  assert.ok(writes[0].url.endsWith("/playlist/v2/playlist"));
  assert.ok(writes[1].url.endsWith("/permission/base"));
  assert.ok(writes[2].url.endsWith("/rootlist/changes"));
  assert.equal(writes[2].options.body.deltas[0].ops[0].add.items[0].attributes.public, false);
});

test("partial private creation reports the created URI and does not retry or follow after permission failure", async () => {
  let creates = 0, follows = 0;
  const backend = new NativePlaylistBackend({ request: async (url) => {
    if (url.endsWith("/playlist/v2/playlist")) { creates++; return { uri: playlist }; }
    if (url.includes("permission/base")) throw Object.assign(new Error("SECRET internal detail"), { code: "PERMISSION_DENIED" });
    follows++; throw new Error("Should not follow");
  } });
  await assert.rejects(backend.create({ name: "Private" }), (error) => error.details.createdUri === playlist && !error.message.includes("SECRET"));
  assert.equal(creates, 1); assert.equal(follows, 0);
});

test("follow/unfollow use revision-guarded rootlist changes and confirm actual membership", async () => {
  const { backend, state } = fixture({ root: rootPayload([]) });
  assert.deepEqual(await backend.follow("playlist-follow", { uri: playlist }), { uri: playlist, saved: true });
  assert.equal(state.calls.find(({ url }) => url.endsWith("/rootlist/changes")).options.body.baseRevision, "AAAAAQ==");
  assert.deepEqual(await backend.follow("playlist-unfollow", { uri: playlist }), { uri: playlist, saved: false });
});

test("new folders use paired random markers and preserve Unicode names", async () => {
  const { backend, state } = fixture({ root: rootPayload([]) });
  const result = await backend.createFolder({ name: "日本 Jazz" });
  assert.equal(result.name, "日本 Jazz");
  assert.match(result.uri, /^spotify:user:account:folder:[a-f0-9]{16}$/u);
  const write = state.calls.find(({ url }) => url.endsWith("/rootlist/changes"));
  assert.equal(write.options.body.deltas[0].ops[0].add.items.length, 2);
});

test("folder rename replaces only its opening marker while preserving children and the closing marker", async () => {
  const original = [`spotify:start-group:${hashA}:Old`, playlist, `spotify:end-group:${hashA}`];
  const { backend, state } = fixture({ root: rootPayload(original), onMutation: (state, _url, { body }) => {
    let uris = state.root.contents.items.map(({ uri }) => uri);
    for (const op of body.deltas[0].ops) {
      if (op.kind === "ADD") {
        const index = uris.indexOf(op.add.addBeforeItem.uri);
        assert.notEqual(index, -1);
        uris.splice(index, 0, ...op.add.items.map(({ uri }) => uri));
      } else if (op.kind === "REM") uris = uris.filter((uri) => !op.rem.items.some((item) => item.uri === uri));
    }
    state.root = rootPayload(uris);
    return {};
  } });
  const result = await backend.renameFolder({ uri: folderA, name: "New Name" });
  assert.equal(result.name, "New Name");
  assert.deepEqual(state.root.contents.items.map(({ uri }) => uri),
    [`spotify:start-group:${hashA}:New+Name`, playlist, `spotify:end-group:${hashA}`]);
});

test("folder move keeps its entire contiguous range together and confirms the new parent", async () => {
  const root = rootPayload([`spotify:start-group:${hashA}:A`, playlist,
    `spotify:start-group:${hashB}:B`, `spotify:end-group:${hashB}`, `spotify:end-group:${hashA}`]);
  const { backend, state } = fixture({ root, onMutation: (state, _url, { body }) => {
    const op = body.deltas[0].ops[0];
    assert.equal(op.kind, "MOV");
    assert.deepEqual(op.mov, { fromIndex: 2, toIndex: 5, length: 2 });
    const uris = state.root.contents.items.map(({ uri }) => uri), moved = uris.splice(op.mov.fromIndex, op.mov.length);
    uris.splice(op.mov.toIndex > op.mov.fromIndex ? op.mov.toIndex - op.mov.length : op.mov.toIndex, 0, ...moved);
    state.root = rootPayload(uris);
    return {};
  } });
  const result = await backend.moveFolder({ uri: folderB, folder: "root" });
  assert.equal(result.folder, null);
  assert.equal(parseRootlist(state.root, "account").folders.get(hashB).parent, null);
});

test("folder moves use original contiguous marker boundaries and reject moving into descendants", async () => {
  const root = rootPayload([`spotify:start-group:${hashA}:A`, playlist,
    `spotify:start-group:${hashB}:B`, `spotify:end-group:${hashB}`, `spotify:end-group:${hashA}`]);
  const { backend, state } = fixture({ root });
  await assert.rejects(backend.moveFolder({ uri: folderA, folder: folderB }), { code: "INVALID_ARGUMENT" });
  assert.equal(state.calls.filter(({ options }) => options.method === "POST").length, 0);
});

test("invalid row UID, destination index and resource types cannot perform a write", async () => {
  const { backend, state } = fixture();
  await assert.rejects(backend.move({ uri: playlist, uid: "uidA", index: 99 }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(backend.remove({ uri: playlist, uid: "missing" }), { code: "NOT_FOUND" });
  await assert.rejects(backend.add({ uri: playlist, uris: [playlist] }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(backend.remove({ uri: playlist, uid: "bad\nuid" }), { code: "INVALID_ARGUMENT" });
  assert.equal(state.calls.length, 0);
});
