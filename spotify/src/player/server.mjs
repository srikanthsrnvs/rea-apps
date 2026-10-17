import http from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual, createHash } from "node:crypto";
import { execute } from "../client.mjs";
import { catalog, validateArguments } from "../catalog.mjs";
import { playbackResult, playerResource } from "../player.mjs";

const controls = new Map(["status", "pause", "resume", "previous", "next", "seek", "volume"].map(name => [`spotify_${name}`, name]));
export async function startPlayerServer({ secret, expiresAt, port = 0, ownerId, run = execute, isCurrent = async () => true, onStop = () => {} }) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw Error("Invalid player session");
  const files = new Map(await Promise.all([["/", "viewer.html", "text/html; charset=utf-8"],
    ["/viewer.mjs", "viewer.mjs", "text/javascript"], ["/host.mjs", "host.mjs", "text/javascript"]].map(async ([url, file, type]) =>
      [url, { type, body: await readFile(new URL(file, import.meta.url), "utf8") }])));
  const resource = await playerResource();
  const scriptHashes = [...resource.text.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`).join(" ");
  let closing = false, tail = Promise.resolve(), windowStart = Date.now(), requests = 0;
  const reply = (res, status, value, type = "application/json") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; script-src 'self' ${scriptHashes}; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' about:; frame-ancestors *; base-uri 'none'; form-action 'none'` });
    res.end(type === "application/json" ? JSON.stringify(value) : value);
  };
  const authorized = req => {
    const expected = Buffer.from(`Bearer ${secret}`), given = Buffer.from(req.headers.authorization ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (closing || Date.now() >= expiresAt) return reply(res, 410, { error: "expired" });
      if (req.method === "GET" && files.has(req.url)) { const f = files.get(req.url); return reply(res, 200, f.body, f.type); }
      if (req.method === "GET" && req.url === "/resource") return reply(res, 200, resource);
      if (req.method !== "POST" || !["/rpc", "/stop", "/health"].includes(req.url)) return reply(res, 404, { error: "not_found" });
      if (!authorized(req)) return reply(res, 401, { error: "unauthorized" });
      if (req.url === "/health") return reply(res, 200, { ready: true, expiresAt });
      if (req.url === "/stop") { reply(res, 200, { stopped: true }); setImmediate(() => { close().then(onStop).catch(() => {}); }); return; }
      if (!await isCurrent()) return reply(res, 401, { error: "session_changed" });
      if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); requests = 0; }
      if (++requests > 120) return reply(res, 429, { error: "too_many_requests" });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(res, 400, { error: "invalid_request" });
      let size = 0, body = "";
      for await (const chunk of req) { size += chunk.length; if (size > 4096) return reply(res, 413, { error: "request_too_large" }); body += chunk; }
      let input;
      try { input = JSON.parse(body); } catch { return reply(res, 400, { error: "invalid_request" }); }
      const name = controls.get(input?.name);
      if (!name || Object.keys(input).some(k => !["name", "arguments"].includes(k))) return reply(res, 400, { error: "unsupported_action" });
      let args;
      try { args = validateArguments(catalog.find(c => c.name === name), input.arguments ?? {}); }
      catch { return reply(res, 400, { error: "invalid_arguments" }); }
      if (name === "seek" && !args["track-uri"]) return reply(res, 400, { error: "expected_track_required" });
      if (name === "volume" && (args.percent === undefined || !args["device-id"])) return reply(res, 400, { error: "expected_device_required" });
      const job = tail.then(async () => {
        if (closing) return { ok: false, error: { code: "PLAYER_CLOSED", message: "Player closed." } };
        try { return playbackResult(name, await run(name, args, { backend: "native", ...(ownerId ? { expectedControllerId: ownerId } : {}) })); }
        catch (error) { return { ok: false, error: { code: error.code ?? "PLAYER_ACTION_FAILED", message: error.message ?? "Spotify did not confirm this action." } }; }
      });
      tail = job.catch(() => {});
      reply(res, 200, await job);
    } catch { if (!res.headersSent) reply(res, 400, { error: "invalid_request" }); else res.end(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  async function close() {
    if (closing) return;
    closing = true; clearTimeout(expiry); await tail;
    const done = new Promise(resolve => server.close(resolve)); server.closeIdleConnections(); await done;
  }
  const expiry = setTimeout(() => { close().then(onStop).catch(() => {}); }, Math.min(2147483647, expiresAt - Date.now()));
  return { port: server.address().port, close, server };
}
