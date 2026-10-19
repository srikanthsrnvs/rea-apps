import { readFile } from "node:fs/promises";

export const PLAYER_URI = "ui://spotify/player-v1.html";
export const PLAYER_MIME = "text/html;profile=mcp-app";
export const playerCommands = new Set([
  "status", "play", "pause", "resume", "toggle", "next", "previous", "seek",
  "shuffle", "repeat", "transfer", "player", "volume",
]);

export const playerToolMeta = {
  ui: { resourceUri: PLAYER_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": PLAYER_URI,
  "openai/widgetAccessible": true,
};

export function playbackResult(name, result) {
  const output = { ok: true, result };
  if (!playerCommands.has(name) || !["playing", "paused", "stopped"].includes(result?.state))
    return output;
  output.component = {
    id: "spotify.player", version: 1, resourceUri: PLAYER_URI, mimeType: PLAYER_MIME,
    ...(result.viewer?.url ? { url: result.viewer.url, expiresAt: result.viewer.expiresAt } : {}),
    props: {
      playback: {
        state: result.state, track: result.track, context: result.context,
        adjacentTracks: result.adjacentTracks,
        positionMs: result.positionMs, durationMs: result.durationMs,
        device: result.device, deviceId: result.deviceId, restrictions: result.restrictions,
        volume: result.volume,
        observedAt: Date.now(),
      },
    },
    actions: {
      refresh: "spotify_status", pause: "spotify_pause", resume: "spotify_resume",
      next: "spotify_next", previous: "spotify_previous", seek: "spotify_seek", volume: "spotify_volume",
    },
  };
  return output;
}

export async function playerResource() {
  return {
    uri: PLAYER_URI, mimeType: PLAYER_MIME,
    text: await readFile(new URL("./player/player.html", import.meta.url), "utf8"),
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: ["https://i.scdn.co"] } },
      "openai/widgetDescription": "Minimal Spotify player with a frosted neutral card, album art carousel, song and artist, and previous, play/pause and next controls. Uses the active Spotify Connect device.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetCSP": { connect_domains: [], resource_domains: ["https://i.scdn.co"] },
    },
  };
}
