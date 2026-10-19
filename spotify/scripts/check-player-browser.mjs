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
let releaseLateArtwork;
let heldAction = null;
const actionGates = [];
function holdAction(name, reject = false) {
  let entered,release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const gate = {name,reject,entered,release,wait,started};
  actionGates.push(gate); heldAction = gate; return gate;
}
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
      const gate = heldAction?.name === args.name ? heldAction : null;
      if (gate) { heldAction = null; gate.entered(); await gate.wait; }
      if (gate?.reject) {
        result = {isError:true,structuredContent:{ok:false,error:{code:"DISCONNECTED",message:"Device disconnected; action was not repeated."}}};
      } else if (rejectNext && args.name === "spotify_next") {
        rejectNext = false; failedCalls++;
        result = { isError: true, structuredContent: { ok: false, error: { code: "DISCONNECTED", message: "Device disconnected; action was not repeated." } } };
      } else result = await client.callTool(args);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.SPOTIFY_TEST_BROWSER ? { executablePath: process.env.SPOTIFY_TEST_BROWSER } : {}) });
  const imageRequests = [];
  let lateArtworkStarted;
  const lateArtwork = new Promise(resolve => { lateArtworkStarted = resolve; });
  // Images are isolated fixture responses, never a live CDN dependency.
  const artworkSvg = color => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect width="300" height="300" fill="${color}"/><circle cx="210" cy="90" r="100" fill="#eee1c8"/><path d="M0 300V160L300 70V300" fill="#284e47"/><circle cx="90" cy="210" r="62" fill="#e28b5c"/></svg>`;
  const routeArtwork = async route => {
    imageRequests.push(route.request().url());
    assert.equal(route.request().headers().authorization, undefined);
    assert.equal(route.request().headers().referer, undefined);
    if (route.request().url().endsWith("late")) {
      await new Promise(resolve => { releaseLateArtwork = resolve; lateArtworkStarted(); });
    }
    if (route.request().url().endsWith("missing")) return route.fulfill({status:404,contentType:"text/plain",body:"Not found"});
    await route.fulfill({status:200,contentType:"image/svg+xml",body:artworkSvg(route.request().url().endsWith("test-one") ? "#958aab" : "#b78669")});
  };
  const page = await browser.newPage({ viewport: { width: 620, height: 900 } });
  await page.route("https://i.scdn.co/image/**", routeArtwork);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "First song" }).waitFor();
  await frame.locator('#artwork[data-state="ready"]').waitFor();
  assert.equal(await frame.getByRole("img", {name:"Album cover: Test playlist"}).getAttribute("src"), "https://i.scdn.co/image/test-one");
  assert.equal(await frame.locator("#artwork .disc").evaluate(e => getComputedStyle(e).animationPlayState), "running");
  await frame.locator('#artwork-next[data-state="ready"]').waitFor();
  assert.equal(await frame.locator("#artwork-previous").isHidden(),true);
  assert.equal(await frame.locator("#cover-image-next").getAttribute("src"),"https://i.scdn.co/image/test-two");
  const initialImageRequests = imageRequests.length;
  const restingDisc = await frame.locator("#artwork .disc").evaluate(e=>parseFloat(getComputedStyle(e).translate));
  await frame.locator("#artwork .cover").hover();
  await page.waitForTimeout(500);
  assert.ok(await frame.locator("#artwork .disc").evaluate(e=>parseFloat(getComputedStyle(e).translate)) > restingDisc,"Hover brings the record farther out of its sleeve");
  assert.ok(await frame.locator("#artwork .sleeve").evaluate(e=>Number(getComputedStyle(e).scale)) > 1,"Hover gently enlarges the cover");
  assert.equal(await frame.locator("#artwork-next .sleeve").evaluate(e=>getComputedStyle(e).scale),"none","Neighbor previews stay still");
  await page.mouse.move(1,1);
  await page.waitForTimeout(500);
  assert.equal(await frame.locator("#artwork .disc").evaluate(e=>parseFloat(getComputedStyle(e).translate)),restingDisc);
  assert.equal(await frame.locator("#artwork .sleeve").evaluate(e=>getComputedStyle(e).scale),"1");
  const pausedGate = holdAction("spotify_pause");
  await frame.getByRole("button",{name:"Pause",exact:true}).click();
  await pausedGate.started;
  assert.equal(await frame.locator("#play-icon").isVisible(),true,"Pause must show the play triangle before the server responds");
  assert.equal(await frame.locator("#pause-icon").isVisible(),false);
  assert.equal(await frame.locator("#loading-ring").isVisible(),true);
  assert.equal(await frame.locator("#play-pause").isEnabled(),true,"The user can change their intent while an action is in flight");
  assert.equal((await client.callTool({name:"spotify_status",arguments:{}})).structuredContent.result.state,"playing");
  const resumesBefore = calls.filter(c=>c.name === "spotify_resume").length;
  await frame.getByRole("button",{name:"Resume",exact:true}).click();
  assert.equal(await frame.locator("#pause-icon").isVisible(),true,"A queued resume must update the icon immediately");
  assert.equal(calls.filter(c=>c.name === "spotify_resume").length,resumesBefore,"Commands are sent in the user's click order");
  pausedGate.release();
  await frame.locator('#play-pause[aria-busy="false"]').waitFor();
  assert.equal((await client.callTool({name:"spotify_status",arguments:{}})).structuredContent.result.state,"playing");
  const rejectedPause = holdAction("spotify_pause",true);
  await frame.getByRole("button",{name:"Pause",exact:true}).click();
  await rejectedPause.started;
  assert.equal(await frame.locator("#play-icon").isVisible(),true);
  const skipsBeforeRejected = calls.filter(c=>c.name === "spotify_next").length;
  await frame.getByRole("button",{name:"Next track",exact:true}).click();
  await frame.getByRole("heading",{name:"Second <script>song</script>",exact:true}).waitFor();
  rejectedPause.release();
  await frame.getByRole("status").filter({hasText:"Device disconnected"}).waitFor();
  await frame.locator('#play-pause[aria-busy="false"]').waitFor();
  assert.equal(await frame.locator("#pause-icon").isVisible(),true,"Rejected pause rolls back to the actual state");
  assert.equal(calls.filter(c=>c.name === "spotify_next").length,skipsBeforeRejected,"An uncertain or rejected action cannot release later queued commands");
  await frame.getByRole("heading",{name:"First song",exact:true}).waitFor();
  await frame.getByRole("button", { name: "Pause", exact: true }).click();
  await frame.getByRole("button", { name: "Resume", exact: true }).waitFor();
  assert.equal(await frame.locator("#play-icon").isVisible(),true);
  assert.equal(await frame.locator("#pause-icon").isVisible(),false);
  assert.equal(await frame.locator("#artwork .disc").evaluate(e => getComputedStyle(e).animationPlayState), "paused");
  await frame.locator('#play-pause[aria-busy="false"]').waitFor();
  assert.equal((await client.callTool({ name: "spotify_status", arguments: {} })).structuredContent.result.state, "paused");
  await frame.getByRole("button", { name: "Resume", exact: true }).click();
  await frame.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await frame.locator('#play-pause[aria-busy="false"]').waitFor();
  assert.equal(imageRequests.length, initialImageRequests, "Polling and pause/resume must not reload unchanged artwork");
  const nextGate = holdAction("spotify_next");
  await frame.getByRole("button", { name: "Next track", exact: true }).click();
  await nextGate.started;
  await frame.getByRole("heading", { name: "Second <script>song</script>" }).waitFor();
  assert.equal(await frame.locator("#loading-ring").isVisible(),true);
  assert.equal(await frame.locator("#previous").isEnabled(),true);
  assert.equal((await client.callTool({name:"spotify_status",arguments:{}})).structuredContent.result.track.name,"First song","Preview moves before the command finishes");
  await frame.locator('#artwork[data-state="ready"]').waitFor();
  assert.equal(await frame.locator("#cover-image").getAttribute("src"), "https://i.scdn.co/image/test-two");
  await frame.locator('#artwork-window[data-transition="next"]').waitFor();
  const nextStart = await frame.locator("#artwork").evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41);
  await page.waitForTimeout(100);
  const nextEnd = await frame.locator("#artwork").evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41);
  assert.ok(nextStart > nextEnd && nextEnd >= 0,"Confirmed next must slide the incoming cover from right to center");
  await frame.locator('#artwork-window:not([data-transition])').waitFor();
  assert.equal(await frame.locator(".artwork-ghost").count(),0);
  assert.equal(await frame.locator("#cover-image-previous").getAttribute("src"),"https://i.scdn.co/image/test-one");
  nextGate.release();
  await frame.locator('#play-pause[aria-busy="false"]').waitFor();
  assert.equal(await frame.locator("#cover-image-next").getAttribute("src"),"https://i.scdn.co/image/test-three");
  assert.equal(await frame.locator("h1 script").count(), 0);
  await frame.getByRole("button", { name: "Previous track", exact: true }).click();
  await frame.getByRole("heading", { name: "First song" }).waitFor();
  await frame.locator('#artwork-window[data-transition="previous"]').waitFor();
  const previousStart = await frame.locator("#artwork").evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41);
  await page.waitForTimeout(100);
  const previousEnd = await frame.locator("#artwork").evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41);
  assert.ok(previousStart < previousEnd && previousEnd <= 0,"Confirmed previous must slide from left to center");
  await frame.locator('#artwork-window:not([data-transition])').waitFor();
  rejectNext = true;
  await frame.getByRole("button", { name: "Next track", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "Device disconnected" }).waitFor();
  assert.equal(failedCalls, 1);
  assert.equal(await frame.getByRole("heading").textContent(), "First song");
  await frame.locator('#artwork-window:not([data-transition])').waitFor();
  assert.equal(await frame.locator(".artwork-ghost").count(),0,"A rejected skip must restore the original cover");
  await frame.locator("#play-pause:enabled").waitFor();
  assert.ok(calls.some(c => c.name === "spotify_status" && c.arguments.refresh === true), "Error recovery must bypass stale read caches");
  const previousStatusCalls = statusCalls;
  await client.callTool({ name: "spotify_next", arguments: {} });
  await frame.getByRole("heading", { name: "Second <script>song</script>" }).waitFor({ timeout: 10000 });
  assert.ok(statusCalls > previousStatusCalls);
  assert.equal(calls.filter(c => c.name === "spotify_next").length, 2, "Failed next action must not be replayed");
  await frame.locator('#artwork-window[data-transition="next"]').waitFor();
  await frame.locator('#artwork-window:not([data-transition])').waitFor();
  await fs.mkdir(new URL("../.runtime/", import.meta.url), { recursive: true });
  await page.evaluate(() => window.scrollTo(0,0));
  await page.screenshot({ path: fileURLToPath(new URL("../.runtime/player-desktop.png", import.meta.url)), fullPage:true });
  await page.setViewportSize({ width: 320, height: 570 });
  await frame.locator("html").evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await frame.locator("html").evaluate(e => e.scrollWidth <= e.clientWidth), true);
  await frame.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.waitForTimeout(100);
  assert.equal(await frame.locator("html").evaluate(e => e.scrollHeight <= e.clientHeight + 1), true, "Host must resize for player controls");
  assert.equal(await frame.locator(".eyebrow").count(), 0);
  assert.equal(await frame.getByRole("slider").count(),0,"The reference design has no seek or volume slider");
  assert.equal(await frame.getByRole("button").count(),3);
  assert.equal(await frame.locator("#device, #album, .footer").count(),0);
  assert.ok(await frame.locator(".artwork-next").evaluate(e=>getComputedStyle(e).filter.includes("blur")));
  const long = await client.callTool({name:"spotify_status",arguments:{}});
  const longTitle = "A very long song title that must scroll continuously without creating another line";
  long.structuredContent.component.props.playback.track.name = longTitle;
  await page.evaluate(result => window.player.update(result), long);
  await frame.locator("h1.marquee").waitFor();
  assert.equal(await frame.locator("h1").evaluate(e => getComputedStyle(e).whiteSpace), "nowrap");
  assert.equal(await frame.locator("#title-track").evaluate(e => getComputedStyle(e).animationName), "song-marquee");
  assert.equal(await frame.locator("html").evaluate(e => e.scrollWidth <= e.clientWidth), true);
  await page.evaluate(() => window.scrollTo(0,0));
  await page.screenshot({ path: fileURLToPath(new URL("../.runtime/player-mobile.png", import.meta.url)), fullPage:true });
  holdStatus = true;
  const artState = structuredClone(long);
  delete artState.structuredContent.component.props.playback.track.imageUrl;
  await page.evaluate(result => window.player.update(result), artState);
  await frame.locator('#artwork[data-state="empty"]').waitFor();
  await frame.getByRole("img", {name:"Album artwork unavailable"}).waitFor();
  assert.equal(await frame.locator("#cover-image").getAttribute("src"), null);
  artState.structuredContent.component.props.playback.track.imageUrl = "https://i.scdn.co/image/missing";
  await page.evaluate(result => window.player.update(result), artState);
  await frame.locator('#artwork[data-state="unavailable"]').waitFor();
  assert.equal(await frame.locator("#play-pause").isEnabled(), true, "An artwork failure must not disable playback");
  const requestsBeforeInvalid = imageRequests.length;
  for (const url of ["javascript:alert(1)", "http://i.scdn.co/image/test-one", "https://example.com/cover.jpg", "https://i.scdn.co.evil.example/image/album"]) {
    artState.structuredContent.component.props.playback.track.imageUrl = url;
    await page.evaluate(result => window.player.update(result), artState);
    await frame.locator('#artwork[data-state="empty"]').waitFor();
    assert.equal(await frame.locator("#cover-image").getAttribute("src"), null);
  }
  assert.equal(imageRequests.length, requestsBeforeInvalid);
  artState.structuredContent.component.props.playback.track.imageUrl = "https://i.scdn.co/image/late";
  await page.evaluate(result => window.player.update(result), artState);
  await lateArtwork;
  assert.equal(await frame.locator("#loading-ring").isVisible(),true,"Loading new cover art keeps the pending indicator visible");
  await page.evaluate(result => window.player.update(result), long);
  await frame.locator('#artwork[data-state="ready"]').waitFor();
  const currentCover = await frame.locator("#cover-image").getAttribute("src");
  releaseLateArtwork();
  await page.waitForTimeout(100);
  assert.equal(await frame.locator("#cover-image").getAttribute("src"), currentCover, "A late image must not restore the previous cover");
  await page.emulateMedia({reducedMotion:"reduce"});
  assert.equal(await frame.locator("#artwork .disc").evaluate(e => getComputedStyle(e).animationName), "none");
  await frame.locator("#artwork .cover").hover();
  assert.equal(await frame.locator("#artwork .sleeve").evaluate(e=>getComputedStyle(e).scale),"1","Reduced motion disables hover growth");
  assert.equal(await frame.locator("#artwork .disc").evaluate(e=>parseFloat(getComputedStyle(e).translate)),restingDisc);
  await page.mouse.move(1,1);
  const reduced = structuredClone(long);
  reduced.structuredContent.component.props.playback.track = {...reduced.structuredContent.component.props.playback.track,uri:"spotify:track:three",name:"Third song"};
  delete reduced.structuredContent.component.props.playback.adjacentTracks;
  await page.evaluate(result => window.player.update(result), reduced);
  await frame.getByRole("heading",{name:"Third song",exact:true}).waitFor();
  assert.equal(await frame.locator("#artwork-window").getAttribute("data-transition"),null);
  assert.equal(await frame.locator(".artwork-ghost").count(),0);
  assert.equal(await frame.locator("#artwork-next").isHidden(),true);
  assert.equal(await frame.locator("#artwork-previous").isHidden(),true);
  await page.evaluate(result => window.player.update(result), long);
  await page.emulateMedia({reducedMotion:"no-preference"});
  holdStatus = false;
  await frame.locator("body").evaluate(() => window.parent.postMessage({jsonrpc:"2.0",id:9999,method:"tools/call",params:{name:"spotify_playlist_unfollow",arguments:{uri:"spotify:playlist:test"}}}, "*"));
  await page.waitForTimeout(100);
  assert.equal(calls.some(c => c.name === "spotify_playlist_unfollow"), false);
  const restricted = await client.callTool({name:"spotify_status", arguments:{}});
  restricted.structuredContent.component.props.playback.restrictions = {canPause:false,canResume:false,canSkipNext:false,canSkipPrevious:false,canSeek:false};
  await page.evaluate(result => window.player.update(result), restricted);
  for (const id of ["play-pause", "next", "previous"]) assert.equal(await frame.locator(`#${id}`).isDisabled(), true);
  await page.evaluate(() => window.player.destroy());
  assert.equal(await page.locator("iframe").count(), 0);
  const secret = randomBytes(32).toString("base64url");
  viewer = await startPlayerServer({ secret, expiresAt: Date.now() + 60000, run: async (name, args) => {
    const response = await client.callTool({name:`spotify_${name}`, arguments:args});
    if (response.isError) throw Error(response.structuredContent.error.message);
    return response.structuredContent.result;
  } });
  const standalone = await browser.newPage({viewport:{width:500,height:900}});
  await standalone.route("https://i.scdn.co/image/**", routeArtwork);
  standalone.on("pageerror", error => errors.push(error.message));
  await standalone.goto(`http://127.0.0.1:${viewer.port}/#key=${secret}`);
  const live = standalone.frameLocator("iframe");
  await live.getByRole("heading",{name:"Second <script>song</script>"}).waitFor();
  await live.locator('#artwork[data-state="ready"]').waitFor();
  await live.getByRole("button",{name:"Pause",exact:true}).click();
  try { await live.getByRole("button",{name:"Resume",exact:true}).waitFor({timeout:5000}); }
  catch (error) { console.error(JSON.stringify({browserErrors:errors,viewerError:await live.locator("#error").textContent(),state:(await client.callTool({name:"spotify_status",arguments:{}})).structuredContent.result.state})); throw error; }
  assert.equal(await live.locator("#play-icon").isVisible(),true);
  assert.equal(await live.locator("#pause-icon").isVisible(),false);
  await live.locator('#play-pause[aria-busy="false"]').waitFor();
  await live.getByRole("button",{name:"Resume",exact:true}).click();
  await live.getByRole("button",{name:"Pause",exact:true}).waitFor();
  assert.equal(await live.locator("#pause-icon").isVisible(),true);
  await live.locator('#play-pause[aria-busy="false"]').waitFor();
  await standalone.screenshot({path:fileURLToPath(new URL("../.runtime/player-viewer.png",import.meta.url))});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ["initialize", "playlist", "album art and track changes", "artwork fallback and origin validation", "late artwork response", "disc animation and reduced motion", "visible play/pause SVG icons", "immediate feedback before acknowledgement", "loading ring", "ordered rapid clicks", "rollback cancels unsent actions", "pause", "resume", "next", "previous", "minimal neutral design", "cropped queue previews", "directional cover motion", "single-line title scrolling", "escaped titles", "mutation failure", "external playback refresh", "mobile layout", "action allowlist", "Spotify restrictions", "disposal", "authenticated standalone viewer"], screenshots: [".runtime/player-desktop.png", ".runtime/player-mobile.png", ".runtime/player-viewer.png"] }));
} finally {
  holdStatus = false;
  for (const gate of actionGates) gate.release();
  releaseLateArtwork?.();
  await browser?.close();
  await viewer?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await client.close();
}
