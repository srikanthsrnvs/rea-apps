# Prebuilt Spotify player

Playback commands return their existing result plus a `component` descriptor. The component is written in advance and loaded from a fixed MCP resource, `ui://spotify/player-v1.html`. The model supplies the playback request, never generates the player’s HTML, and does not handle button clicks.

The visible design is a neutral frosted card with softly blurred neighboring
covers, a rounded album sleeve and metallic CD, centered song/artist, and three
buttons: previous, play/pause and next. It has no seek timeline, volume row,
album subtitle, device footer, branding header or generated playlist text.

```json
{
  "ok": true,
  "result": { "state": "playing", "track": { "name": "Song" } },
  "component": {
    "id": "spotify.player",
    "version": 1,
    "resourceUri": "ui://spotify/player-v1.html",
    "mimeType": "text/html;profile=mcp-app",
    "props": { "playback": { "state": "playing", "track": { "name": "Song" } } },
    "actions": {
      "refresh": "spotify_status",
      "pause": "spotify_pause",
      "resume": "spotify_resume",
      "previous": "spotify_previous",
      "next": "spotify_next",
      "seek": "spotify_seek",
      "volume": "spotify_volume"
    }
  }
}
```

The actual `props.playback` also contains the track URI, artists, album, playlist/context URI, position, duration, device, volume, restrictions and observation timestamp. When native Connect metadata supplies artwork, `props.playback.track.imageUrl` contains its public cover URL. The descriptor accompanies `status`, `play`, `pause`, `resume`, `toggle`, `next`, `previous`, `seek`, `shuffle`, `repeat` and `transfer` when they return playback state. Errors and unrelated commands do not fabricate a player or report a successful mutation.

Native playback results also include `adjacentTracks: { previous, next }`, passed
unchanged to `props.playback.adjacentTracks`. Each neighbor is a normalized track
with its URI, occurrence UID, title, artists, album and optional `imageUrl`, or
`null` when unknown. These are the closest visible entries in Spotify's current
Connect queue, including queued tracks and shuffle/autoplay order. Hidden,
removed and delimiter entries are excluded; context wraparound is shown only
when the native queue permits it. A status read uses its existing cluster
response, without a second queue request or catalog lookup.

## MCP Apps and ChatGPT

Run the existing `spotify mcp` server. Its playback tool descriptors advertise `_meta.ui.resourceUri`; it serves the static HTML through `resources/read`, returns data in `structuredContent`, and includes ChatGPT compatibility metadata. The player initializes the MCP Apps bridge and calls `tools/call` directly for user actions. No new HTTP port, public tunnel, Spotify token, or browser on the Orin is needed for this component.

**The client must support and connect to this MCP server and its UI resources.** Shell output or an ordinary text-only tool cannot make ChatGPT display an interactive component just by containing JSON or HTML. This change implements the resource/tool contract; it does not register a connector in this chat, deploy a remote MCP endpoint, or modify the client’s renderer. The existing launcher serves MCP over local stdio; remote ChatGPT deployments need an authenticated MCP transport reachable by that host.

The protocol follows the [official OpenAI UI guide](https://developers.openai.com/plugins/build/chatgpt-ui) and [MCP Apps quickstart](https://developers.openai.com/plugins/build/app-quickstart).

## Standalone live viewer

For clients without MCP Apps rendering, `spotify player` starts an optional loopback HTTP viewer and returns the same prebuilt component plus its URL. `spotify player --public --cloudflared-path /path/to/cloudflared` returns an expiring HTTPS link accessible from another computer. Cloudflared is optional and is not installed or started by normal CLI setup/commands. An existing authenticated frontend can instead use the host adapter directly, without a tunnel.

The viewer runs only Node HTTP on the host; HTML renders on the user's client. Its callbacks allow status, pause/resume, previous/next, guarded seek and guarded volume changes only. Spotify tokens stay on the backend. The link's fragment carries a separate random capability key; the server requires it for every control request. Keep the complete link private. The key is bound to the current account/controller, expires after 30 minutes by default (maximum 120), and is revoked on account changes. `--ttl-minutes N` selects its lifetime. `spotify player --stop` closes the viewer and tunnel without stopping music. Logout also stops the viewer.

While a viewer is active, playback/status results include `component.url` and `component.expiresAt` alongside the normal MCP resource descriptor. The same URL is suitable as an iframe source. Hosts with MCP Apps rendering can continue using the static resource and direct tool callbacks without starting this optional service. This repository does not change the renderer of a text-only chat: open or embed the returned URL in that client instead.

## Your own renderer

Retrieve the same resource using MCP `resources/read`, or run `spotify component` on the backend and read `contents[0]`. Bundle `src/player/host.mjs` with your frontend, then mount it once:

```js
import { mountSpotifyPlayer } from "./player/host.mjs";

const player = mountSpotifyPlayer(container, {
  resource,                  // static resource from the trusted Spotify server
  output: playbackToolResult, // the {ok, result, component} object
  invoke: (name, args) => yourAuthenticatedBackend.callTool(name, args),
});

// A later model-initiated playback command can update this same player:
player.update(nextPlaybackToolResult);
// Remove its listeners and iframe when the message/view closes:
player.destroy();
```

For a CLI-backed agent, the backend maps the seven fixed `spotify_*` player actions to the corresponding CLI commands, validates arguments and returns their JSON. Keep that routing on the backend connected to the authenticated Spotify runtime. Do not pass arbitrary command strings to a shell or expose Spotify’s debugging endpoint to the client. The adapter allows only status, pause, resume, previous, next, seek and volume, with validated track/device guards. Its iframe is sandboxed without same-origin access. The model is not involved in these callbacks.

## Playback behavior

- Album artwork appears in a rounded sleeve with a metallic CD beside it. The disc rotates while playback is running and pauses when playback pauses or becomes stale. Reduced-motion preferences disable rotation.
- Artwork comes from the existing native playback metadata, without another Spotify API request. The client's browser fetches HTTPS images only from `https://i.scdn.co/image/`; both MCP CSP metadata and the standalone viewer permit that image origin. Spotify tokens and viewer keys are never sent with image requests, and no referrer is sent. Custom hosts must also permit this image origin in their iframe CSP.
- Track changes replace the cover, while routine status updates and pause/resume reuse it. Missing, unsupported or failed images show a music-note placeholder without blocking the controls; a late response for an old cover cannot replace the current one.
- Previous and next covers peek in from the card's edges, smaller and faded. Unknown neighbors are hidden; a known track without artwork uses the same placeholder. The player never guesses neighbors from search results or playlist sorting.
- A confirmed next/previous transition slides the artwork in from the corresponding side with a short scale/fade and matching text motion. Natural advances and external changes use the last known queue to select the direction; unrelated track changes crossfade. Previous can restart the current song according to Spotify's behavior, in which case the cover stays still. Failed skips do not advance the artwork, rapid confirmed changes replace the active animation, and reduced-motion preferences disable these transitions.
- The large button explicitly pauses or resumes; it does not blindly toggle stale state.
- Previous/next follow Spotify’s active playlist or queue, including its own shuffle and repeat rules.
- Seeking remains available through the CLI and host adapter using seconds and the current `track-uri`. The runtime rejects it if playback changed tracks before execution; the minimal card has no seek slider.
- The player refreshes every three seconds while visible and respects Spotify’s control restrictions. All controls affect the active Connect device. An older in-flight status read cannot overwrite a local control result.
- Successful controls reuse the confirmed state returned by the action. Manual refresh and error recovery explicitly bypass read caches; mutations are never replayed for recovery.
- Pending actions disable controls. Errors are shown and followed by a status read; an uncertain mutation is never automatically repeated.
- Volume and mute remain available through the CLI/host adapter, outside the minimal card. Changes include the expected device ID; a stale control cannot change a replacement speaker.
- Track titles stay on one line. Overflowing titles scroll right to left; reduced-motion preferences disable the animation while preserving the complete accessible title.
- There is no generated UI, remote desktop streaming, external frontend dependency, or separate audio player. Spotify continues to play on the selected device.

## Verification

`npm test` covers the actual stdio MCP resource and metadata, playlist controls, preserved CLI results and stale-track seek rejection. `node scripts/check-player-browser.mjs` uses Playwright and a deterministic MCP fixture for browser acceptance, without changing real playback. Install Playwright in the development environment or set `SPOTIFY_PLAYWRIGHT_MODULE` to its module; `SPOTIFY_TEST_BROWSER` optionally selects an existing Chromium executable. Playwright is not required by the CLI or the component.

Browser acceptance checks the actual reusable host adapter, the minimal three-button layout, neighboring covers and blur, directional motion and animation cleanup, cover loading and track changes, artwork fallback and origin restrictions, reduced motion, pause/resume, previous/next, single-line scrolling titles, escaped metadata, failed actions, external state refresh, mobile layout, action allowlisting and disposal. CLI/MCP tests retain separate seek and volume coverage. Images are supplied by isolated browser fixtures, so acceptance does not depend on Spotify's CDN. Screenshots go under the ignored `.runtime/` directory. A real Spotify status read also verified that the tool returns the current track, artwork URL, adjacent tracks and component together; browser control checks use the isolated playlist fixture.
