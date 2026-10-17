import { withStateLock, saveState, readState } from "./state.mjs";
import { login, loginStatus, logout, getSession } from "./auth.mjs";
import { createRequest } from "./http.mjs";
import { executeConnect, resolveConnectEndpoints, isConnectRead } from "./connect.mjs";
import { spotifyUris } from "./uri.mjs";
import { catalog as commands } from "../catalog.mjs";
import { createReadCache, cacheRequests, invalidateReadCache } from "./read-cache.mjs";

const controls = new Set(["status", "devices", "play", "pause", "resume", "toggle", "next", "previous", "seek", "volume", "shuffle", "repeat", "transfer", "queue", "queue-add", "queue-remove", "queue-move", "queue-clear"]);
export async function executeStandalone(name, args = {}, options = {}) {
  if (name === "login") return login();
  if (name === "login-status") return loginStatus();
  if (name === "logout") {
    try {
      const viewer = await readState("player-host");
      if (viewer?.phase === "ready") {
        const { managePlayer } = await import("../player/session.mjs");
        await withStateLock(() => managePlayer({ stop: true }));
      }
    } catch { /* Removing the account session still revokes viewer RPC access. */ }
    return logout();
  }
  if (name === "player") {
    const { managePlayer } = await import("../player/session.mjs");
    const viewer = await withStateLock(async () => {
      const session = args.stop ? null : await getSession();
      return managePlayer(args, session?.controllerId);
    });
    return args.stop ? viewer : { ...await executeStandalone("status"), viewer };
  }
  return withStateLock(async () => {
    if (name === "discover") {
      const { discoverSpeakers } = await import("./discovery.mjs");
      return discoverSpeakers({ refresh: args.refresh, timeoutMs: args["timeout-ms"] });
    }
    let session = await getSession();
    if (options.expectedControllerId !== undefined && options.expectedControllerId !== session.controllerId)
      throw Object.assign(new Error("The player link belongs to a different account session. Open a fresh player link."), { code: "PLAYER_SESSION_CHANGED" });
    const readOnly = commands.find(c => c.name === name)?.effect === "read" || isConnectRead(name, args);
    if (!readOnly) await invalidateReadCache();
    const cache = createReadCache({ namespace: `${session.controllerId}:${session.username ?? ""}` });
    const freshRequest = createRequest(async () => (session = await getSession()).accessToken);
    const request = readOnly ? cacheRequests(freshRequest, cache, { refresh: args.refresh }) : freshRequest;
    const run = async () => {
      let endpoints, catalog, playlists;
      const getEndpoints = async () => endpoints ??= await resolveConnectEndpoints(request);
      const getCatalog = async () => {
        if (!catalog) {
          const { NativeCatalogBackend } = await import("./catalog-backend.mjs");
          catalog = new NativeCatalogBackend({ request, spclientBaseUrl: (await getEndpoints()).webgate, username: session.username });
        }
        return catalog;
      };
      const getPlaylists = async () => {
        if (!playlists) {
          const { NativePlaylistBackend } = await import("./playlist-backend.mjs");
          playlists = new NativePlaylistBackend({ request, catalog: await getCatalog(), spclientBaseUrl: (await getEndpoints()).webgate });
        }
        return playlists;
      };
      if (!session.username) {
        const profile = await (await getCatalog()).profile();
        session = { ...session, username: profile.username };
        await saveState("session", session);
      }
      if (name === "play" && args.query) {
        if (args.uri) throw Object.assign(new Error("Choose a URI or a search query, not both."), { code: "INVALID_ARGUMENT" });
        const found = await (await getCatalog()).search({ query: args.query, type: "track", offset: 0, limit: 5 });
        const uri = found.tracks?.items?.find(item => item.uri && item.isPlayable !== false)?.uri;
        if (!uri) throw Object.assign(new Error("No playable search result found."), { code: "NOT_FOUND" });
        args = { ...args, query: undefined, uri };
      }
      if (controls.has(name)) {
        const result = await executeConnect(name, args, request, {
          getAccessToken: async () => (session = await getSession()).accessToken,
          controllerId: session.controllerId, username: session.username,
          resolveEndpoints: getEndpoints,
        });
        if (name === "devices" && args.network !== false) {
          const { discoverSpeakers, mergeDevices } = await import("./discovery.mjs");
          const network = await discoverSpeakers({ refresh: args.refresh });
          return mergeDevices(result, network.devices);
        }
        return result;
      }
      if (name === "playlists" || name.startsWith("playlist-") || name.startsWith("folder-"))
        return (await getPlaylists()).run(name, args);
      if (["contains", "save", "unsave"].includes(name)) {
        const uris = spotifyUris(args.uris), playlistUris = uris.filter(uri => uri.startsWith("spotify:playlist:")), others = uris.filter(uri => !uri.startsWith("spotify:playlist:"));
        const results = [];
        if (playlistUris.length) {
          const backend = await getPlaylists();
          if (name === "contains") results.push(...await backend.contains(playlistUris));
          else for (const uri of playlistUris) results.push(await backend.run(name === "save" ? "playlist-follow" : "playlist-unfollow", { uri }));
        }
        if (others.length) results.push(...await (await getCatalog()).run(name, { uris: others }));
        const byUri = new Map(results.map(item => [item.uri, item]));
        return uris.map(uri => byUri.get(uri));
      }
      return (await getCatalog()).run(name, args);
    };
    const result = await run();
    await cache.flush();
    if (["playing", "paused", "stopped"].includes(result?.state)) {
      try {
        const viewer = await readState("player-host");
        if (viewer?.phase === "ready" && viewer.ownerId === session.controllerId && viewer.expiresAt > Date.now()) {
          process.kill(viewer.pid, 0); result.viewer = { url: viewer.url, expiresAt: viewer.expiresAt };
        }
      } catch { /* Optional viewer failures never change a playback result. */ }
    }
    return result;
  });
}

export async function connectStandalone() {
  const status = await loginStatus();
  if (!status.loggedIn) return { ...status, nextCommand: "spotify login", backend: "standalone" };
  return { ...status, ...await executeStandalone("status"), backend: "standalone" };
}
