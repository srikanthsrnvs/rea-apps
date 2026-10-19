import test from "node:test";
import assert from "node:assert/strict";
import { executeConnect, createConnectController, resolveConnectEndpoints, normalizeConnectStatus, normalizeConnectDevices } from "../src/standalone/connect.mjs";
const endpoints = { dealer: "wss://dealer.spotify.com", webgate: "https://spclient.wg.spotify.com" };
const fixture = () => ({ timestamp: String(Date.now()), active_device_id: "speaker", devices: {
  speaker: { device_id: "speaker", name: "LSX 2", device_type: "SPEAKER", volume: 32768, can_play: true, capabilities: { can_be_player: true, is_controllable: true } },
  hidden: { device_id: "hidden", name: "Observer", capabilities: { can_be_player: false, hidden: true } },
}, player_state: { timestamp: String(Date.now()), position_as_of_timestamp: "5000", duration: "180000", is_paused: false, playback_speed: 1,
  context_uri: "spotify:playlist:list", track: { uri: "spotify:track:one", uid: "first", provider: "context", metadata: { title: "First", artist_name: "A", "artist_name:1": "B", album_title: "Album", duration: "180000", image_url: "spotify:image:abcd" } },
  options: { shuffling_context: false }, restrictions: { disallow_seeking_reasons: ["not_supported_by_device"] }, next_tracks: [],
} });
class FakeSocket {
  static instances = [];
  constructor(url) {
    FakeSocket.instances.push(this); this.url = url; this.readyState = 1; this.listeners = new Map(); this.sent = [];
    queueMicrotask(() => this.message({ type: "message", uri: "hm://pusher/v1/connections/test-id", headers: { "Spotify-Connection-Id": "welcome-id" } }));
  }
  addEventListener(name, handler) { const handlers = this.listeners.get(name) ?? []; handlers.push(handler); this.listeners.set(name, handlers); }
  emit(name, value) { for (const handler of this.listeners.get(name) ?? []) handler(value); }
  message(value) { this.emit("message", { data: JSON.stringify(value) }); }
  send(text) { this.sent.push(text); if (JSON.parse(text).type === "ping") queueMicrotask(() => this.message({ type: "pong" })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close", {}); }
}
function protocol(handler = () => {}) {
  let cluster = fixture();
  const calls = [], options = { getAccessToken: async () => "private-test-token", WebSocket: FakeSocket,
    controllerId: "cli", resolveEndpoints: async () => endpoints, timeoutMs: 1200 };
  const request = async (url, opts = {}) => {
    const path = new URL(url).pathname; calls.push({ path, ...opts });
    const result = await handler(path, opts, cluster);
    if (result !== undefined) return result;
    if (opts.method === "DELETE") return null;
    if (opts.method === "PUT" && path.includes("/devices/")) return structuredClone(cluster);
    if (path.endsWith("/cluster")) return structuredClone(cluster);
    return { ack_id: "ack" };
  };
  return { request, options, calls, cluster };
}

test("native cluster strings become playback state, artwork and correctly ordered multiple artists", () => {
  const cluster = fixture(), result = normalizeConnectStatus(cluster, Date.now());
  assert.equal(result.state, "playing"); assert.equal(result.track.name, "First");
  assert.deepEqual(result.track.artists, ["A", "B"]);
  assert.equal(result.track.durationMs, 180000); assert.equal(result.track.imageUrl, "https://i.scdn.co/image/abcd");
  assert.equal(result.durationMs, 180000); assert.equal(result.volume, 50);
  assert.equal(result.restrictions.canSeek, false); assert.equal(result.restrictions.canPause, true);
  assert.equal(result.deviceId, "speaker"); assert.ok(result.positionMs >= 5000 && result.positionMs < 5100);
});

test("inactive orphaned state is paused and hidden observers are excluded from speakers", () => {
  const cluster = fixture(); cluster.active_device_id = "gone";
  assert.equal(normalizeConnectStatus(cluster).state, "paused");
  assert.equal(normalizeConnectDevices(cluster).length, 1);
});

test("adjacent covers follow the native queue order, ignoring hidden and removed rows", () => {
  const cluster = fixture(), row = (name,metadata={}) => ({uri:`spotify:track:${name}`,uid:name,metadata:{title:name,image_url:"spotify:image:abcd",...metadata}});
  cluster.player_state.options.shuffling_context = true;
  cluster.player_state.prev_tracks = [row("oldest"),row("previous"),row("hidden",{hidden:"true"})];
  cluster.player_state.next_tracks = [row("removed"),row("hidden",{hidden_in_queue:"true"}),row("queued",{is_queued:"true"}),row("context")];
  cluster.player_state.next_tracks[0].removed = ["deleted"];
  const result = normalizeConnectStatus(cluster);
  assert.equal(result.adjacentTracks.previous.uri,"spotify:track:previous");
  assert.equal(result.adjacentTracks.next.uri,"spotify:track:queued");
  assert.equal(result.adjacentTracks.next.imageUrl,"https://i.scdn.co/image/abcd");
  assert.equal(result.shuffle,true);
});

test("adjacent covers do not invent playlist wraparound or cross a queue delimiter", () => {
  const cluster = fixture();
  cluster.player_state.next_tracks = [{uri:"spotify:delimiter"},{uri:"spotify:track:wrapped",metadata:{title:"Wrapped"}}];
  assert.deepEqual(normalizeConnectStatus(cluster).adjacentTracks,{previous:null,next:null});
  cluster.player_state.options.repeating_context = true;
  assert.equal(normalizeConnectStatus(cluster).adjacentTracks.next.uri,"spotify:track:wrapped");
});

test("status and devices are direct HTTP reads without a websocket or observer registration", async () => {
  const p = protocol(), count = FakeSocket.instances.length;
  assert.equal((await executeConnect("status", {}, p.request, p.options)).device, "LSX 2");
  assert.equal((await executeConnect("devices", {}, p.request, p.options)).length, 1);
  assert.equal(FakeSocket.instances.length, count);
  assert.ok(p.calls.every((c) => c.path.endsWith("/cluster") && c.method === undefined));
});

test("volume, shuffle and repeat getters need only a cluster read and never register a receiver", async () => {
  const p = protocol(), count = FakeSocket.instances.length;
  assert.equal((await executeConnect("volume", {}, p.request, p.options)).percent, 50);
  assert.equal((await executeConnect("shuffle", {}, p.request, p.options)).shuffle, false);
  assert.equal((await executeConnect("repeat", {}, p.request, p.options)).repeat, "off");
  assert.equal(FakeSocket.instances.length, count);
  assert.ok(p.calls.every(c => c.path.endsWith("/cluster") && !c.method));
});

test("event controller registers a hidden non-player, sends command once, then unregisters", async () => {
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/player/command/")) { assert.equal(opts.body.command.endpoint, "pause"); cluster.player_state.is_paused = true; }
  });
  const result = await executeConnect("pause", {}, p.request, p.options);
  assert.equal(result.state, "paused");
  const registration = p.calls.find((c) => c.path.endsWith("/devices/hobs_cli") && c.method === "PUT");
  assert.equal(registration.headers["X-Spotify-Connection-Id"], "welcome-id");
  assert.deepEqual(registration.body.device.device_info.capabilities, { can_be_player: false, hidden: true, needs_full_player_state: true });
  const commands = p.calls.filter((c) => c.path.includes("/player/command/"));
  assert.equal(commands.length, 1); assert.equal(commands[0].path, "/connect-state/v1/player/command/from/cli/to/speaker");
  assert.match(commands[0].body.command.logging_params.command_id, /^[a-f0-9]{32}$/);
  assert.equal(p.calls.at(-1).method, "DELETE");
  assert.equal(FakeSocket.instances.at(-1).readyState, 3);
});

test("connection errors are sanitized and a playback write is never replayed", async () => {
  const p = protocol((path) => { if (path.includes("/player/command/")) throw Object.assign(new Error("Connection lost"), { code: "NETWORK_ERROR" }); });
  await assert.rejects(executeConnect("pause", {}, p.request, p.options), { code: "NETWORK_ERROR" });
  assert.equal(p.calls.filter((c) => c.path.includes("/player/command/")).length, 1);
  assert.equal(p.calls.at(-1).method, "DELETE");
});

test("stale track guard rejects seek before issuing playback command", async () => {
  const p = protocol();
  await assert.rejects(executeConnect("seek", { seconds: 40, "track-uri": "spotify:track:old" }, p.request, p.options), { code: "STALE_TRACK" });
  assert.ok(p.calls.every((c) => !c.path.includes("/player/command/")));
});

test("native seek sends seek_to in milliseconds and confirms refreshed server state", async () => {
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/player/command/")) {
      assert.equal(opts.body.command.endpoint, "seek_to"); assert.equal(opts.body.command.value, 42000);
      cluster.player_state.position_as_of_timestamp = "42000";
    }
  });
  const result = await executeConnect("seek", { seconds: 42, "track-uri": "spotify:track:one" }, p.request, p.options);
  assert.ok(result.positionMs >= 42000 && result.positionMs < 43500);
});

test("native volume uses 16-bit scale and confirms the returned percentage", async () => {
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/connect/volume/")) { assert.equal(opts.method, "PUT"); assert.equal(opts.body.volume, 26214); assert.deepEqual(Object.keys(opts.body), ["volume"]); cluster.devices.speaker.volume = opts.body.volume; }
  });
  const result = await executeConnect("volume", { percent: 40 }, p.request, p.options);
  assert.deepEqual(result, { percent: 40 });
});

test("a stale volume component never changes the replacement speaker", async () => {
  const p = protocol();
  await assert.rejects(executeConnect("volume", {percent:23,"device-id":"old-speaker"}, p.request, p.options), {code:"STALE_DEVICE"});
  assert.equal(p.calls.some(c => c.path.includes("/connect/volume/")), false);
});

test("native context play preserves URI, skip offset and source attribution", async () => {
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/player/command/")) {
      const command = opts.body.command;
      assert.equal(command.endpoint, "play");
      assert.deepEqual(command.context, { uri: "spotify:playlist:other", url: "context://spotify:playlist:other", metadata: {} });
      assert.deepEqual(command.options.skip_to, { track_uri: "spotify:track:next" });
      assert.equal(command.play_origin.feature_identifier, "rea-spotify-cli");
      cluster.player_state.context_uri = "spotify:playlist:other"; cluster.player_state.track.uri = "spotify:track:next";
    }
  });
  const result = await executeConnect("play", { uri: "spotify:track:next", context: "spotify:playlist:other" }, p.request, p.options);
  assert.equal(result.track.uri, "spotify:track:next");
});

test("dealer cluster pushes update the reusable controller without polling or command replay", async () => {
  const p = protocol(), controller = createConnectController(p.request, p.options);
  try {
    await controller.start();
    const changed = fixture(); changed.timestamp = String(Number(changed.timestamp) + 10); changed.player_state.track.uri = "spotify:track:pushed";
    FakeSocket.instances.at(-1).message({ type: "message", uri: "hm://connect-state/v1/cluster", payloads: [{ cluster: changed }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.status().track.uri, "spotify:track:pushed");
    const old = fixture(); old.timestamp = "1";
    FakeSocket.instances.at(-1).message({ type: "message", uri: "hm://connect-state/v1/cluster", payloads: [{ cluster: old }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.status().track.uri, "spotify:track:pushed");
    assert.equal(p.calls.length, 1);
  } finally { await controller.close(); }
});

test("device aliases route volume commands to the physical ID with target_alias_id", async () => {
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/connect/volume/")) { assert.equal(path.split("/to/")[1], "speaker"); assert.deepEqual(opts.body.command_options, { target_alias_id: 7 }); cluster.devices.speaker.volume = opts.body.volume; }
  });
  p.cluster.devices.speaker.device_aliases = { seven: { id: 7, display_name: "Living room" } };
  p.cluster.devices.speaker.selected_alias_id = 7;
  assert.equal((await executeConnect("volume", { percent: 30 }, p.request, p.options)).percent, 30);
});

test("duplicate remote speaker names cannot dispatch a transfer to an arbitrary device", async () => {
  const p = protocol(); p.cluster.devices.second = { ...p.cluster.devices.speaker, device_id: "second" };
  await assert.rejects(executeConnect("transfer", { device: "LSX 2" }, p.request, p.options), { code: "NOT_FOUND" });
  assert.ok(p.calls.every((c) => !c.path.includes("/connect/transfer/")));
});

test("resolved endpoints cannot exfiltrate access tokens through alternate origins or ports", async () => {
  for (const dealer of ["wss://evil.test", "wss://spotify.com.evil.test", "wss://dealer.spotify.com:444", "wss://user:password@dealer.spotify.com", "wss://dealer.spotify.com/?capture=yes"]) {
    const p = protocol(); p.options.resolveEndpoints = async () => ({ ...endpoints, dealer });
    await assert.rejects(executeConnect("pause", {}, p.request, p.options), { code: "INVALID_ENDPOINT" });
    assert.equal(p.calls.length, 0);
  }
});

test("unknown desktop operations do not register a controller or make network requests", async () => {
  const p = protocol(); await assert.rejects(executeConnect("api-call", {}, p.request, p.options), { code: "UNSUPPORTED" });
  assert.equal(p.calls.length, 0);
});

test("endpoint resolver requests both native services and validates discovery response", async () => {
  const endpoints = await resolveConnectEndpoints(async (url, opts) => {
    assert.equal(url, "https://apresolve.spotify.com/"); assert.deepEqual(opts.query.type, ["dealer", "spclient"]);
    return { dealer: ["dealer.spotify.com:443"], spclient: ["spclient.wg.spotify.com:443"] };
  });
  assert.deepEqual(endpoints, { dealer: "wss://dealer.spotify.com", webgate: "https://spclient.wg.spotify.com" });
});

// Native snapshots carry a cluster revision time and a separate current server time.
test("position uses current server time rather than the older cluster revision timestamp", () => {
  const cluster = fixture(); cluster.player_state.timestamp = "100000";
  cluster.timestamp = "100065"; cluster.server_timestamp_ms = "118000";
  cluster.player_state.position_as_of_timestamp = "0";
  const current = normalizeConnectStatus(cluster, Date.now());
  assert.ok(current.positionMs >= 18000 && current.positionMs < 18100);
  cluster.player_state.is_paused = true;
  assert.equal(normalizeConnectStatus(cluster, Date.now()).positionMs, 0);
});

function queueFixture(p) {
  p.cluster.player_state.queue_revision = "opaque-revision-1";
  p.cluster.player_state.options.repeating_context = true;
  const row = (uid, queued = false, extra = {}) => ({ uri: `spotify:track:${uid}`, uid, provider: queued ? "queue" : "context", metadata: { iteration: "0", ...(queued ? { is_queued: "true" } : {}) }, ...extra });
  p.cluster.player_state.next_tracks = [row("a", true), row("hidden", false, { metadata: { hidden: "true", custom: "preserved" } }), row("b", true),
    { uri: "spotify:delimiter", uid: "delimiter", metadata: { hidden: "true", opaque: "delimiter-value" } }, row("context1"), row("context2", false, { removed: ["unavailable"], blocked: ["retained"] })];
  p.cluster.player_state.prev_tracks = [row("previous", false, { metadata: { custom: "previous-preserved" } })];
}

test("queue clearing submits raw context and previous rows with the opaque revision intact", async () => {
  let submitted;
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/player/command/")) {
      submitted = structuredClone(opts.body.command);
      cluster.player_state.next_tracks = structuredClone(submitted.next_tracks);
      cluster.player_state.queue_revision = "opaque-revision-2";
    }
  });
  queueFixture(p);
  const before = structuredClone(p.cluster.player_state), result = await executeConnect("queue-clear", {}, p.request, p.options);
  assert.equal(submitted.endpoint, "set_queue");
  assert.equal(submitted.queue_revision, "opaque-revision-1");
  assert.deepEqual(submitted.prev_tracks, before.prev_tracks);
  assert.deepEqual(submitted.next_tracks, before.next_tracks.filter((row) => row.metadata.is_queued !== "true"));
  assert.deepEqual(result.queued, []);
});

test("queue move reorders only explicit visible slots and retains hidden and delimiter records", async () => {
  let submitted;
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/player/command/")) { submitted = structuredClone(opts.body.command); cluster.player_state.next_tracks = submitted.next_tracks; }
  });
  queueFixture(p); const before = structuredClone(p.cluster.player_state);
  const result = await executeConnect("queue-move", { uid: "a", index: 1 }, p.request, p.options);
  assert.deepEqual(submitted.next_tracks.map((row) => row.uid), ["b", "hidden", "a", "delimiter", "context1", "context2"]);
  for (const index of [1, 3, 4, 5]) assert.deepEqual(submitted.next_tracks[index], before.next_tracks[index]);
  assert.deepEqual(submitted.prev_tracks, before.prev_tracks);
  assert.deepEqual(result.queued.map((row) => row.uid), ["b", "a"]);
});

test("queue removal matches the exact occurrence and preserves an appended context continuation", async () => {
  let submitted;
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/player/command/")) {
      submitted = structuredClone(opts.body.command);
      cluster.player_state.next_tracks = [...submitted.next_tracks, { uri: "spotify:track:newContext", uid: "newContext", metadata: {}, provider: "context" }];
    }
  });
  queueFixture(p); const before = structuredClone(p.cluster.player_state);
  await executeConnect("queue-remove", { uid: "a" }, p.request, p.options);
  assert.deepEqual(submitted.next_tracks, before.next_tracks.slice(1));
  assert.deepEqual(submitted.prev_tracks, before.prev_tracks);
});

test("duplicate UID iterations and snapshots without an opaque revision cannot trigger queue writes", async () => {
  const p = protocol(); queueFixture(p);
  p.cluster.player_state.next_tracks.push({ ...structuredClone(p.cluster.player_state.next_tracks[0]), metadata: { is_queued: "true", iteration: "1" } });
  await assert.rejects(executeConnect("queue-remove", { uid: "a" }, p.request, p.options), { code: "AMBIGUOUS_QUEUE_ITEM" });
  delete p.cluster.player_state.queue_revision;
  await assert.rejects(executeConnect("queue-clear", {}, p.request, p.options), { code: "UNSUPPORTED" });
  assert.ok(p.calls.every((call) => !call.path.includes("/player/command/")));
});

test("server rejection of a stale queue revision is surfaced without rebuilding or replaying the write", async () => {
  const p = protocol((path) => { if (path.includes("/player/command/")) throw Object.assign(new Error("Stale revision"), { code: "SPOTIFY_ERROR", details: { status: 409 } }); });
  queueFixture(p);
  await assert.rejects(executeConnect("queue-clear", {}, p.request, p.options), { code: "SPOTIFY_ERROR" });
  assert.equal(p.calls.filter((call) => call.path.includes("/player/command/")).length, 1);
});

test("queue output follows native is_queued metadata and filters hidden and removed display rows", async () => {
  const p = protocol(); queueFixture(p);
  p.cluster.player_state.next_tracks[0].provider = "autoplay";
  const result = await executeConnect("queue", { limit: 1 }, p.request, p.options);
  assert.deepEqual(result.queued.map((row) => row.uid), ["a", "b"]);
  assert.deepEqual(result.nextUp.map((row) => row.uid), ["context1"]);
});

test("queue additions include the exact native queued marker and confirm duplicate occurrences", async () => {
  let index = 0;
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/player/command/")) {
      const command = opts.body.command;
      assert.equal(command.endpoint, "add_to_queue");
      assert.deepEqual(command.track, { uri: "spotify:track:a", metadata: { is_queued: "true" }, provider: "queue" });
      cluster.player_state.next_tracks.unshift({ ...structuredClone(command.track), uid: `new${++index}` });
    }
  });
  queueFixture(p);
  const result = await executeConnect("queue-add", { uris: "spotify:track:a,spotify:track:a" }, p.request, p.options);
  assert.equal(result.queued.filter((row) => row.uri === "spotify:track:a").length, 3);
  assert.equal(p.calls.filter((call) => call.path.includes("/player/command/")).length, 2);
});


test("liked-song contexts use the authenticated native username and preserve a selected track", async () => {
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/player/command/")) {
      assert.equal(opts.body.command.context.uri, "spotify:user:account:collection");
      assert.deepEqual(opts.body.command.options.skip_to, { track_uri: "spotify:track:one" });
      cluster.player_state.context_uri = "spotify:user:account:collection";
    }
  });
  p.options.username = "account";
  await executeConnect("play", { uri: "spotify:track:one", context: "liked" }, p.request, p.options);
});

test("an index without a playback context cannot silently resume playback", async () => {
  const p = protocol();
  await assert.rejects(executeConnect("play", { index: 2 }, p.request, p.options), { code: "INVALID_ARGUMENT" });
  assert.ok(p.calls.every((call) => !call.path.includes("/player/command/")));
});


test("native delimiter visibility does not discard raw context continuation during queue edits", async () => {
  const p = protocol((path, opts, cluster) => {
    if (path.includes("/player/command/")) {
      assert.ok(opts.body.command.next_tracks.some((row) => row.uid === "context1"));
      assert.ok(opts.body.command.next_tracks.some((row) => row.uid === "delimiter"));
      cluster.player_state.next_tracks = structuredClone(opts.body.command.next_tracks);
    }
  });
  queueFixture(p); p.cluster.player_state.options.repeating_context = false;
  assert.deepEqual((await executeConnect("queue", {}, p.request, p.options)).nextUp, []);
  await executeConnect("queue-clear", {}, p.request, p.options);
});
