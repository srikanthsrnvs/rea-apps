import { spawn } from "node:child_process";
import { startPlayerServer } from "./server.mjs";
import { readState, saveState } from "../standalone/state.mjs";

async function tunnel(binary, port) {
  const child = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("timeout")), 25000); let logs = "";
      const fail = () => { clearTimeout(timer); reject(Error("tunnel failed")); };
      child.once("error", fail); child.once("exit", fail);
      child.stderr.on("data", chunk => {
        logs = (logs + chunk.toString()).slice(-10000);
        const found = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
        if (found) { clearTimeout(timer); resolve(found[0]); }
      });
    });
    return { child, url };
  } catch (e) { child.kill(); throw e; }
}

async function main(id) {
  const config = await readState("player-host");
  if (config?.id !== id || config.phase !== "starting" || config.expiresAt <= Date.now()) return;
  let viewer, relay, stopping;
  const stop = () => stopping ??= (async () => {
    relay?.child.kill(); await viewer?.close();
    const current = await readState("player-host");
    if (current?.id === id) await saveState("player-host", { phase: "stopped" });
    if (process.connected) process.disconnect();
  })();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop().catch(() => {}); });
  try {
    viewer = await startPlayerServer({ secret: config.secret, expiresAt: config.expiresAt, port: config.port, ownerId: config.ownerId, onStop: stop,
      isCurrent: async () => {
        const [host, account] = await Promise.all([readState("player-host"), readState("session")]);
        return host?.id === id && host.phase === "ready" && !!config.ownerId && account?.controllerId === config.ownerId;
      },
    });
    if (config.public) relay = await tunnel(config.tunnelPath, viewer.port);
    const current = await readState("player-host");
    if (current?.id !== id || stopping) { await stop(); return; }
    const origin = relay?.url ?? `http://127.0.0.1:${viewer.port}`;
    await saveState("player-host", { ...config, phase: "ready", pid: process.pid, port: viewer.port, url: `${origin}/#key=${config.secret}` });
    relay?.child.once("exit", () => { stop().catch(() => {}); });
    process.send?.({ phase: "ready" });
  } catch {
    process.send?.({ phase: "failed" }); await stop();
  }
}
main(process.argv[2]).catch(() => { process.exitCode = 1; });
