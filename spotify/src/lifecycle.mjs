import { SpotifyError } from "./errors.mjs";
import { backendName } from "./standalone/capabilities.mjs";

export async function connectSpotify(options = {}) {
  const backend = backendName();
  if (backend === "native") {
    const { connectStandalone } = await import("./standalone/client.mjs");
    return connectStandalone();
  }
  if (backend !== "desktop") throw new SpotifyError("INVALID_ARGUMENT", "SPOTIFY_BACKEND must be native or desktop.");
  const { connectDesktop } = await import("./desktop-lifecycle.mjs");
  return connectDesktop(options);
}
