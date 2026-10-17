import test from "node:test";
import assert from "node:assert/strict";
import { createReadCache, cacheRequests } from "../src/standalone/read-cache.mjs";
import { QUERY_MANIFEST, PATHFINDER_URL } from "../src/standalone/catalog-backend.mjs";

function harness(extra = {}) {
  let saved, time = 10000, writes = 0;
  const options = { namespace: "account-a", now: () => time, read: async () => structuredClone(saved),
    write: async (_, value) => { saved = structuredClone(value); writes++; }, ...extra };
  return { cache: createReadCache(options), next: () => createReadCache(options),
    advance: n => { time += n; }, get saved() { return saved; }, get writes() { return writes; } };
}
test("concurrent identical reads share a request; CLI processes reuse bounded private snapshots", async () => {
  const h = harness(); let calls = 0;
  const fetch = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return { rows: ["song"] }; };
  const [a, b] = await Promise.all([h.cache.get("query", 15000, fetch), h.cache.get("query", 15000, fetch)]);
  a.rows.push("changed"); assert.deepEqual(b.rows, ["song"]); assert.equal(calls, 1);
  await h.cache.flush(); assert.equal(h.writes, 1);
  const next = h.next(); assert.deepEqual((await next.get("query", 15000, fetch)).rows, ["song"]);
  assert.equal(calls, 1);
  h.advance(15001); await next.get("query", 15000, fetch); assert.equal(calls, 2);
  assert.ok(!JSON.stringify(h.saved).includes('"query"'), "Only hashed request identities are stored");
});
test("refresh replaces old values, failures never become hits, and different accounts never share data", async () => {
  const h = harness(); let calls = 0;
  const fetch = async () => ({ n: ++calls });
  await h.cache.get("k", 1000, fetch); assert.deepEqual(await h.cache.get("k", 1000, fetch, { refresh: true }), { n: 2 });
  await h.cache.flush(); assert.deepEqual(await h.next().get("k", 1000, fetch), { n: 2 });
  const different = createReadCache({ namespace: "account-b", now: () => 10000, read: async () => h.saved });
  assert.deepEqual(await different.get("k", 1000, fetch), { n: 3 });
  let rejected = 0;
  const fail = async () => { rejected++; throw Object.assign(Error("rate limited"), { code: "RATE_LIMITED" }); };
  for (let i = 0; i < 2; i++) await assert.rejects(h.cache.get("error", 1000, fail), { code: "RATE_LIMITED" });
  assert.equal(rejected, 2);
});
test("cache storage is bounded and corrupt/unwritable caches do not break fresh reads", async () => {
  const h = harness({ maxEntries: 2, maxBytes: 1024, maxEntryBytes: 400 });
  for (let i = 0; i < 5; i++) await h.cache.get(String(i), 1000, async () => i);
  await h.cache.get("huge", 1000, async () => "x".repeat(1000)); await h.cache.flush();
  assert.equal(h.saved.entries.length, 2); assert.ok(JSON.stringify(h.saved).length < 1024);
  const broken = createReadCache({ namespace: "a", read: async () => { throw Error("bad file"); }, write: async () => { throw Error("full disk"); } });
  assert.equal(await broken.get("x", 1000, async () => 42), 42); await broken.flush();
  const malformed = createReadCache({ namespace: "a", read: async () => ({ version: 1, namespace: "a", entries: [null, {}, "x"] }) });
  assert.equal(await malformed.get("x", 1000, async () => 42), 42);
});
test("only pinned read POSTs can be cached; writes, malformed endpoints and query variants cannot be conflated", async () => {
  const h = harness(); let calls = 0;
  const request = cacheRequests(async (_url, options) => { calls++; assert.equal(options.readTtlMs, undefined); return { n: calls }; }, h.cache);
  const read = { method: "POST", readTtlMs: 15000, body: { operationName: "searchTracks", variables: { query: "a" },
    extensions: { persistedQuery: { version: 1, sha256Hash: QUERY_MANIFEST.operations.searchTracks.sha256Hash } } } };
  await request(PATHFINDER_URL, read); await request(PATHFINDER_URL, read); assert.equal(calls, 1);
  await request(PATHFINDER_URL, { ...read, body: { ...read.body, variables: { query: "b" } } }); assert.equal(calls, 2);
  assert.throws(() => request(PATHFINDER_URL, { ...read, body: { operationName: "addToLibrary" } }), { code: "INVALID_CACHE_POLICY" });
  assert.throws(() => request(PATHFINDER_URL, { method: "PUT", readTtlMs: 1000 }), { code: "INVALID_CACHE_POLICY" });
  assert.throws(() => request("https://example.com/", read), { code: "INVALID_ENDPOINT" });
  await request(PATHFINDER_URL, { method: "POST", body: { operationName: "addToLibrary" } });
  await request(PATHFINDER_URL, { method: "POST", body: { operationName: "addToLibrary" } }); assert.equal(calls, 4);
});
