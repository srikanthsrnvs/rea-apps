// The default model tool catalog exposes only implemented standalone operations.
export const nativeCommands = new Set([
  "login", "login-status", "logout", "player", "status", "search", "play", "radio", "radio-play", "pause", "resume",
  "toggle", "next", "previous", "seek", "volume", "shuffle", "repeat", "devices",
  "transfer", "discover", "queue", "queue-add", "queue-remove", "queue-move", "queue-clear", "library", "liked", "playlists", "playlist",
  "contains", "save", "unsave", "recent", "queries", "query",
  "playlist-create", "playlist-update", "playlist-add", "playlist-remove", "playlist-move",
  "playlist-follow", "playlist-unfollow", "folder-create", "folder-rename", "folder-move",
]);
export const nativeOnlyCommands = new Set(["logout", "radio", "radio-play"]);
export const backendName = () => process.env.SPOTIFY_BACKEND || "native";
export const nativeCapabilities = Object.freeze({
  role: "spotify-connect-controller", localAudioPlayback: false, requiresConnectReceiver: true,
  browserRequiredOnHost: false, publicWebApi: false,
  localDiscovery: ["spotify-connect", "sonos", "google-cast"],
});
