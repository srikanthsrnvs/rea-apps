import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SpotifyConnection, SpotifyError } from "./cdp.mjs";
import { execute } from "./client.mjs";
import { backendName } from "./standalone/capabilities.mjs";
const run = promisify(execFile);

export async function connectSpotify({ port = 9222, restart = false } = {}) {
  if (!["native", "desktop"].includes(backendName()))
    throw new SpotifyError("INVALID_ARGUMENT", "SPOTIFY_BACKEND must be native or desktop.");
  if (backendName() === "native") {
    const { connectStandalone } = await import("./standalone/client.mjs");
    return connectStandalone();
  }
  const state = async (alreadyConnected) => {
    const auth = await execute("login-status", {}, { port });
    return {
      alreadyConnected,
      ...auth,
      ...(auth.loggedIn ? await execute("status", {}, { port }) : { nextCommand: "spotify login" }),
    };
  };
  try {
    const connection = await SpotifyConnection.connect(port, 20000, { allowLogin: true });
    connection.close();
    return await state(true);
  } catch (error) {
    if (!["NOT_CONNECTED", "TARGET_UNAVAILABLE"].includes(error.code)) throw error;
  }
  if (!["darwin", "linux"].includes(process.platform))
    throw new SpotifyError("UNSUPPORTED_HOST", "Automatic launch supports macOS and Linux.");
  const occupied = await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
  if (occupied)
    throw new SpotifyError(
      "PORT_IN_USE",
      `Port ${port} is occupied but has no usable Spotify UI. Choose --port N or wait for the app to finish loading.`,
    );
  let running = false;
  try {
    await run("/usr/bin/pgrep", [
      "-u",
      String(process.getuid()),
      "-x",
      process.platform === "darwin" ? "Spotify" : "spotify",
    ]);
    running = true;
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  if (running && !restart)
    throw new SpotifyError(
      "RESTART_REQUIRED",
      process.platform === "linux"
        ? "Spotify is running without local debugging. Stop that Spotify service, then run connect again."
        : "Spotify is running without local debugging. Run spotify connect --restart once to enable runtime control.",
    );
  if (running) {
    if (process.platform === "linux")
      throw new SpotifyError(
        "RESTART_REQUIRED",
        "Stop the existing Spotify service and run connect again to enable debugging.",
      );
    await run("/usr/bin/osascript", ["-e", 'tell application id "com.spotify.client" to quit'], {
      timeout: 10000,
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        await run("/usr/bin/pgrep", ["-x", "Spotify"]);
      } catch (error) {
        if (error.code === 1) {
          running = false;
          break;
        }
        throw error;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (running)
      throw new SpotifyError(
        "QUIT_FAILED",
        "Spotify did not quit. Close it and run connect again.",
      );
  }
  if (process.platform === "darwin")
    await run("/usr/bin/open", [
      "-a",
      "Spotify",
      "--args",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
    ]);
  else {
    const binary = process.env.SPOTIFY_BINARY ?? "/usr/bin/spotify";
    const args = [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"];
    const command = process.env.DISPLAY ? binary : "dbus-run-session";
    const launchArgs = process.env.DISPLAY
      ? args
      : ["--", "xvfb-run", "-a", "-s", "-screen 0 1280x800x24", binary, ...args];
    const env = { ...process.env };
    if (!process.env.DISPLAY) {
      env.XDG_RUNTIME_DIR ??= join(homedir(), ".cache", "spotify-desktop-cli", "runtime");
      await mkdir(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    }
    await new Promise((resolve, reject) => {
      const child = spawn(command, launchArgs, { detached: true, stdio: "ignore", env });
      child.once("error", () =>
        reject(
          new SpotifyError(
            "LAUNCH_FAILED",
            "Install Spotify, xvfb, xauth and dbus-run-session, or set SPOTIFY_BINARY to its executable.",
          ),
        ),
      );
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
  const deadline = Date.now() + 60000;
  let last;
  while (Date.now() < deadline) {
    try {
      return await state(false);
    } catch (error) {
      last = error;
      if (
        !["NOT_CONNECTED", "TARGET_UNAVAILABLE", "NOT_READY", "LOGIN_UNAVAILABLE"].includes(
          error.code,
        )
      )
        throw error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw (
    last ??
    new SpotifyError(
      "NOT_READY",
      "Spotify did not finish loading. Complete login, then run connect again.",
    )
  );
}
