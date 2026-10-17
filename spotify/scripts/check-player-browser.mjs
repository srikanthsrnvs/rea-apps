// Browser acceptance with a deterministic MCP playlist. No real playback changes.
// SPOTIFY_PLAYWRIGHT_MODULE may point to an installed playwright/index.mjs.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PLAYER_URI } from "../src/player.mjs";
import { startPlayerServer } from "../src/player/server.mjs";
import { randomBytes } from "node:crypto";
const { chromium } = await import(process.env.SPOTIFY_PLAYWRIGHT_MODULE || "playwright");
const client = new Client({ name: "player-browser-test", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL("../test/fixtures/player-mcp.mjs", import.meta.url))], stderr: "pipe" });
let browser, server, viewer;
let rejectNext = false, failedCalls = 0, holdStatus = false, statusCalls = 0;
const calls = [];
try {
  await client.connect(transport);
  const resource = (await client.readResource({ uri: PLAYER_URI })).contents[0];
  const hostSource = await fs.readFile(new URL('../src/player/host.mjs', import.meta.url), 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Spotify player test host</title></head><body style="margin:0;background:#fff"><div id="player"></div><script type="module">
  import {mountSpotifyPlayer} from '/host.mjs';
  const resource=await(await fetch('/resource')).json();
  window.player=mountSpotifyPlayer(document.getElementById('player'),{resource,invoke:async(name,args)=>await(await fetch('/rpc',{method:'POST',body:JSON.stringify({name,arguments:args})})).json()});
  </script></body></html>`;
  server = http.createServer(async (req, res) => {
    if (req.url === "/host.mjs") { res.writeHead(200, {"content-type":"text/javascript"}); res.end(hostSource); return; }
    if (req.url === "/resource") { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify(resource)); return; }
    if (req.url === "/" || req.url === "/player") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(req.url === "/" ? html : resource.text); return;
    }
    if (req.url !== "/rpc" || req.method !== "POST") { res.writeHead(404); res.end(); return; }
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const args = JSON.parse(body); calls.push(args);
      if (args.name === "spotify_status") {
        statusCalls++;
        while (holdStatus) await new Promise(r => setTimeout(r, 20));
      }
      let result;
      if (rejectNext && args.name === "spotify_next") {
        rejectNext = false; failedCalls++;
        result = { isError: true, structuredContent: { ok: false, error: { code: "DISCONNECTED", message: "Device disconnected; action was not repeated." } } };
      } else result = await client.callTool(args);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.SPOTIFY_TEST_BROWSER ? { executablePath: process.env.SPOTIFY_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 620, height: 570 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "First song" }).waitFor();
  await frame.getByRole("button", { name: "Pause", exact: true }).click();
  await frame.getByRole("button", { name: "Resume", exact: true }).waitFor();
  assert.equal((await client.callTool({ name: "spotify_status", arguments: {} })).structuredContent.result.state, "paused");
  await frame.getByRole("button", { name: "Resume", exact: true }).click();
  await frame.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await frame.getByRole("button", { name: "Next track", exact: true }).click();
  await frame.getByRole("heading", { name: "Second <script>song</script>" }).waitFor();
  assert.equal(await frame.locator("h1 script").count(), 0);
  await frame.getByRole("button", { name: "Previous track", exact: true }).click();
  await frame.getByRole("heading", { name: "First song" }).waitFor();
  const slider = frame.getByRole("slider", { name: "Playback position" });
  await slider.fill("90"); await slider.dispatchEvent("change");
  await frame.getByText("1:30", { exact: true }).waitFor();
  const seek = calls.find(c => c.name === "spotify_seek");
  assert.equal(seek.arguments.seconds, 90);
  assert.equal(seek.arguments["track-uri"], "spotify:track:one");
  const volume = frame.getByRole("slider", {name:"Volume",exact:true});
  await volume.fill("42"); await volume.dispatchEvent("change");
  await frame.locator("#mute:enabled").waitFor();
  assert.equal((await client.callTool({name:"spotify_status",arguments:{}})).structuredContent.result.volume, 42);
  const volumeCall = calls.find(c => c.name === "spotify_volume");
  assert.deepEqual(volumeCall.arguments, {percent:42,"device-id":"speaker"});
  await frame.getByRole("button", {name:"Mute",exact:true}).click();
  await frame.getByRole("button", {name:"Unmute",exact:true}).waitFor();
  await frame.getByRole("button", {name:"Unmute",exact:true}).click();
  await frame.locator("#mute:enabled").waitFor();
  assert.equal((await client.callTool({name:"spotify_status",arguments:{}})).structuredContent.result.volume, 42);
  rejectNext = true;
  await frame.getByRole("button", { name: "Next track", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "Device disconnected" }).waitFor();
  assert.equal(failedCalls, 1);
  assert.equal(await frame.getByRole("heading").textContent(), "First song");
  await frame.getByRole("button", { name: "Refresh playback" }).click();
  await frame.locator("#refresh:enabled").waitFor();
  assert.ok(calls.some(c => c.name === "spotify_status" && c.arguments.refresh === true), "Manual refresh must reach the backend with fresh-read semantics");
  const previousStatusCalls = statusCalls;
  await client.callTool({ name: "spotify_next", arguments: {} });
  await frame.getByRole("heading", { name: "Second <script>song</script>" }).waitFor({ timeout: 10000 });
  assert.ok(statusCalls > previousStatusCalls);
  assert.equal(calls.filter(c => c.name === "spotify_next").length, 2, "Failed next action must not be replayed");
  await fs.mkdir(new URL("../.runtime/", import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("../.runtime/player-desktop.png", import.meta.url)) });
  await page.setViewportSize({ width: 320, height: 570 });
  assert.equal(await frame.locator("html").evaluate(e => e.scrollWidth <= e.clientWidth), true);
  await frame.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.waitForTimeout(100);
  assert.equal(await frame.locator("html").evaluate(e => e.scrollHeight <= e.clientHeight + 1), true, "Host must resize for player controls");
  assert.equal(await frame.locator(".eyebrow").count(), 0);
  const long = await client.callTool({name:"spotify_status",arguments:{}});
  const longTitle = "A very long song title that must scroll continuously without creating another line";
  long.structuredContent.component.props.playback.track.name = longTitle;
  await page.evaluate(result => window.player.update(result), long);
  await frame.locator("h1.marquee").waitFor();
  assert.equal(await frame.locator("h1").evaluate(e => getComputedStyle(e).whiteSpace), "nowrap");
  assert.equal(await frame.locator("#title-track").evaluate(e => getComputedStyle(e).animationName), "song-marquee");
  assert.equal(await frame.locator("html").evaluate(e => e.scrollWidth <= e.clientWidth), true);
  await page.screenshot({ path: fileURLToPath(new URL("../.runtime/player-mobile.png", import.meta.url)) });
  await frame.locator("body").evaluate(() => window.parent.postMessage({jsonrpc:"2.0",id:9999,method:"tools/call",params:{name:"spotify_playlist_unfollow",arguments:{uri:"spotify:playlist:test"}}}, "*"));
  await page.waitForTimeout(100);
  assert.equal(calls.some(c => c.name === "spotify_playlist_unfollow"), false);
  const restricted = await client.callTool({name:"spotify_status", arguments:{}});
  restricted.structuredContent.component.props.playback.restrictions = {canPause:false,canResume:false,canSkipNext:false,canSkipPrevious:false,canSeek:false};
  await page.evaluate(result => window.player.update(result), restricted);
  await frame.locator("#seek:disabled").waitFor();
  for (const id of ["play-pause", "next", "previous"]) assert.equal(await frame.locator(`#${id}`).isDisabled(), true);
  await page.evaluate(() => window.player.destroy());
  assert.equal(await page.locator("iframe").count(), 0);
  const secret = randomBytes(32).toString("base64url");
  viewer = await startPlayerServer({ secret, expiresAt: Date.now() + 60000, run: async (name, args) => {
    const response = await client.callTool({name:`spotify_${name}`, arguments:args});
    if (response.isError) throw Error(response.structuredContent.error.message);
    return response.structuredContent.result;
  } });
  const standalone = await browser.newPage({viewport:{width:500,height:570}});
  standalone.on("pageerror", error => errors.push(error.message));
  await standalone.goto(`http://127.0.0.1:${viewer.port}/#key=${secret}`);
  const live = standalone.frameLocator("iframe");
  await live.getByRole("heading",{name:"Second <script>song</script>"}).waitFor();
  await live.getByRole("button",{name:"Pause",exact:true}).click();
  await live.getByRole("button",{name:"Resume",exact:true}).waitFor();
  await live.getByRole("button",{name:"Resume",exact:true}).click();
  await live.getByRole("button",{name:"Pause",exact:true}).waitFor();
  await standalone.screenshot({path:fileURLToPath(new URL("../.runtime/player-viewer.png",import.meta.url))});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ["initialize", "playlist", "pause", "resume", "next", "previous", "seek", "volume and mute", "single-line title scrolling", "escaped titles", "mutation failure", "external playback refresh", "mobile layout", "action allowlist", "Spotify restrictions", "disposal", "authenticated standalone viewer"], screenshots: [".runtime/player-desktop.png", ".runtime/player-mobile.png", ".runtime/player-viewer.png"] }));
} finally {
  holdStatus = false;
  await browser?.close();
  await viewer?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await client.close();
}
