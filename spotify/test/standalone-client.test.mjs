import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spotify-read-client-"));
process.env.SPOTIFY_STATE_DIR = directory;
// Native commands must not even import the historical desktop/renderer code.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (/(?:^|\/)(?:cdp|runtime|auth-runtime|desktop-client|desktop-lifecycle)\.mjs$/.test(specifier))
    throw Error("Native commands loaded desktop code");
  return next(specifier, context);
} });
const { execute } = await import("../src/client.mjs");
const { readState, saveState } = await import("../src/standalone/state.mjs");
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
test.after(async () => { hook.deregister(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; await fs.rm(directory, { recursive: true, force: true }); });
test("normal native CLI dispatch reuses reads, refreshes on demand, and invalidates before mutations and logout", async () => {
  await saveState("session", { accessToken: "private-access", refreshToken: "private-refresh", controllerId: "test-id",
    username: "test-user", expiresAt: Date.now() + 3600000 });
  globalThis.WebSocket = class { constructor() { throw Error("Read path started a live player/event session"); } };
  const calls = []; let saved = false, malformed = true;
  globalThis.fetch = async (url, options) => {
    const u = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    calls.push(body?.operationName ?? u.pathname);
    if (u.hostname === "apresolve.spotify.com") return Response.json({ dealer: ["guc3-dealer.spotify.com"], spclient: ["guc3-spclient.spotify.com"] });
    if (u.pathname.endsWith("/cluster")) return Response.json({ devices: {}, player_state: {} });
    if (body?.operationName === "searchTracks") {
      if (body.variables.searchTerm === "bad response" && malformed) return Response.json({ data: {} });
      return Response.json({ data: { searchV2: {} } });
    }
    if (body?.operationName === "profileAttributes") return Response.json({ data: { me: { profile: { username: "test-user" } } } });
    if (u.pathname.endsWith("/rootlist")) return Response.json({ revision: "test-revision", length: 0, contents: { items: [] } });
    if (body?.operationName === "areEntitiesInLibrary") return Response.json({ data: { lookup: [{ data: { saved } }] } });
    if (body?.operationName === "addToLibrary") {
      assert.equal(await readState("read-cache"), null, "Invalidate disk snapshots before the first mutation");
      saved = true; return Response.json({ data: { addToLibrary: {} } });
    }
    throw Error("Unexpected network request");
  };
  await execute("status"); await execute("status"); await execute("devices", { network: false });
  await execute("volume"); await execute("shuffle"); await execute("repeat");
  assert.deepEqual(calls, ["/", "/connect-state/v1/cluster"]);
  await assert.rejects(execute("pause", {}, { expectedControllerId: "old-player-owner" }), { code: "PLAYER_SESSION_CHANGED" });
  assert.deepEqual(calls, ["/", "/connect-state/v1/cluster"], "A stale viewer cannot dispatch to another account even after waiting for the command lock");
  const search = { query: "jazz", type: "track" };
  await Promise.all([execute("search", search), execute("search", search)]);
  assert.equal(calls.filter(c => c === "searchTracks").length, 1);
  await execute("search", { ...search, refresh: true });
  assert.equal(calls.filter(c => c === "searchTracks").length, 2);
  await execute("playlists"); await execute("playlists");
  assert.equal(calls.filter(c => c.endsWith("/rootlist")).length, 1);
  const priorSearches = calls.filter(c => c === "searchTracks").length;
  await assert.rejects(execute("search", { query: "bad response", type: "track" }), { code: "INVALID_RESPONSE" });
  malformed = false;
  await execute("search", { query: "bad response", type: "track" });
  assert.equal(calls.filter(c => c === "searchTracks").length, priorSearches + 2, "A failed command never persists its invalid HTTP response");
  const uri = "spotify:track:0VjIjW4GlUZAMYd2vXMi3b";
  assert.equal((await execute("contains", { uris: uri }))[0].saved, false);
  assert.equal((await execute("save", { uris: uri }))[0].saved, true, "Confirmation bypasses the earlier membership read");
  assert.equal((await execute("contains", { uris: uri }))[0].saved, true);
  assert.equal(calls.filter(c => c === "addToLibrary").length, 1);
  assert.equal((await fs.stat(path.join(directory, "read-cache.json"))).mode & 0o777, 0o600);
  const cacheText = await fs.readFile(path.join(directory, "read-cache.json"), "utf8");
  assert.ok(!cacheText.includes("private-access")); assert.ok(!cacheText.includes("private-refresh"));
  await execute("logout"); assert.equal(await readState("read-cache"), null);
});
