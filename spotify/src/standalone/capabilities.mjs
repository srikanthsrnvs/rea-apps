// The default model tool catalog exposes only implemented standalone operations.
export const nativeCommands = new Set([
  "login", "login-status", "logout", "status", "search", "play", "pause", "resume",
  "toggle", "next", "previous", "seek", "volume", "shuffle", "repeat", "devices",
  "transfer", "queue", "queue-add", "queue-remove", "queue-move", "queue-clear", "library", "liked", "playlists", "playlist",
  "contains", "save", "unsave", "recent", "queries", "query",
  "playlist-create", "playlist-update", "playlist-add", "playlist-remove", "playlist-move",
  "playlist-follow", "playlist-unfollow", "folder-create", "folder-rename", "folder-move",
]);
export const backendName = () => process.env.SPOTIFY_BACKEND || "native";
