import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PLAYER_URI, PLAYER_MIME, playbackResult, playerResource } from "../src/player.mjs";

test("playback results retain the existing result and reference one static component", async () => {
  const state = { state: "playing", track: { name: "Song", uri: "spotify:track:one", imageUrl: "https://i.scdn.co/image/album" }, positionMs: 42, durationMs: 1000, volume: 23 };
  const output = playbackResult("play", state);
  assert.equal(output.result, state);
  assert.equal(output.component.resourceUri, PLAYER_URI);
  assert.equal(output.component.actions.pause, "spotify_pause");
  assert.equal(output.component.actions.volume, "spotify_volume");
  assert.equal(output.component.props.playback.volume, 23);
  assert.equal(output.component.props.playback.positionMs, 42);
  assert.equal(output.component.props.playback.track.imageUrl, state.track.imageUrl);
  assert.equal(playbackResult("search", { tracks: [] }).component, undefined);
  assert.equal(playbackResult("play", null).component, undefined);
  const resource = await playerResource();
  assert.equal(resource.mimeType, PLAYER_MIME);
  assert.ok(resource.text.includes('id="play-pause"'));
  assert.deepEqual(resource._meta.ui.csp.connectDomains, []);
  assert.deepEqual(resource._meta.ui.csp.resourceDomains, ["https://i.scdn.co"]);
  assert.deepEqual(resource._meta["openai/widgetCSP"].resource_domains, ["https://i.scdn.co"]);
});

test("MCP advertises and serves the player; controls operate the same playlist session", async () => {
  const client = new Client({ name: "player-integration", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/player-mcp.mjs", import.meta.url))], stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const name of ["play", "status", "pause", "resume", "next", "previous", "seek", "volume"]) {
      const tool = tools.find(t => t.name === `spotify_${name}`);
      assert.equal(tool._meta.ui.resourceUri, PLAYER_URI);
      assert.ok(tool._meta.ui.visibility.includes("app"));
    }
    assert.equal(tools.find(t => t.name === "spotify_search")._meta?.ui, undefined);
    assert.ok((await client.listResources()).resources.some(r => r.uri === PLAYER_URI));
    const resource = (await client.readResource({ uri: PLAYER_URI })).contents[0];
    assert.equal(resource.mimeType, PLAYER_MIME);
    assert.equal(resource.text, (await playerResource()).text);
    const call = async (name, args = {}) => client.callTool({ name: `spotify_${name}`, arguments: args });
    let output = (await call("play")).structuredContent;
    assert.equal(output.component.props.playback.track.name, "First song");
    assert.equal(output.component.props.playback.track.imageUrl, "https://i.scdn.co/image/test-one");
    output = (await call("pause")).structuredContent;
    assert.equal(output.result.state, "paused");
    assert.equal((await call("resume")).structuredContent.result.state, "playing");
    output = (await call("next")).structuredContent;
    assert.match(output.result.track.name, /^Second/);
    assert.equal(output.component.props.playback.track.imageUrl, "https://i.scdn.co/image/test-two");
    assert.equal(output.result.context, "spotify:playlist:test");
    const stale = await call("seek", { seconds: 90, "track-uri": "spotify:track:one" });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.error.code, "STALE_TRACK");
    assert.equal(stale.structuredContent.component, undefined);
    assert.equal((await call("previous")).structuredContent.result.track.uri, "spotify:track:one");
    assert.equal((await call("seek", { seconds: 90, "track-uri": "spotify:track:one" })).structuredContent.result.positionMs, 90000);
    assert.equal((await call("volume", {percent:0,"device-id":"speaker"})).structuredContent.result.percent, 0);
    assert.equal((await call("status")).structuredContent.component.props.playback.volume, 0);
  } finally { await client.close(); }
});
