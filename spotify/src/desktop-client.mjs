import { SpotifyConnection, SpotifyError } from "./cdp.mjs";
import { spotifyRuntime } from "./runtime.mjs";
import { spotifyAuthRuntime } from "./auth-runtime.mjs";

// Historical desktop backend; imported only when explicitly selected.
export async function executeDesktop(name, args, options = {}) {
  const auth = ["login", "login-status"].includes(name);
  const connection = await SpotifyConnection.connect(
    options.port ?? 9222,
    options.timeoutMs ?? 25000,
    { allowLogin: auth },
  );
  try {
    // Serialize requests in the renderer, including separate CLI processes.
    // This prevents concurrent queue/playlist writes from racing each other.
    const response = await connection.evaluate(
      auth
        ? `(${spotifyAuthRuntime.toString()})(${JSON.stringify(name)})`
        : `(()=>{
      const control=window.__spotifyDesktopCli??={};
      const job=(control.tail??Promise.resolve()).catch(()=>{}).then(()=>(${spotifyRuntime.toString()})(${JSON.stringify(name)},${JSON.stringify(args)}));
      control.tail=job.then(()=>{},()=>{});
      return job;
    })()`,
    );
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
