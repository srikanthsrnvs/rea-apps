import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { SpotifyConnection, SpotifyError } from "./cdp.mjs";
import { execute } from "./client.mjs";
const run = promisify(execFile);

export async function connectSpotify({ port = 9222, restart = false } = {}) {
  if (process.platform !== "darwin")
    throw new SpotifyError(
      "UNSUPPORTED_HOST",
      "Automatic launch is currently supported on macOS. Launch Spotify manually with --remote-debugging-port.",
    );
  try {
    const connection = await SpotifyConnection.connect(port);
    connection.close();
    return { alreadyConnected: true, ...(await execute("status", {}, { port })) };
  } catch (error) {
    if (!["NOT_CONNECTED", "TARGET_UNAVAILABLE"].includes(error.code)) throw error;
  }
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
    await run("/usr/bin/pgrep", ["-x", "Spotify"]);
    running = true;
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  if (running && !restart)
    throw new SpotifyError(
      "RESTART_REQUIRED",
      "Spotify is running without local debugging. Run spotify connect --restart once to enable runtime control.",
    );
  if (running) {
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
  await run("/usr/bin/open", [
    "-a",
    "Spotify",
    "--args",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
  ]);
  const deadline = Date.now() + 20000;
  let last;
  while (Date.now() < deadline) {
    try {
      return { alreadyConnected: false, ...(await execute("status", {}, { port })) };
    } catch (error) {
      last = error;
      if (!["NOT_CONNECTED", "TARGET_UNAVAILABLE", "NOT_READY"].includes(error.code)) throw error;
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
