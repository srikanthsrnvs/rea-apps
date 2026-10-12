const text = (description, extra = {}) => ({ type: "string", description, ...extra });
const number = (description, minimum, maximum, extra = {}) => ({
  type: "number",
  description,
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
  ...extra,
});
const integer = (description, minimum, maximum, extra = {}) => ({
  ...number(description, minimum, maximum, extra),
  type: "integer",
});
const choice = (description, values, extra = {}) => text(description, { enum: values, ...extra });
const json = (type, description) => ({ type, description });
const pagination = {
  offset: integer("Zero-based starting offset", 0, undefined, { default: 0 }),
  limit: integer("Maximum number of results", 1, 1000, { default: 20 }),
};
const uri = text("Spotify URI, open.spotify.com URL, or liked");
const many = text("One or more Spotify URIs or URLs, separated by commas");
const uid = text("Exact row UID returned by queue or playlist");
const entry = (
  name,
  description,
  properties = {},
  required = [],
  positional = [],
  effect = "read",
) => ({
  name,
  description,
  positional,
  effect,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});
export const catalog = [
  entry(
    "status",
    "Current track, playback position, options, restrictions, volume and active device",
  ),
  entry(
    "search",
    "Search Spotify using the logged-in desktop session",
    {
      query: text("Search terms"),
      type: choice(
        "Result category",
        ["all", "track", "album", "artist", "playlist", "episode", "show", "user", "audiobook"],
        { default: "all" },
      ),
      ...pagination,
    },
    ["query"],
    ["query"],
  ),
  entry(
    "play",
    "Play a URI or the first track matching --query; with no arguments, resume",
    {
      uri,
      query: text("Search terms; selects the first track result"),
      context: uri,
      index: integer("Zero-based track index within the context", 0),
    },
    [],
    ["uri"],
    "write",
  ),
  ...["pause", "resume", "toggle", "next", "previous"].map((name) =>
    entry(
      name,
      {
        pause: "Pause playback",
        resume: "Resume playback",
        toggle: "Toggle play/pause",
        next: "Skip to next track",
        previous: "Previous track or restart current track",
      }[name],
      {},
      [],
      [],
      "write",
    ),
  ),
  entry(
    "seek",
    "Seek within the current track",
    { seconds: number("Absolute position in seconds", 0) },
    ["seconds"],
    ["seconds"],
    "write",
  ),
  entry(
    "volume",
    "Get volume, or set a percentage from 0 to 100",
    { percent: number("Volume percentage", 0, 100) },
    [],
    ["percent"],
    "write",
  ),
  entry(
    "shuffle",
    "Get shuffle state, or set on/off",
    { mode: choice("Shuffle setting", ["on", "off"]) },
    [],
    ["mode"],
    "write",
  ),
  entry(
    "repeat",
    "Get repeat state, or set off/context/track",
    { mode: choice("Repeat setting", ["off", "context", "track"]) },
    [],
    ["mode"],
    "write",
  ),
  entry("queue", "Read explicit queued tracks and upcoming context tracks", {
    limit: integer("Maximum number of next-up context tracks", 1, 1000, { default: 20 }),
  }),
  entry(
    "queue-add",
    "Append tracks or episodes to the queue",
    { uris: many },
    ["uris"],
    ["uris"],
    "write",
  ),
  entry(
    "queue-remove",
    "Remove one exact queue occurrence by UID",
    { uid },
    ["uid"],
    ["uid"],
    "write",
  ),
  entry(
    "queue-move",
    "Move one exact queued item to a zero-based queue index",
    { uid, index: integer("Target index within the explicit queue", 0) },
    ["uid", "index"],
    ["uid", "index"],
    "write",
  ),
  entry("queue-clear", "Clear the explicit queue; keep the playback context", {}, [], [], "write"),
  entry("library", "List or search the saved library", {
    ...pagination,
    query: text("Filter library names"),
    filter: choice("Library item category", ["playlist", "show", "album", "artist"]),
  }),
  entry("liked", "List liked songs", { ...pagination }),
  ...["save", "unsave", "contains"].map((name) =>
    entry(
      name,
      {
        save: "Save tracks, albums, artists, shows, or playlists",
        unsave: "Remove items from the library",
        contains: "Check whether each item is saved",
      }[name],
      { uris: many },
      ["uris"],
      ["uris"],
      name === "contains" ? "read" : "write",
    ),
  ),
  entry("playlists", "List all playlist and folder entries, including folder hierarchy"),
  entry(
    "playlist",
    "Read a playlist and a page of its exact row UIDs",
    { uri, ...pagination },
    ["uri"],
    ["uri"],
  ),
  entry(
    "playlist-create",
    "Create a private, unpublished playlist",
    { name: text("Playlist name"), description: text("Optional description") },
    ["name"],
    ["name"],
    "write",
  ),
  entry(
    "playlist-update",
    "Update a playlist name or description",
    {
      uri,
      name: text("New playlist name"),
      description: text("New description; empty string clears it"),
    },
    ["uri"],
    ["uri"],
    "write",
  ),
  entry(
    "playlist-add",
    "Append tracks or episodes to a playlist",
    { uri, uris: many },
    ["uri", "uris"],
    ["uri", "uris"],
    "write",
  ),
  entry(
    "playlist-remove",
    "Remove one exact playlist row by UID",
    { uri, uid },
    ["uri", "uid"],
    ["uri", "uid"],
    "write",
  ),
  entry(
    "playlist-move",
    "Move an exact playlist row to a zero-based index",
    { uri, uid, index: integer("Target index in the playlist", 0) },
    ["uri", "uid", "index"],
    ["uri", "uid", "index"],
    "write",
  ),
  ...["playlist-follow", "playlist-unfollow"].map((name) =>
    entry(
      name,
      name === "playlist-follow"
        ? "Add a playlist to your library"
        : "Unfollow a playlist; does not permanently delete it",
      { uri },
      ["uri"],
      ["uri"],
      "write",
    ),
  ),
  entry(
    "folder-create",
    "Create a playlist folder",
    { name: text("Folder name") },
    ["name"],
    ["name"],
    "write",
  ),
  entry(
    "folder-rename",
    "Rename a playlist folder",
    { uri, name: text("New folder name") },
    ["uri", "name"],
    ["uri", "name"],
    "write",
  ),
  entry(
    "folder-move",
    "Move a playlist or folder into another folder, or back to root",
    { uri, folder: text("Destination folder URI, or root") },
    ["uri", "folder"],
    ["uri", "folder"],
    "write",
  ),
  entry("devices", "List Spotify Connect devices and their exact IDs"),
  entry(
    "transfer",
    "Transfer playback to a device by exact ID or unique name",
    { device: text("Device ID or exact name from devices") },
    ["device"],
    ["device"],
    "write",
  ),
  entry("history", "Read listening history", { ...pagination }),
  entry("recent", "Read recently played contexts"),
  entry("settings", "List available app settings and whether each is writable"),
  entry(
    "setting",
    "Read or change a setting; values use JSON syntax",
    { key: text("Setting key returned by settings"), value: {} },
    ["key"],
    ["key", "value"],
    "write",
  ),
  entry(
    "open",
    "Navigate the desktop UI to a Spotify resource",
    { uri },
    ["uri"],
    ["uri"],
    "write",
  ),
  entry("queries", "Discover available read queries; optionally load an app route", {
    route: text("Route name, such as album, search, track-v2 or show"),
  }),
  entry(
    "query",
    "Run a shipped read query with JSON variables",
    {
      name: text("Query name returned by queries"),
      variables: { ...json("object", "JSON variables"), default: {} },
      route: text("Optional app route to load first"),
    },
    ["name"],
    ["name", "variables"],
  ),
  entry(
    "apis",
    "Discover public app methods; inspect a method implementation with --api and --method",
    {
      api: text("Optional service name"),
      method: text("Optional method implementation to inspect"),
    },
    [],
    ["api", "method"],
  ),
  entry(
    "api-call",
    "Advanced: call a discovered app service method using JSON positional arguments",
    {
      api: text("Service name returned by apis"),
      method: text("Public method returned by apis"),
      arguments: { ...json("array", "JSON array of arguments"), default: [] },
    },
    ["api", "method"],
    ["api", "method", "arguments"],
    "write",
  ),
];

export function validateArguments(command, input) {
  if (!input || Array.isArray(input) || typeof input !== "object")
    throw invalid("Arguments must be an object.");
  const result = {};
  for (const key of Object.keys(input))
    if (!(key in command.inputSchema.properties)) throw invalid(`Unknown argument: ${key}`);
  for (const [key, schema] of Object.entries(command.inputSchema.properties)) {
    let value = input[key];
    if (value === undefined && "default" in schema) value = structuredClone(schema.default);
    if (value === undefined) {
      if (command.inputSchema.required.includes(key)) throw invalid(`Missing argument: ${key}`);
      continue;
    }
    const valid =
      schema.type === "array"
        ? Array.isArray(value)
        : schema.type === "object"
          ? value !== null && typeof value === "object" && !Array.isArray(value)
          : schema.type === "integer"
            ? Number.isInteger(value)
            : schema.type
              ? typeof value === schema.type
              : true;
    if (!valid) throw invalid(`${key} must be ${schema.type}.`);
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (schema.minimum !== undefined && value < schema.minimum) ||
        (schema.maximum !== undefined && value > schema.maximum))
    )
      throw invalid(`${key} is outside its allowed range.`);
    if (schema.enum && !schema.enum.includes(value))
      throw invalid(`${key} must be one of: ${schema.enum.join(", ")}.`);
    if (typeof value === "string" && !value.trim() && key !== "description")
      throw invalid(`${key} must not be empty.`);
    result[key] = value;
  }
  return result;
}

export const invalid = (message) => Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });

export function parseCommand(argv) {
  const tokens = [...argv];
  let name = tokens.shift() ?? "help";
  if (name === "--help" || name === "-h") name = "help";
  if (
    ["queue", "playlist", "folder"].includes(name) &&
    tokens[0] &&
    !tokens[0].startsWith("-") &&
    catalog.some((c) => c.name === `${name}-${tokens[0]}`)
  )
    name += `-${tokens.shift()}`;
  const command = catalog.find((c) => c.name === name);
  if (!command) return { name, tokens };
  const input = {},
    positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--json" || token === "--pretty") continue;
    if (token === "--help" || token === "-h") return { name: "help", subject: name };
    if (token === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const [key, ...tail] = token.slice(2).split("=");
      if (!(key in command.inputSchema.properties)) throw invalid(`Unknown option: --${key}`);
      const value = tail.length ? tail.join("=") : tokens[++i];
      if (value === undefined || (!tail.length && value.startsWith("--")))
        throw invalid(`Missing value for --${key}`);
      if (key in input) throw invalid(`Repeated argument: ${key}`);
      input[key] = coerce(value, command.inputSchema.properties[key]);
    } else positional.push(token);
  }
  if (positional.length > command.positional.length)
    throw invalid(`Too many positional arguments for ${name}. Quote multi-word values.`);
  positional.forEach((value, index) => {
    const key = command.positional[index];
    if (key in input) throw invalid(`Repeated argument: ${key}`);
    input[key] = coerce(value, command.inputSchema.properties[key]);
  });
  return { name, args: validateArguments(command, input) };
}
function coerce(value, schema) {
  if (schema.type === "number" || schema.type === "integer")
    return value.trim() ? Number(value) : NaN;
  if (!schema.type || schema.type === "array" || schema.type === "object") {
    try {
      return JSON.parse(value);
    } catch {
      throw invalid("Expected valid JSON.");
    }
  }
  return value;
}
