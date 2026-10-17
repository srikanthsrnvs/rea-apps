import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readState, saveState } from "../standalone/state.mjs";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export function viewerResult(state) {
  return { url: state.url, expiresAt: state.expiresAt, localPort: state.port, public: state.public };
}
async function healthy(state) {
  if (!state?.port || !state.secret) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { method: "POST",
      headers: { Authorization: `Bearer ${state.secret}` }, redirect: "error", signal: AbortSignal.timeout(1500) });
    const value = await response.json(); return response.ok && value.ready && value.expiresAt === state.expiresAt;
  } catch { return false; }
}
async function tunnelBinary(explicit) {
  const candidates = explicit ? [explicit] : [process.env.SPOTIFY_CLOUDFLARED,
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(p => path.join(p, "cloudflared")),
    path.join(process.env.HOME ?? "", ".local/bin/cloudflared"), "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate, 1); if ((await stat(candidate)).isFile()) return realpath(candidate); } catch { /* Next known binary. */ }
  }
  fail("TUNNEL_UNAVAILABLE", "Public player links need cloudflared. Install it or supply --cloudflared-path. Local player mode needs no tunnel.");
}
// The caller holds the command lock; the worker does not call Spotify at startup.
export async function managePlayer(args = {}, ownerId) {
  const existing = await readState("player-host");
  const ready = existing?.phase === "ready" && existing.expiresAt > Date.now() && await healthy(existing);
  if (args.stop) {
    if (ready) {
      try { await fetch(`http://127.0.0.1:${existing.port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${existing.secret}` }, redirect: "error", signal: AbortSignal.timeout(1500) }); }
      catch { fail("PLAYER_STOP_UNCONFIRMED", "The player viewer did not confirm shutdown. Playback was not changed."); }
    }
    await saveState("player-host", { phase: "stopped" }); return { stopped: true };
  }
  if (ready && existing.ownerId !== ownerId) await managePlayer({ stop: true }, ownerId);
  else if (ready) {
    if (args.public !== undefined && Boolean(args.public) !== Boolean(existing.public)) fail("PLAYER_ALREADY_RUNNING", "Stop the current viewer with spotify player --stop before changing its visibility.");
    return viewerResult(existing);
  }
  if (typeof ownerId !== "string" || !/^[A-Za-z0-9_-]{1,35}$/.test(ownerId)) fail("INVALID_SESSION", "The saved account has no native controller identity. Complete Spotify pairing again.");
  const tunnelPath = args.public ? await tunnelBinary(args["cloudflared-path"]) : null;
  const state = { phase: "starting", id: randomBytes(16).toString("hex"), secret: randomBytes(32).toString("base64url"),
    ownerId,
    public: Boolean(args.public), tunnelPath, port: args["listen-port"] ?? 0, expiresAt: Date.now() + (args["ttl-minutes"] ?? 30) * 60000 };
  await saveState("player-host", state);
  const child = fork(fileURLToPath(new URL("./worker.mjs", import.meta.url)), [state.id], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, SPOTIFY_BACKEND: "native" },
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("timeout")), 35000);
      const fail = () => { clearTimeout(timer); reject(Error("worker unavailable")); };
      child.once("error", fail); child.once("exit", fail);
      child.on("message", message => { if (message?.phase === "ready") { clearTimeout(timer); resolve(); } else if (message?.phase === "failed") fail(); });
    });
    const current = await readState("player-host");
    if (current?.id !== state.id || current.phase !== "ready") throw Error("not ready");
    child.disconnect(); child.unref(); return viewerResult(current);
  } catch {
    child.kill(); if (child.connected) child.disconnect(); child.unref();
    await saveState("player-host", { phase: "failed" });
    fail("PLAYER_START_FAILED", "Could not start the player viewer or its optional tunnel. No playback command was sent.");
  }
}
