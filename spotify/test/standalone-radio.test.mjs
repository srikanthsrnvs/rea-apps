import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { NativeCatalogBackend, RADIO_URL } from "../src/standalone/catalog-backend.mjs";
import { playbackResult } from "../src/player.mjs";

const seedUri = "spotify:track:seed", mixUri = "spotify:playlist:generatedMix";
const track = (id = "seed", playable = true) => ({ uri: `spotify:track:${id}`, name: id,
  artists: { items: [{ profile: { name: "Artist" } }] }, playability: { playable } });
const playlistResponse = (offset = 0, limit = 20) => ({ data: { playlistV2: {
  uri: mixUri, name: "Seed Radio", revisionId: "radioRevision",
  content: { items: [{ uid: "seedRow", itemV2: { data: track() } }, { uid: "nextRow", itemV2: { data: track("next") } }].slice(offset, offset + limit),
    totalCount: 2, pagingInfo: { offset, limit } },
} } });

test("song radio uses the shipped inspiredby-mix contract and preserves playlist identity and pagination", async () => {
  const calls = [];
  const backend = new NativeCatalogBackend({ spclientBaseUrl: "https://gew1-spclient.spotify.com", request: async (url, options) => {
    calls.push({ url, options });
    return url.startsWith(RADIO_URL) ? { total: 1, mediaItems: [{ uri: mixUri }], privateDiagnostic: "omit" } : playlistResponse(1, 1);
  } });
  const result = await backend.radio({ uri: "https://open.spotify.com/intl-en/track/seed?si=x", offset: 1, limit: 1 });
  assert.equal(calls[0].url, `${RADIO_URL}/${seedUri}`);
  assert.deepEqual(calls[0].options.query, { "response-format": "json" });
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].options.body.operationName, "fetchPlaylist");
  assert.equal(calls[1].options.body.variables.uri, mixUri);
  assert.equal(result.seedUri, seedUri);
  assert.equal(result.uri, mixUri);
  assert.equal(result.name, "Seed Radio");
  assert.equal(result.items[0].uid, "nextRow");
  assert.equal(result.items[0].uri, "spotify:track:next");
  assert.equal(result.offset, 1); assert.equal(result.total, 2); assert.equal(result.nextOffset, null);
  assert.equal(result.url, "https://open.spotify.com/playlist/generatedMix");
  assert.ok(!JSON.stringify(result).includes("privateDiagnostic"));
});

test("radio rejects wrong seed types before requests and never invents results for empty, malformed or failed responses", async () => {
  let response, calls = 0;
  const backend = new NativeCatalogBackend({ request: async () => { calls++; if (response instanceof Error) throw response; return response; } });
  for (const uri of ["spotify:album:one", "spotify:playlist:one", "spotify:track:../x", "https://evil.test/track/one"])
    await assert.rejects(backend.radio({ uri }), { code: "INVALID_ARGUMENT" });
  assert.equal(calls, 0);
  for (const data of [{}, { mediaItems: [{ uri: "https://evil.test/playlist/x" }] }, { mediaItems: [{ uri: seedUri }] }]) {
    response = data; const before = calls;
    await assert.rejects(backend.radio({ uri: seedUri }), { code: "INVALID_RESPONSE" });
    assert.equal(calls, before + 1);
  }
  response = { total: 0, mediaItems: [] };
  await assert.rejects(backend.radio({ uri: seedUri }), { code: "RADIO_UNAVAILABLE" });
  response = Object.assign(new Error("Rate limited"), { code: "RATE_LIMITED", details: { retryAfterSeconds: 20 } });
  const before = calls;
  await assert.rejects(backend.radio({ uri: seedUri }), error => error.code === "RATE_LIMITED" && error.details.retryAfterSeconds === 20);
  assert.equal(calls, before + 1);
});

test("native radio preview stays read-only; query resolution and radio playback use the generated context without desktop imports or retries", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spotify-radio-"));
  process.env.SPOTIFY_STATE_DIR = directory;
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (/(?:^|\/)(?:cdp|runtime|auth-runtime|desktop-client|desktop-lifecycle)\.mjs$/.test(specifier)) throw Error("Loaded desktop code");
    return next(specifier, context);
  } });
  const { execute } = await import("../src/client.mjs");
  const { saveState, readState } = await import("../src/standalone/state.mjs");
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
  t.after(async () => { hook.deregister(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; await fs.rm(directory, { recursive: true, force: true }); });
  await saveState("session", { accessToken: "private-test", refreshToken: "private-refresh", controllerId: "radio-test", username: "listener", expiresAt: Date.now() + 3600000 });
  let sockets = 0, lostResponse = false;
  const calls = [], cluster = { timestamp: String(Date.now()), active_device_id: "speaker", devices: {
    speaker: { device_id: "speaker", name: "Speaker", can_play: true, capabilities: { can_be_player: true, is_controllable: true } },
  }, player_state: { is_paused: true, context_uri: "spotify:playlist:old", track: { uri: "spotify:track:old" }, options: {}, restrictions: {} } };
  globalThis.WebSocket = class {
    constructor() { sockets++; this.readyState = 1; this.listeners = new Map(); queueMicrotask(() => this.message({ type: "message", uri: "hm://pusher/v1/connections/test", headers: { "Spotify-Connection-Id": "welcome" } })); }
    addEventListener(name, handler) { this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]); }
    emit(name, event) { for (const handler of this.listeners.get(name) ?? []) handler(event); }
    message(value) { this.emit("message", { data: JSON.stringify(value) }); }
    send(text) { if (JSON.parse(text).type === "ping") queueMicrotask(() => this.message({ type: "pong" })); }
    close() { this.readyState = 3; this.emit("close", {}); }
  };
  globalThis.fetch = async (input, options) => {
    const url = new URL(input), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body });
    if (url.hostname === "apresolve.spotify.com") return Response.json({ dealer: ["guc3-dealer.spotify.com"], spclient: ["guc3-spclient.spotify.com"] });
    if (url.pathname.startsWith("/inspiredby-mix/")) return Response.json({ total: 1, mediaItems: [{ uri: mixUri }] });
    if (body?.operationName === "searchTracks") return Response.json({ data: { searchV2: { tracksV2: { items: [{ item: { data: track("unavailable", false) } }, { item: { data: track() } }], totalCount: 2 } } } });
    if (body?.operationName === "fetchPlaylist") return Response.json(playlistResponse(body.variables.offset, body.variables.limit));
    if (url.pathname.endsWith("/cluster") || options.method === "PUT") return Response.json(structuredClone(cluster));
    if (url.pathname.includes("/player/command/")) {
      assert.equal(await readState("read-cache"), null);
      assert.equal(body.command.endpoint, "play");
      assert.equal(body.command.context.uri, mixUri);
      assert.equal(body.command.context.url, `context://${mixUri}`);
      assert.equal(body.command.options.skip_to.track_index, 1);
      if (lostResponse) throw Error("Reply lost");
      cluster.player_state.is_paused = false; cluster.player_state.context_uri = mixUri;
      cluster.player_state.track = { uri: "spotify:track:next" };
      return Response.json({ ack_id: "ack" });
    }
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    throw Error("Unexpected request");
  };
  for (const input of [{}, { uri: seedUri, query: "Song" }, { uri: "spotify:album:one" }])
    await assert.rejects(execute("radio", input), { code: "INVALID_ARGUMENT" });
  assert.equal(calls.length, 0);
  const first = await execute("radio", { uri: seedUri });
  assert.equal(first.uri, mixUri); assert.equal(sockets, 0);
  const before = calls.length;
  await execute("radio", { uri: seedUri }); assert.equal(calls.length, before, "Repeated previews reuse account-scoped read snapshots");
  await execute("radio", { uri: seedUri, refresh: true }); assert.equal(calls.length, before + 3, "Refresh also resolves current native service endpoints");
  assert.equal((await execute("radio", { query: "Song name" })).seedUri, seedUri);
  assert.equal(sockets, 0); assert.equal(cluster.player_state.context_uri, "spotify:playlist:old");
  await assert.rejects(execute("radio-play", { uri: seedUri, index: 2 }), { code: "INVALID_ARGUMENT" });
  assert.equal(sockets, 0);
  const result = await execute("radio-play", { uri: seedUri, index: 1 });
  assert.equal(result.state, "playing"); assert.equal(result.context, mixUri); assert.equal(result.radio.seedUri, seedUri);
  assert.ok(playbackResult("radio-play", result).component);
  assert.equal(sockets, 1); assert.equal(calls.filter(c => c.url.pathname.includes("/player/command/")).length, 1);
  lostResponse = true;
  await assert.rejects(execute("radio-play", { uri: seedUri, index: 1 }), error => error.code === "NETWORK_ERROR" && error.details.radioUri === mixUri);
  assert.equal(calls.filter(c => c.url.pathname.includes("/player/command/")).length, 2, "The uncertain play was attempted only once");
});
