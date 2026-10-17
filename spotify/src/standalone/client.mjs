import { withStateLock, saveState } from "./state.mjs";
import { login, loginStatus, logout, getSession } from "./auth.mjs";
import { createRequest } from "./http.mjs";
import { executeConnect, resolveConnectEndpoints } from "./connect.mjs";
import { spotifyUris } from "./uri.mjs";

const controls = new Set(["status", "devices", "play", "pause", "resume", "toggle", "next", "previous", "seek", "volume", "shuffle", "repeat", "transfer", "queue", "queue-add", "queue-remove", "queue-move", "queue-clear"]);
export async function executeStandalone(name, args = {}) {
  if (name === "login") return login();
  if (name === "login-status") return loginStatus();
  if (name === "logout") return logout();
  return withStateLock(async () => {
    let session = await getSession();
    const request = createRequest(async () => (session = await getSession()).accessToken);
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
      return executeConnect(name, args, request, {
        getAccessToken: async () => (session = await getSession()).accessToken,
        controllerId: session.controllerId, username: session.username,
        resolveEndpoints: getEndpoints,
      });
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
  });
}

export async function connectStandalone() {
  const status = await loginStatus();
  if (!status.loggedIn) return { ...status, nextCommand: "spotify login", backend: "standalone" };
  return { ...status, ...await executeStandalone("status"), backend: "standalone" };
}
