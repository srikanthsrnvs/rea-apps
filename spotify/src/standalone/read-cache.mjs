import { createHash } from "node:crypto";
import { readState, saveState, removeState } from "./state.mjs";
import { QUERY_MANIFEST, PATHFINDER_URL } from "./catalog-backend.mjs";
import { spotifyUrl } from "./http.mjs";

// Bounded, account-scoped read snapshots shared by short-lived CLI processes.
// Callers hold the command lock. No tokens, failed responses or writes go here.
export function createReadCache({ namespace, storeName = "read-cache", read = readState, write = saveState,
  now = Date.now, maxEntries = 64, maxBytes = 2 * 1024 * 1024, maxEntryBytes = 512 * 1024 } = {}) {
  let entries, loading, dirty = false;
  const pending = new Map();
  async function load() {
    if (entries) return;
    loading ??= (async () => {
      let saved;
      try { saved = await read(storeName); } catch { /* Cache failure never prevents a fresh read. */ }
      entries = new Map();
      if (saved?.version !== 1 || saved.namespace !== namespace || !Array.isArray(saved.entries)) return;
      for (const e of saved.entries.slice(-maxEntries)) {
        if (!e || typeof e !== "object" || !Object.hasOwn(e, "value") || !/^[a-f0-9]{64}$/.test(e.key) || !Number.isFinite(e.savedAt) || e.savedAt > now() ||
          !Number.isFinite(e.expiresAt) || e.expiresAt <= now() || e.expiresAt - e.savedAt > 600000) continue;
        const bytes = Buffer.byteLength(JSON.stringify(e));
        if (bytes <= maxEntryBytes) entries.set(e.key, { ...e, bytes });
      }
      trim();
    })();
    await loading;
  }
  function trim() {
    for (const [key, e] of entries) if (e.expiresAt <= now() || e.savedAt > now()) entries.delete(key);
    let bytes = [...entries.values()].reduce((n, e) => n + e.bytes, 0);
    while (entries.size > maxEntries || bytes > maxBytes) {
      const key = entries.keys().next().value;
      bytes -= entries.get(key).bytes; entries.delete(key);
    }
  }
  return {
    async get(key, ttlMs, fetchValue, { refresh = false } = {}) {
      if (!(ttlMs > 0 && ttlMs <= 600000)) return fetchValue();
      await load();
      const hash = createHash("sha256").update(key).digest("hex"), hit = entries.get(hash);
      if (!refresh && hit && hit.expiresAt > now() && hit.savedAt <= now()) {
        entries.delete(hash); entries.set(hash, hit);
        return structuredClone(hit.value);
      }
      let job = pending.get(hash);
      if (!job) {
        job = (async () => {
          const value = await fetchValue();
          if (value !== undefined) {
            const savedAt = now(), entry = { key: hash, savedAt, expiresAt: savedAt + ttlMs, value: structuredClone(value) };
            entry.bytes = Buffer.byteLength(JSON.stringify(entry));
            if (entry.bytes <= maxEntryBytes) {
              entries.delete(hash); entries.set(hash, entry); dirty = true; trim();
            }
          }
          return value;
        })();
        pending.set(hash, job);
        job.finally(() => { if (pending.get(hash) === job) pending.delete(hash); }).catch(() => {});
      }
      return structuredClone(await job);
    },
    async flush() {
      if (!dirty) return;
      trim();
      try { await write(storeName, { version: 1, namespace, entries: [...entries.values()] }); }
      catch { /* Disk caching is optional. */ }
      dirty = false;
    },
  };
}

export async function invalidateReadCache() { await removeState("read-cache"); }

export function cacheRequests(request, cache, { refresh = false } = {}) {
  return (input, options = {}) => {
    const { readTtlMs, ...wire } = options;
    if (!readTtlMs) return request(input, wire);
    spotifyUrl(input, wire.query);
    // Only explicitly classified reads can opt in; POST is used by Pathfinder.
    if (!["GET", "POST"].includes(wire.method ?? "GET"))
      throw Object.assign(new Error("Only read requests may use the read cache."), { code: "INVALID_CACHE_POLICY" });
    if (wire.method === "POST") {
      const definition = QUERY_MANIFEST.operations[wire.body?.operationName];
      if (String(input) !== PATHFINDER_URL || definition?.operation !== "query" ||
        definition.sha256Hash !== wire.body?.extensions?.persistedQuery?.sha256Hash)
        throw Object.assign(new Error("Only pinned read queries may use the read cache."), { code: "INVALID_CACHE_POLICY" });
    }
    const query = { ...wire.query };
    // Fresh rootlist requests retain the client's cache buster on the wire;
    // it is not a semantic difference when reusing a short local read snapshot.
    if ((wire.method ?? "GET") === "GET" && /\/playlist\/v2\/user\/[^/]+\/rootlist$/.test(new URL(input).pathname)) delete query.bustCache;
    const key = JSON.stringify([String(input), wire.method ?? "GET", query, wire.body, wire.headers]);
    return cache.get(key, readTtlMs, () => request(input, wire), { refresh });
  };
}
