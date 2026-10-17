// A deterministic playlist for protocol/browser checks; never connects to Spotify.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "../../src/mcp.mjs";
const tracks = [
  { uri: "spotify:track:one", name: "First song", artists: ["First artist"], album: "Test playlist" },
  { uri: "spotify:track:two", name: "Second <script>song</script>", artists: ["Second artist"], album: "Test playlist" },
];
let index = 0;
const state = { state: "playing", context: "spotify:playlist:test", positionMs: 30000, durationMs: 210000, device: "Test speaker", deviceId: "speaker", volume: 35, track: tracks[0] };
const server = createMcpServer({}, { run: async (name, args) => {
  if (name === "pause") state.state = "paused";
  if (["play", "resume"].includes(name)) state.state = "playing";
  if (name === "next") index = (index + 1) % tracks.length;
  if (name === "previous") index = Math.max(0, index - 1);
  if (name === "volume") {
    if (args["device-id"] !== state.deviceId) throw Object.assign(new Error("The active speaker changed."), {code:"STALE_DEVICE"});
    state.volume = args.percent; return { percent: state.volume };
  }
  state.track = tracks[index];
  if (name === "seek") {
    if (args["track-uri"] && args["track-uri"] !== state.track.uri)
      throw Object.assign(new Error("Playback moved to another track."), { code: "STALE_TRACK" });
    state.positionMs = args.seconds * 1000;
  }
  return structuredClone(state);
} });
await server.connect(new StdioServerTransport());
