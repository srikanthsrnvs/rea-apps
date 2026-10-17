import { randomBytes } from "node:crypto";
import { spotifyUri, spotifyUris } from "./uri.mjs";

const error = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
const fail = (code, message, details) => { throw error(code, message, details); };
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function spotifyEndpoint(value, protocol) {
  let url;
  try { url = new URL(value); } catch { fail("INVALID_ENDPOINT", "Spotify endpoint resolution returned an invalid URL."); }
  if (url.protocol !== protocol || url.username || url.password || (url.port && url.port !== "443") ||
    !(url.hostname === "spotify.com" || url.hostname.endsWith(".spotify.com")) ||
    url.search || url.hash || url.pathname !== "/")
    fail("INVALID_ENDPOINT", "Endpoint must be a Spotify HTTPS or secure WebSocket host on port 443.");
  return url.origin;
}
export async function resolveConnectEndpoints(request) {
  const data = await request("https://apresolve.spotify.com/", { query: { type: ["dealer", "spclient"] } });
  const dealer = data?.dealer?.[0] ?? data?.["dealer-g2"]?.[0], webgate = data?.spclient?.[0];
  return {
    dealer: spotifyEndpoint(`wss://${dealer || "dealer.g2.spotify.com"}`, "wss:"),
    webgate: spotifyEndpoint(`https://${webgate || "spclient.wg.spotify.com"}`, "https:"),
  };
}
function aliasTarget(id) {
  if (typeof id !== "string" || !id || id.length > 256) fail("NO_DEVICE", "No active Spotify Connect device. Choose a speaker with transfer first.");
  const parts = id.split("::a_");
  if (parts.length > 2 || (parts[1] !== undefined && !/^\d+$/.test(parts[1]))) fail("INVALID_ARGUMENT", "Invalid Connect device alias.");
  return { id: parts[0], ...(parts[1] !== undefined ? { aliasId: Number(parts[1]) } : {}) };
}
function imageUrl(value) {
  if (typeof value !== "string") return null;
  if (/^spotify:image:[a-fA-F0-9]+$/.test(value)) return `https://i.scdn.co/image/${value.slice(14)}`;
  return /^https:\/\//.test(value) ? value : null;
}
const isQueued = (track) => track?.metadata?.is_queued === "true";
const queueIdentity = (track) => JSON.stringify([track?.uri, track?.uid, track?.metadata?.iteration ?? null]);
const isQueueMeta = (track) => track?.uri === "spotify:delimiter" || track?.uri?.startsWith("spotify:meta:");
const visibleQueueTrack = (track) => !!track?.uri && !isQueueMeta(track) &&
  track.metadata?.hidden !== "true" && track.metadata?.hidden_in_queue !== "true" && !track.removed?.length;
function visibleQueueIndexes(state, rows = state?.next_tracks ?? []) {
  let passedMeta = false;
  return rows.flatMap((row, index) => {
    if (isQueueMeta(row)) { passedMeta = true; return []; }
    if (passedMeta && !state?.options?.repeating_context) return [];
    return visibleQueueTrack(row) ? [index] : [];
  });
}
function queueResult(cluster, limit = 20) {
  const state = cluster?.player_state;
  const rows = visibleQueueIndexes(state).map((index) => state.next_tracks[index]);
  return { current: normalizeConnectTrack(cluster?.player_state?.track),
    queued: rows.filter(isQueued).map(normalizeConnectTrack),
    nextUp: rows.filter((track) => !isQueued(track)).slice(0, limit).map(normalizeConnectTrack) };
}

export function normalizeConnectTrack(track) {
  if (!track?.uri) return null;
  const meta = track.metadata ?? {};
  const artists = Object.keys(meta).filter((key) => /^artist_name(?::\d+)?$/.test(key))
    .sort((a, b) => finite(a.split(":")[1]) - finite(b.split(":")[1])).map((key) => meta[key]).filter(Boolean);
  return {
    uri: track.uri, type: track.uri.split(":")[1] ?? null,
    name: meta.title ?? track.name ?? null,
    artists, album: meta.album_title ?? null,
    durationMs: finite(meta.duration ?? meta.duration_ms, null),
    uid: track.uid ?? null, provider: track.provider ?? null,
    isPlayable: null,
    ...(imageUrl(meta.image_xlarge_url ?? meta.image_large_url ?? meta.image_url)
      ? { imageUrl: imageUrl(meta.image_xlarge_url ?? meta.image_large_url ?? meta.image_url) } : {}),
  };
}
export function normalizeConnectDevices(cluster) {
  return Object.entries(cluster?.devices ?? {}).flatMap(([key, raw]) => {
    const d = raw.device_info ?? raw, capabilities = d.capabilities ?? {}, id = d.device_id ?? key;
    if (capabilities.hidden || capabilities.can_be_player === false) return [];
    const base = { id, name: d.name ?? null, type: (d.device_type ?? "unknown").toLowerCase(),
      active: id === cluster.active_device_id, local: false,
      available: capabilities.is_controllable !== false && d.can_play !== false,
      volume: capabilities.disable_volume ? null : Math.round(Math.max(0, Math.min(65535, finite(d.volume))) / 65535 * 100),
      supportsVolume: !capabilities.disable_volume };
    const aliases = d.device_aliases;
    if (!aliases || !Object.keys(aliases).length) return [base];
    return Object.values(aliases).filter(Boolean).map((alias) => ({ ...base,
      id: `${id}::a_${alias.id}`, name: alias.display_name ?? base.name,
      active: base.active && finite(d.selected_alias_id, -1) === finite(alias.id, -2),
    }));
  });
}
export function normalizeConnectStatus(cluster, receivedAt = Date.now(), username = null) {
  const devices = normalizeConnectDevices(cluster), device = devices.find((d) => d.active), state = cluster?.player_state,
    track = normalizeConnectTrack(state?.track), duration = finite(state?.duration, track?.durationMs ?? 0),
    paused = !device || !!state?.is_paused, restriction = state?.restrictions ?? {};
  const disallowed = (key) => !!restriction[`disallow_${key}_reasons`]?.length;
  const serverElapsed = Math.max(0, finite(cluster?.server_timestamp_ms ?? cluster?.timestamp, finite(state?.timestamp)) - finite(state?.timestamp)),
    localElapsed = Math.max(0, Date.now() - receivedAt), speed = finite(state?.playback_speed, 1);
  const position = finite(state?.position_as_of_timestamp ?? state?.position) + (paused ? 0 : (serverElapsed + localElapsed) * speed);
  return {
    connected: true, username, state: !track ? "stopped" : paused ? "paused" : "playing",
    track, context: state?.context_uri ?? null,
    positionMs: track ? Math.round(Math.max(0, Math.min(duration || Infinity, position))) : 0,
    durationMs: duration, shuffle: !!state?.options?.shuffling_context,
    smartShuffle: state?.options?.modes?.smart_shuffle ?? null,
    repeat: state?.options?.repeating_track ? "track" : state?.options?.repeating_context ? "context" : "off",
    volume: device?.volume ?? null, device: device?.name ?? null, deviceId: device?.id ?? null,
    restrictions: { canPause: !disallowed("pausing"), canResume: !disallowed("resuming"),
      canSeek: !disallowed("seeking"), canSkipNext: !disallowed("skipping_next"), canSkipPrevious: !disallowed("skipping_prev") },
  };
}

export class ConnectController {
  constructor(request, options = {}) {
    if (typeof request !== "function" || typeof options.getAccessToken !== "function") throw new TypeError("Connect requires an HTTP request helper and getAccessToken callback.");
    this.request = request; this.options = options;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    if (!this.WebSocket) fail("UNSUPPORTED", "This Node.js version does not provide WebSocket. Use Node.js 22.19 or newer.");
    this.id = options.controllerId ?? randomBytes(16).toString("hex");
    if (!/^[A-Za-z0-9_-]{1,35}$/.test(this.id)) fail("INVALID_ARGUMENT", "Controller ID must contain 1 to 35 letters, digits, underscores or hyphens.");
    this.observerId = `hobs_${this.id}`;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.cluster = null; this.receivedAt = 0; this.closed = false; this.registered = false;
    this.waiters = new Set(); this.sequence = Promise.resolve();
  }
  async start() {
    if (this.started) return this.started;
    this.started = this._start();
    return this.started;
  }
  async _start() {
    const endpoints = this.options.resolveEndpoints ? await this.options.resolveEndpoints() : await resolveConnectEndpoints(this.request);
    this.dealerEndpoint = spotifyEndpoint(endpoints.dealer, "wss:");
    this.webgate = spotifyEndpoint(endpoints.webgate, "https:");
    const token = await this.options.getAccessToken();
    if (typeof token !== "string" || !token || /[\r\n]/.test(token)) fail("AUTH_REQUIRED", "Spotify returned no usable access token.");
    const url = new URL(this.dealerEndpoint); url.searchParams.set("access_token", token);
    const connectionId = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(error("CONNECT_TIMEOUT", "Spotify's event service did not provide a connection ID.")), this.timeoutMs);
      this.rejectConnection = (reason) => { clearTimeout(timeout); reject(reason); };
      this.resolveConnection = (id) => { clearTimeout(timeout); resolve(id); };
      let socket;
      try { socket = this.socket = new this.WebSocket(url.href); }
      catch { clearTimeout(timeout); reject(error("CONNECT_FAILED", "Could not open Spotify's event service.")); return; }
      socket.addEventListener("message", (event) => {
        this._message(event.data).catch(() => this._fatal(error("INVALID_RESPONSE", "Spotify returned an invalid event message.")));
      });
      socket.addEventListener("error", () => this._fatal(error("CONNECT_FAILED", "Spotify's event connection failed.")));
      socket.addEventListener("close", () => { if (!this.closed) this._fatal(error("CONNECT_DISCONNECTED", "Spotify's event connection closed. Refresh before retrying an action.")); });
    });
    if (this.closed || this.fatal) throw this.fatal ?? error("CONNECT_CLOSED", "Connect controller is closed.");
    const cluster = await this._http(`/v1/devices/${this.observerId}`, { method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Spotify-Connection-Id": connectionId },
      body: { member_type: "CONNECT_STATE", device: { device_info: { capabilities: { can_be_player: false, hidden: true, needs_full_player_state: true } } } },
    });
    this.registered = true;
    this._setCluster(cluster?.cluster ?? cluster);
    if (!this.cluster) await this.refresh();
    return this;
  }
  _http(path, options = {}) {
    return this.request(`${this.webgate}/connect-state${path}`, options);
  }
  _setCluster(cluster) {
    if (!cluster || typeof cluster !== "object" || (!cluster.devices && !cluster.player_state)) return;
    const time = finite(cluster.timestamp);
    if (this.cluster && time && time < finite(this.cluster.timestamp)) return;
    this.cluster = cluster; this.receivedAt = Date.now();
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  async _message(data) {
    if (this.closed) return;
    let text;
    if (typeof data === "string") text = data;
    else if (data?.text) text = await data.text();
    else text = Buffer.from(data).toString("utf8");
    if (text.length > 4 * 1024 * 1024) throw error("INVALID_RESPONSE", "Spotify event exceeded the supported size.");
    const message = JSON.parse(text);
    if (message.type === "pong") { clearTimeout(this.pongTimeout); this.pongTimeout = null; return; }
    if (message.type !== "message") return;
    const match = message.uri?.match(/^hm:\/\/pusher\/(?:[^]+)?\/connections\/([^]+)/);
    if (match && !this.connectionId) {
      this.connectionId = message.headers?.["Spotify-Connection-Id"] ?? decodeURIComponent(match[1]);
      this.resolveConnection?.(this.connectionId);
      this._ping();
      this.heartbeat = setInterval(() => this._ping(), 30000); this.heartbeat.unref?.();
    }
    if (/\/connect-state\/v1\/cluster$/.test(message.uri ?? "")) {
      for (const payload of message.payloads ?? []) {
        const body = typeof payload === "string" ? JSON.parse(payload) : payload;
        this._setCluster(body?.cluster ?? body);
      }
    }
  }
  _ping() {
    if (this.closed || !this.socket || this.socket.readyState !== 1) return;
    if (this.pongTimeout) { this._fatal(error("CONNECT_TIMEOUT", "Spotify event heartbeat timed out.")); return; }
    this.pongTimeout = setTimeout(() => this._fatal(error("CONNECT_TIMEOUT", "Spotify event heartbeat timed out.")), 10000);
    this.pongTimeout.unref?.();
    this.socket.send('{"type":"ping"}');
  }
  _fatal(reason) {
    if (this.fatal) return;
    this.fatal = reason;
    this.rejectConnection?.(reason);
    for (const resolve of this.waiters) resolve(); this.waiters.clear();
    clearInterval(this.heartbeat); clearTimeout(this.pongTimeout);
    try { this.socket?.close(); } catch { /* Do not surface WebSocket URLs containing a token. */ }
  }
  async refresh() {
    if (this.fatal) throw this.fatal;
    const cluster = await this._http("/v1/cluster", { headers: { Accept: "application/json" } });
    this._setCluster(cluster?.cluster ?? cluster);
    if (!this.cluster) fail("INVALID_RESPONSE", "Spotify returned no Connect cluster.");
    return this.status();
  }
  status() { return normalizeConnectStatus(this.cluster, this.receivedAt, this.options.username ?? null); }
  devices() { return normalizeConnectDevices(this.cluster); }
  async _confirm(predicate, message) {
    const deadline = Date.now() + Math.min(this.timeoutMs, 5000);
    while (true) {
      if (this.fatal) throw this.fatal;
      const observed = this.status();
      if (predicate(observed)) return observed;
      if (Date.now() >= deadline) fail("STATE_NOT_CONFIRMED", message, { observed });
      // Commands are never replayed. Refresh only the state if a push did not arrive.
      await Promise.race([sleep(300), new Promise((resolve) => {
        this.waiters.add(resolve); setTimeout(() => { this.waiters.delete(resolve); resolve(); }, 300).unref?.();
      })]);
      if (predicate(this.status())) return this.status();
      await this.refresh();
    }
  }
  _target(input) {
    const selected = input ?? this.devices().find((d) => d.active)?.id;
    return aliasTarget(selected);
  }
  async _player(endpoint, values = {}, input) {
    const target = this._target(input), commandId = randomBytes(16).toString("hex");
    const body = { command: { ...values, endpoint,
      logging_params: { ...values.logging_params, command_id: commandId } },
      ...(target.aliasId !== undefined ? { target_alias_id: target.aliasId } : {}) };
    return this._http(`/v1/player/command/from/${encodeURIComponent(this.id)}/to/${encodeURIComponent(target.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  }
  async _connect(endpoint, values = {}, input) {
    const target = this._target(input), body = { ...values };
    // SetVolumeCommand has no command_id field. The shipped client creates a
    // separate local tracking ID without putting it into this strict JSON body.
    if (endpoint === "transfer") body.command_id = randomBytes(16).toString("hex");
    if (target.aliasId !== undefined) {
      if (endpoint === "volume" || endpoint === "logout") body.command_options = { target_alias_id: target.aliasId };
      else body.target_alias_id = target.aliasId;
    }
    return this._http(`/v1/connect/${endpoint}/from/${encodeURIComponent(this.id)}/to/${encodeURIComponent(target.id)}`, { method: endpoint === "volume" ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body });
  }
  execute(name, args = {}) {
    const result = this.sequence.then(() => this._execute(name, args));
    this.sequence = result.catch(() => {});
    return result;
  }
  async _execute(name, args) {
    if (!["status", "devices", "play", "pause", "resume", "toggle", "next", "previous", "seek", "volume", "shuffle", "repeat", "transfer", "queue", "queue-add", "queue-remove", "queue-move", "queue-clear"].includes(name))
      fail("UNSUPPORTED", `${name} is unavailable in the standalone Connect controller. It will not launch the desktop app.`);
    await this.start();
    if (this.fatal) throw this.fatal;
    if (this.closed) fail("CONNECT_CLOSED", "Connect controller is closed.");
    switch (name) {
      case "status": return this.status();
      case "devices": return this.devices();
      case "play": {
        if (args.query) fail("UNSUPPORTED", "Resolve a search result to a URI before Connect playback.");
        if (args.uri === undefined && args.context === undefined) {
          if (args.index !== undefined) fail("INVALID_ARGUMENT", "A playback URI or context is required for a track index.");
          await this._player("resume");
          return this._confirm((s) => s.state === "playing", "Resume was requested but not confirmed.");
        }
        const playbackUri = (value) => {
          if (value !== "liked") return spotifyUri(value);
          if (!this.options.username) fail("AUTH_PROFILE_REQUIRED", "Playing liked songs requires the account username from the saved login.");
          return `spotify:user:${encodeURIComponent(this.options.username)}:collection`;
        };
        const selected = args.uri ? playbackUri(args.uri) : null;
        const context = args.context ? playbackUri(args.context) : selected;
        if (!context) fail("INVALID_ARGUMENT", "A playback URI is required.");
        const options = { license: "", player_options_override: {} };
        if (args.index !== undefined) {
          if (!Number.isInteger(args.index) || args.index < 0) fail("INVALID_ARGUMENT", "Track index must be a nonnegative integer.");
          options.skip_to = { track_index: args.index };
        } else if (args.context && selected) options.skip_to = { track_uri: selected };
        await this._player("play", { context: { uri: context, url: `context://${context}`, metadata: {} },
          play_origin: { feature_identifier: "rea-spotify-cli", feature_version: "1.0.0" }, options });
        return this._confirm((s) => s.state === "playing" && (/^spotify:(track|episode):/.test(selected ?? "") ? s.track?.uri === selected : s.context === context), "Playback was requested but not confirmed.");
      }
      case "pause": case "resume": case "toggle": {
        const before = this.status(), pause = name === "pause" || (name === "toggle" && before.state === "playing"), expected = pause ? "paused" : "playing";
        if (before.state !== expected) await this._player(pause ? "pause" : "resume");
        return this._confirm((s) => s.state === expected, "Playback state was not confirmed.");
      }
      case "next": case "previous": {
        const before = this.status();
        await this._player(name === "next" ? "skip_next" : "skip_prev");
        return this._confirm((s) => !!s.track && (s.track.uid !== before.track?.uid || s.track.uri !== before.track?.uri || (before.positionMs >= 2000 && s.positionMs < 2000)), "Track transition was not confirmed.");
      }
      case "seek": {
        const before = this.status(), position = Math.round(args.seconds * 1000);
        if (!before.track) fail("NOT_PLAYING", "No current track to seek.");
        if (args["track-uri"] !== undefined && spotifyUri(args["track-uri"]) !== before.track.uri) fail("STALE_TRACK", "Playback moved to another track. Refresh before seeking.");
        if (!Number.isFinite(position) || position < 0 || position > before.durationMs) fail("INVALID_ARGUMENT", "Seek position is outside the current track.");
        await this._player("seek_to", { value: position });
        return this._confirm((s) => s.track?.uri === before.track.uri && Math.abs(s.positionMs - position) < 1500, "Seek position was not confirmed.");
      }
      case "volume": {
        if (args.percent === undefined) return { percent: this.status().volume };
        if (!Number.isFinite(args.percent) || args.percent < 0 || args.percent > 100) fail("INVALID_ARGUMENT", "Volume must be between 0 and 100.");
        if (this.devices().find((d) => d.active)?.supportsVolume === false) fail("UNSUPPORTED", "This Connect device does not support remote volume.");
        await this._connect("volume", { volume: Math.round(65535 * args.percent / 100) });
        const status = await this._confirm((s) => s.volume !== null && Math.abs(s.volume - args.percent) <= 1, "Volume was requested but not confirmed.");
        return { percent: status.volume };
      }
      case "shuffle": case "repeat": {
        if (args.mode === undefined) return this.status();
        if (!(name === "shuffle" ? ["on", "off"] : ["off", "context", "track"]).includes(args.mode)) fail("INVALID_ARGUMENT", "Invalid playback option.");
        if (name === "shuffle") await this._player("set_shuffling_context", { value: args.mode === "on" });
        else await this._player("set_options", { repeating_context: args.mode === "context", repeating_track: args.mode === "track" });
        return this._confirm((s) => name === "shuffle" ? s.shuffle === (args.mode === "on") : s.repeat === args.mode, "Playback option was not confirmed.");
      }
      case "transfer": {
        const matches = this.devices().filter((d) => d.id === args.device || d.name === args.device);
        if (matches.length !== 1) fail("NOT_FOUND", "Specify an exact device ID or unique device name from devices.");
        if (!matches[0].available) fail("UNAVAILABLE", "Selected Connect device cannot be controlled.");
        await this._connect("transfer", { transfer_options: { restore_paused: "restore" } }, matches[0].id);
        return this._confirm((s) => s.deviceId === matches[0].id, "Device transfer was not confirmed.");
      }
      case "queue": return queueResult(this.cluster, args.limit ?? 20);
      case "queue-remove": case "queue-move": case "queue-clear": {
        const state = this.cluster?.player_state;
        if (!state?.track || !Array.isArray(state.next_tracks) || !Array.isArray(state.prev_tracks) ||
          typeof state.queue_revision !== "string" || !state.queue_revision)
          fail("UNSUPPORTED", "Spotify did not provide a full revisioned queue snapshot. Queue editing is unavailable.");
        if (state.restrictions?.disallow_set_queue_reasons?.length)
          fail("UNAVAILABLE", "The active Spotify player does not permit queue editing.");
        // Keep raw records, including context rows, delimiters, hidden entries,
        // previous tracks and metadata. Normalized/display-limited data must
        // never be sent back as an authoritative replacement queue.
        const next = structuredClone(state.next_tracks), previous = structuredClone(state.prev_tracks),
          currentIdentity = queueIdentity(state.track);
        let expected;
        if (name === "queue-clear") expected = next.filter((row) => !isQueued(row));
        else {
          const matches = next.map((row, index) => ({ row, index })).filter(({ row }) => row.uid === args.uid);
          if (matches.length === 0) fail("NOT_FOUND", "Queue UID not found. Read the current queue before editing.");
          if (matches.length > 1) fail("AMBIGUOUS_QUEUE_ITEM", "This UID occurs in multiple queue iterations. Refresh before editing.");
          const selected = matches[0];
          if (name === "queue-remove") { expected = next; expected.splice(selected.index, 1); }
          else {
            const slots = visibleQueueIndexes(state, next).filter((index) => isQueued(next[index])),
              from = slots.indexOf(selected.index);
            if (from === -1) fail("INVALID_ARGUMENT", "Only explicit queued tracks can be reordered.");
            if (!Number.isInteger(args.index) || args.index < 0 || args.index >= slots.length)
              fail("INVALID_ARGUMENT", "Target index is outside the explicit queue.");
            const ordered = slots.map((index) => next[index]), [moved] = ordered.splice(from, 1);
            ordered.splice(args.index, 0, moved);
            expected = next; slots.forEach((index, offset) => { expected[index] = ordered[offset]; });
          }
        }
        const expectedIds = expected.map(queueIdentity), unchanged = expectedIds.length === state.next_tracks.length && expectedIds.every((id, index) => id === queueIdentity(state.next_tracks[index]));
        if (!unchanged) {
          await this._player("set_queue", { next_tracks: expected, prev_tracks: previous, queue_revision: state.queue_revision });
          await this._confirm(() => {
            const observed = this.cluster?.player_state;
            if (queueIdentity(observed?.track) !== currentIdentity) return false;
            const actual = observed?.next_tracks ?? [];
            // Context continuation may append newly resolved rows after the
            // preserved snapshot. Every existing surviving row must stay in order.
            if (actual.length < expectedIds.length || !expectedIds.every((id, index) => id === queueIdentity(actual[index]))) return false;
            if (name === "queue-clear") return !actual.some(isQueued);
            if (name === "queue-remove") return !actual.some((row) => row.uid === args.uid);
            const queued = visibleQueueIndexes(observed, actual).map((index) => actual[index]).filter(isQueued);
            return queued[args.index]?.uid === args.uid;
          }, "Queue change was requested but not confirmed. Refresh before attempting another edit.");
        }
        return { queued: queueResult(this.cluster).queued };
      }
      case "queue-add": {
        const uris = spotifyUris(args.uris);
        if (!uris.length || uris.some((uri) => !/^spotify:(track|episode):/.test(uri))) fail("INVALID_ARGUMENT", "Only tracks and episodes can be queued.");
        const count = () => (this.cluster?.player_state?.next_tracks ?? []).reduce((counts, track) => {
          if (isQueued(track)) counts[track.uri] = (counts[track.uri] ?? 0) + 1;
          return counts;
        }, {});
        const before = count(), expected = {};
        for (const uri of uris) expected[uri] = (expected[uri] ?? 0) + 1;
        const added = [];
        for (const uri of uris) {
          try { await this._player("add_to_queue", { track: { uri, metadata: { is_queued: "true" }, provider: "queue" } }); added.push(uri); }
          catch (error) { error.details = { ...error.details, added, uncertainUri: uri }; throw error; }
        }
        await this._confirm(() => {
          const after = count();
          return Object.entries(expected).every(([uri, n]) => (after[uri] ?? 0) >= (before[uri] ?? 0) + n);
        }, "Queue additions were requested but not confirmed.");
        return { added, queued: queueResult(this.cluster).queued };
      }
      default: fail("UNSUPPORTED", `${name} is unavailable in the standalone Connect controller. It will not launch Spotify's desktop app.`);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.heartbeat); clearTimeout(this.pongTimeout);
    this.rejectConnection?.(error("CONNECT_CLOSED", "Connect controller is closed."));
    for (const resolve of this.waiters) resolve(); this.waiters.clear();
    if (this.registered) {
      try { await this._http(`/v1/devices/${this.observerId}`, { method: "DELETE" }); }
      catch { /* A disappearing hidden observer must not mask the playback result. */ }
    }
    try { this.socket?.close(1000, "controller complete"); } catch { /* No credentials in errors. */ }
  }
}
export function createConnectController(request, options) { return new ConnectController(request, options); }
export async function executeConnect(name, args, request, options = {}) {
  // The cluster endpoint supports direct read-only requests: no event connection or
  // observer registration is necessary for short status and device-list commands.
  if (["status", "devices", "queue"].includes(name)) {
    const endpoints = options.resolveEndpoints ? await options.resolveEndpoints() : await resolveConnectEndpoints(request);
    const webgate = spotifyEndpoint(endpoints.webgate, "https:");
    const data = await request(`${webgate}/connect-state/v1/cluster`, { headers: { Accept: "application/json" } });
    const cluster = data?.cluster ?? data;
    if (!cluster || typeof cluster !== "object" || (!cluster.devices && !cluster.player_state)) fail("INVALID_RESPONSE", "Spotify returned no Connect cluster.");
    if (name === "devices") return normalizeConnectDevices(cluster);
    if (name === "status") return normalizeConnectStatus(cluster, Date.now(), options.username ?? null);
    return queueResult(cluster, args?.limit ?? 20);
  }
  const controller = createConnectController(request, options);
  try { return await controller.execute(name, args); }
  finally { await controller.close(); }
}
