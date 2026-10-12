// Deliberate live acceptance test: changes playback and disposable library data,
// then restores playback options and removes its own saved items.
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { execute } from "../src/client.mjs";
const checks = [];
const invoke = async (name, args = {}) => {
  const started = Date.now();
  try {
    const result = await execute(name, args);
    checks.push({ command: name, args, ok: true, durationMs: Date.now() - started });
    console.log(`${name}: OK`);
    return result;
  } catch (error) {
    checks.push({ command: name, args, ok: false, code: error.code, message: error.message });
    throw error;
  }
};
const original = await invoke("status");
const queue = await invoke("queue");
let created,
  savedTrack,
  playbackChanged = false,
  completed = false;
const cleanup = [];
try {
  const found = await invoke("search", { query: "Daft Punk", type: "track", limit: 3 });
  assert.ok(found.tracks.items.length >= 2);
  const first = found.tracks.items[0].uri,
    second = found.tracks.items[1].uri;
  await invoke("library", { limit: 2 });
  await invoke("liked", { limit: 2 });
  await invoke("playlists");
  await invoke("devices");
  await invoke("history", { limit: 2 });
  await invoke("recent");
  const settings = await invoke("settings");
  const key = Object.keys(settings).find((k) => k === "playback.autoMix" && settings[k].supported);
  if (key) {
    await invoke("setting", { key, value: !settings[key].value });
    await invoke("setting", { key, value: settings[key].value });
  }
  try {
    created = await invoke("playlist-create", {
      name: `Spotify CLI verification ${Date.now()}`,
      description: "Disposable CLI acceptance test",
    });
  } catch (error) {
    if (error.details?.createdUri) created = { uri: error.details.createdUri };
    throw error;
  }
  assert.equal(created.published, false);
  const permission = await invoke("api-call", {
    api: "PlaylistPermissionsAPI",
    method: "getBasePermission",
    arguments: [created.uri],
  });
  assert.equal(permission, "BLOCKED");
  await invoke("playlist-add", { uri: created.uri, uris: `${first},${second},${first}` });
  let contents = await invoke("playlist", { uri: created.uri });
  assert.equal(contents.total, 3);
  const movedUid = contents.items[0].uid;
  await invoke("playlist-move", { uri: created.uri, uid: movedUid, index: 2 });
  contents = await invoke("playlist", { uri: created.uri });
  assert.equal(contents.items[2].uid, movedUid);
  await invoke("playlist-remove", { uri: created.uri, uid: movedUid });
  contents = await invoke("playlist", { uri: created.uri });
  assert.equal(contents.total, 2);
  const changed = await invoke("playlist-update", {
    uri: created.uri,
    name: created.name + " updated",
    description: "",
  });
  assert.equal(changed.description, "");
  await invoke("playlist-unfollow", { uri: created.uri });
  assert.deepEqual(
    (await invoke("contains", { uris: created.uri })).map((i) => i.saved),
    [false],
  );
  await invoke("playlist-follow", { uri: created.uri });
  assert.deepEqual(
    (await invoke("contains", { uris: created.uri })).map((i) => i.saved),
    [true],
  );
  // Find an unsaved result so existing likes remain untouched.
  const statuses = await invoke("contains", {
    uris: found.tracks.items.map((i) => i.uri).join(","),
  });
  savedTrack = statuses.find((i) => !i.saved)?.uri;
  if (savedTrack) {
    await invoke("save", { uris: savedTrack });
    await invoke("unsave", { uris: savedTrack });
    savedTrack = null;
  }
  playbackChanged = true;
  await invoke("pause");
  if (original.volume !== null) {
    await invoke("volume", { percent: Math.max(0, original.volume - 1) });
    await invoke("volume", { percent: original.volume });
  }
  await invoke("shuffle", { mode: original.shuffle ? "off" : "on" });
  await invoke("shuffle", { mode: original.shuffle ? "on" : "off" });
  await invoke("repeat", { mode: "track" });
  await invoke("repeat", { mode: original.repeat });
  if (queue.queued.length === 0) {
    let q = await invoke("queue-add", { uris: `${first},${second}` });
    await invoke("queue-move", { uid: q.queued[0].uid, index: 1 });
    q = await invoke("queue");
    assert.equal(q.queued[1].uri, first);
    await invoke("queue-remove", { uid: q.queued[0].uid });
    await invoke("queue-clear");
  } else
    checks.push({ command: "queue-mutations", skipped: "Existing explicit queue is preserved." });
  await invoke("play", { uri: first });
  await invoke("pause");
  const seek = await invoke("seek", { seconds: 5 });
  assert.ok(Math.abs(seek.positionMs - 5000) < 1500);
  await invoke("resume");
  await invoke("toggle");
  await invoke("toggle");
  await invoke("play", { uri: created.uri, index: 0 });
  await invoke("next");
  await invoke("previous");
  await invoke("pause");
  await invoke("transfer", { device: "local_device" });
  if (original.deviceId && original.deviceId !== "local_device")
    await invoke("transfer", { device: original.deviceId });
  await invoke("open", { uri: created.uri });
  await invoke("queries", { route: "album" });
  await invoke("apis");
  completed = true;
} finally {
  const restore = async (name, args) => {
    try {
      await execute(name, args);
      cleanup.push({ command: name, ok: true });
    } catch (error) {
      cleanup.push({ command: name, ok: false, message: error.message });
      console.error(`Restore ${name}: ${error.message}`);
    }
  };
  if (savedTrack) await restore("unsave", { uris: savedTrack });
  if (created) await restore("playlist-unfollow", { uri: created.uri });
  if (original.track && playbackChanged) {
    await restore("shuffle", { mode: original.shuffle ? "on" : "off" });
    await restore("repeat", { mode: original.repeat });
    if (original.deviceId) await restore("transfer", { device: original.deviceId });
    await restore("play", {
      uri: original.track.uri,
      ...(original.context ? { context: original.context } : {}),
    });
    await restore("seek", {
      seconds: Math.min(original.positionMs / 1000, original.durationMs / 1000),
    });
    if (original.state === "paused") await restore("pause", {});
    if (original.volume !== null) await restore("volume", { percent: original.volume });
  }
  await mkdir("analysis", { recursive: true });
  await writeFile(
    "analysis/cli-live-verification.json",
    JSON.stringify(
      {
        completed,
        verifiedAt: new Date().toISOString(),
        checks,
        cleanup,
        original,
        final: await execute("status"),
      },
      null,
      2,
    ) + "\n",
  );
}
assert.ok(completed, "Live verification did not finish.");
assert.ok(
  cleanup.every((c) => c.ok),
  "One or more restoration steps failed.",
);
