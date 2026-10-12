import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spotifyRuntime } from "../src/runtime.mjs";

function runtime(services, extra = {}) {
  const map = new Map(Object.entries(services).map(([name, value]) => [Symbol(name), value]));
  const platform = {
    getRegistry: () => ({ _map: map, resolve: (key) => map.get(key) }),
    getPlatformData: () => ({}),
  };
  const fiber = { memoizedProps: { platform }, child: null, sibling: null };
  const main = { __reactContainer_test: { stateNode: { current: fiber } } };
  const context = vm.createContext({
    document: { getElementById: () => main },
    window: {},
    setTimeout: (resolve) => setTimeout(resolve, 0),
    ...extra,
  });
  return async (operation, args = {}) =>
    JSON.parse(
      JSON.stringify(
        await vm.runInContext(
          `(${spotifyRuntime.toString()})(${JSON.stringify(operation)},${JSON.stringify(args)})`,
          context,
        ),
      ),
    );
}

test("queue additions confirm new occurrences when the same song already exists", async () => {
  const uri = "spotify:track:abc";
  let requested = false,
    reads = 0;
  const invoke = runtime({
    PlayerAPI: {
      addToQueue: () => {
        requested = true;
      },
      getQueue: () => ({
        queued: Array.from({ length: requested && ++reads > 1 ? 3 : 1 }, (_, i) => ({
          uri,
          uid: String(i),
        })),
      }),
    },
  });
  const result = await invoke("queue-add", { uris: `${uri},${uri}` });
  assert.equal(result.ok, true);
  assert.equal(result.result.queued.length, 3);
});

test("unsupported volume is not mistaken for confirmed zero volume", async () => {
  let reads = 0;
  const invoke = runtime({
    PlaybackAPI: { setVolume: () => {}, getVolume: () => (++reads === 1 ? -1 : 0) },
  });
  assert.deepEqual(await invoke("volume", { percent: 0 }), { ok: true, result: { percent: 0 } });
  assert.equal(reads, 2);
});

test("a stopped player reports zero position even when its timestamp is zero", async () => {
  const invoke = runtime({
    PlayerAPI: { getState: () => ({ timestamp: 0, positionAsOfTimestamp: 0, duration: 0 }) },
    ConnectDevicesAPI: { getDevices: () => [] },
    PlaybackAPI: { getVolume: () => 1 },
  });
  const response = await invoke("status");
  assert.equal(response.ok, true);
  assert.equal(response.result.state, "stopped");
  assert.equal(response.result.positionMs, 0);
});

test("playlist updates wait for the returned metadata to reflect the change", async () => {
  let reads = 0;
  const invoke = runtime({
    PlaylistAPI: {
      updateDetails: () => {},
      getPlaylist: () => ({
        metadata: { uri: "spotify:playlist:abc", name: ++reads === 1 ? "Old" : "New" },
        contents: { items: [] },
      }),
    },
  });
  const result = await invoke("playlist-update", { uri: "spotify:playlist:abc", name: "New" });
  assert.equal(result.ok, true);
  assert.equal(result.result.name, "New");
  assert.equal(reads, 2);
});

test("query discovery captures both webpack and cold-start Rspack loaders", async () => {
  for (const name of ["webpackChunkclient_web", "rspackChunk", "rspackChunkclient_web"]) {
    const loader = {
      m: {
        1: function () {
          return new Query(
            "example",
            "query",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          );
        },
      },
    };
    // Shipped definitions use double quotes; preserve the source shape explicitly.
    loader.m[1] = { toString: () => 'new Query("example","query","' + "a".repeat(64) + '")' };
    const chunks = [];
    chunks.push = function (chunk) {
      chunk[2](loader);
      return 1;
    };
    const invoke = runtime({}, { window: { [name]: chunks } });
    assert.deepEqual(await invoke("queries"), { ok: true, result: [{ name: "example" }] });
  }
});
