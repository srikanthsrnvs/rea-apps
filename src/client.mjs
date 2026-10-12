import { SpotifyConnection, SpotifyError } from "./cdp.mjs";
import { spotifyRuntime } from "./runtime.mjs";
import { catalog, validateArguments } from "./catalog.mjs";

export async function execute(name, input = {}, options = {}) {
  const command = catalog.find((c) => c.name === name);
  if (!command) throw new SpotifyError("UNKNOWN_COMMAND", `Unknown command: ${name}`);
  const args = validateArguments(command, input);
  const connection = await SpotifyConnection.connect(
    options.port ?? 9222,
    options.timeoutMs ?? 25000,
  );
  try {
    // Serialize requests in the renderer, including separate CLI processes.
    // This prevents concurrent queue/playlist writes from racing each other.
    const response = await connection.evaluate(`(()=>{
      const control=window.__spotifyDesktopCli??={};
      const job=(control.tail??Promise.resolve()).catch(()=>{}).then(()=>(${spotifyRuntime.toString()})(${JSON.stringify(name)},${JSON.stringify(args)}));
      control.tail=job.then(()=>{},()=>{});
      return job;
    })()`);
    if (!response?.ok)
      throw new SpotifyError(
        response?.error?.code ?? "INVALID_RESPONSE",
        response?.error?.message ?? "Spotify returned an invalid response.",
        response?.error?.details,
      );
    return response.result;
  } finally {
    connection.close();
  }
}
