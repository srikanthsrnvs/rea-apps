import { execute } from "../src/client.mjs";

// Read native session state and, when signed in, the operational runtime.
// Logged-out sessions are ready too: first pairing remains an explicit command.
const deadline = Date.now() + 180000;
let last;
process.stderr.write("Waiting for Spotify (ARM emulation can take a few minutes)…\n");
while (Date.now() < deadline) {
  try {
    const result = await execute("login-status", {}, { timeoutMs: 5000 });
    if (result.loggedIn) await execute("status", {}, { timeoutMs: 5000 });
    process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
    process.exit(0);
  } catch (error) {
    last = error;
    if (!["NOT_CONNECTED", "TARGET_UNAVAILABLE", "NOT_READY", "LOGIN_UNAVAILABLE", "TIMEOUT", "DISCONNECTED", "CDP_ERROR"].includes(error.code)) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
process.stderr.write("Spotify did not become ready. Run bin/spotify-headless service logs.\n");
process.stdout.write(JSON.stringify({ ok: false, error: { code: last?.code ?? "NOT_READY", message: last?.message ?? "Startup timed out." } }) + "\n");
process.exitCode = 1;
