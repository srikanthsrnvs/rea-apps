import { SpotifyError } from "./errors.mjs";
import { catalog, validateArguments } from "./catalog.mjs";
import { backendName, nativeCommands } from "./standalone/capabilities.mjs";

export async function execute(name, input = {}, options = {}) {
  const command = catalog.find((c) => c.name === name);
  if (!command) throw new SpotifyError("UNKNOWN_COMMAND", `Unknown command: ${name}`);
  const args = validateArguments(command, input);
  const backend = options.backend || backendName();
  if (backend === "native") {
    if (!nativeCommands.has(name)) throw new SpotifyError("UNSUPPORTED", `${name} is not available in the standalone backend. No desktop app will be launched.`);
    const { executeStandalone } = await import("./standalone/client.mjs");
    return executeStandalone(name, args, options);
  }
  if (backend !== "desktop") throw new SpotifyError("INVALID_ARGUMENT", "SPOTIFY_BACKEND must be native or desktop.");
  const { executeDesktop } = await import("./desktop-client.mjs");
  return executeDesktop(name, args, options);
}
