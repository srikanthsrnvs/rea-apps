import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startPlayerServer } from "../src/player/server.mjs";

test("optional viewer serves the existing component and accepts only authenticated validated controls", async () => {
  const secret = randomBytes(32).toString("base64url"), calls = [];
  const host = await startPlayerServer({ secret, expiresAt: Date.now() + 60000,
    run: async (name, args, options) => { calls.push({ name, args, options }); return { state: "playing", track: { name: "Track", uri: "spotify:track:test" } }; } });
  const origin = `http://127.0.0.1:${host.port}`;
  const rpc = (body, auth = secret) => fetch(`${origin}/rpc`, { method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const root = await fetch(origin);
    assert.equal(root.status, 200); assert.equal(root.headers.get("cache-control"), "no-store");
    assert.ok(root.headers.get("content-security-policy").includes("sha256-"));
    assert.ok(!(await root.text()).includes(secret));
    const resource = await (await fetch(`${origin}/resource`)).json(); assert.equal(resource.uri, "ui://spotify/player-v1.html");
    assert.equal((await rpc({ name: "spotify_status" }, "wrong")).status, 401);
    assert.equal((await rpc({ name: "spotify_play", arguments: { uri: "anything" } })).status, 400);
    assert.equal((await rpc({ name: "spotify_status", arguments: { token: "injected" } })).status, 400);
    assert.equal((await rpc({ name: "spotify_seek", arguments: { seconds: 12 } })).status, 400);
    const result = await (await rpc({ name: "spotify_status", arguments: { refresh: true } })).json();
    assert.equal(result.component.id, "spotify.player"); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { name: "status", args: { refresh: true }, options: { backend: "native" } });
    assert.equal((await fetch(`${origin}/rpc`, { method: "OPTIONS" })).headers.get("access-control-allow-origin"), null);
  } finally { await host.close(); }
});

test("failed viewer actions are reported once and expired links cannot control playback", async () => {
  let calls = 0;
  const secret = randomBytes(32).toString("base64url");
  const host = await startPlayerServer({ secret, expiresAt: Date.now() + 1000,
    run: async () => { calls++; throw Object.assign(Error("Device disconnected"), { code: "CONNECT_DISCONNECTED" }); } });
  try {
    const response = await fetch(`http://127.0.0.1:${host.port}/rpc`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "spotify_next", arguments: {} }) });
    const result = await response.json(); assert.equal(result.ok, false); assert.equal(result.error.code, "CONNECT_DISCONNECTED");
    assert.equal(result.component, undefined); assert.equal(calls, 1);
  } finally { await host.close(); }
  await assert.rejects(startPlayerServer({ secret, expiresAt: Date.now() - 1 }), /Invalid player session/);
});
