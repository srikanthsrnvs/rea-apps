# Prebuilt Spotify player

Playback commands return their existing result plus a `component` descriptor. The component is written in advance and loaded from a fixed MCP resource, `ui://spotify/player-v1.html`. The model supplies the playback request, never generates the player’s HTML, and does not handle button clicks.

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
      "seek": "spotify_seek"
    }
  }
}
```

The actual `props.playback` also contains the track URI, artists, album, playlist/context URI, position, duration, device, restrictions and observation timestamp. The descriptor accompanies `status`, `play`, `pause`, `resume`, `toggle`, `next`, `previous`, `seek`, `shuffle`, `repeat` and `transfer` when they return playback state. Errors and unrelated commands do not fabricate a player or report a successful mutation.

## MCP Apps and ChatGPT

Run the existing `spotify mcp` server. Its playback tool descriptors advertise `_meta.ui.resourceUri`; it serves the static HTML through `resources/read`, returns data in `structuredContent`, and includes ChatGPT compatibility metadata. The player initializes the MCP Apps bridge and calls `tools/call` directly for user actions. No new HTTP port, public tunnel, Spotify token, or browser on the Orin is needed for this component.

**The client must support and connect to this MCP server and its UI resources.** Shell output or an ordinary text-only tool cannot make ChatGPT display an interactive component just by containing JSON or HTML. This change implements the resource/tool contract; it does not register a connector in this chat, deploy a remote MCP endpoint, or modify the client’s renderer. The existing launcher serves MCP over local stdio; remote ChatGPT deployments need an authenticated MCP transport reachable by that host.

The protocol follows the [official OpenAI UI guide](https://developers.openai.com/plugins/build/chatgpt-ui) and [MCP Apps quickstart](https://developers.openai.com/plugins/build/app-quickstart).

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

For a CLI-backed agent, the backend maps the six fixed `spotify_*` player actions to the corresponding CLI commands, validates arguments and returns their JSON. Keep that routing on the backend connected to the authenticated Spotify runtime. Do not pass arbitrary command strings to a shell or expose Spotify’s debugging endpoint to the client. The adapter allows only status, pause, resume, previous, next and seek, with validated seek arguments. Its iframe is sandboxed without same-origin access. The model is not involved in these callbacks.

## Playback behavior

- The large button explicitly pauses or resumes; it does not blindly toggle stale state.
- Previous/next follow Spotify’s active playlist or queue, including its own shuffle and repeat rules.
- Seeking submits seconds and the current `track-uri`. The runtime rejects the action if playback changed tracks before it executed.
- The player interpolates elapsed time locally, refreshes every three seconds while visible, and respects Spotify’s control restrictions. All controls affect the active Connect device shown on the card.
- Pending actions disable controls. Errors are shown and followed by a status read; an uncertain mutation is never automatically repeated.
- There is no generated UI, remote desktop streaming, external frontend dependency, or separate audio player. Spotify continues to play on the selected device.

## Verification

`npm test` covers the actual stdio MCP resource and metadata, playlist controls, preserved CLI results and stale-track seek rejection. `node scripts/check-player-browser.mjs` uses Playwright and a deterministic MCP fixture for browser acceptance, without changing real playback. Install Playwright in the development environment or set `SPOTIFY_PLAYWRIGHT_MODULE` to its module; `SPOTIFY_TEST_BROWSER` optionally selects an existing Chromium executable. Playwright is not required by the CLI or the component.

Browser acceptance checks the actual reusable host adapter, pause/resume, previous/next, seek, escaped metadata, failed actions, external state refresh, mobile layout, action allowlisting and disposal. Screenshots go under the ignored `.runtime/` directory. A real local Spotify status read also verified that the tool returns the current track and component together; the browser control checks use the isolated playlist fixture.
