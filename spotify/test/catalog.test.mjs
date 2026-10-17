import test from "node:test";
import assert from "node:assert/strict";
import { catalog, parseCommand, validateArguments } from "../src/catalog.mjs";

test("CLI and tool arguments share defaults and constraints", () => {
  assert.deepEqual(parseCommand(["search", "Daft Punk", "--type=track", "--limit", "3"]).args, {
    query: "Daft Punk",
    type: "track",
    offset: 0,
    limit: 3,
  });
  assert.deepEqual(parseCommand(["queue", "add", "spotify:track:abc"]).args, {
    uris: "spotify:track:abc",
  });
  assert.deepEqual(parseCommand(["setting", "playback.autoMix", "false"]).args, {
    key: "playback.autoMix",
    value: false,
  });
  assert.deepEqual(parseCommand(["query", "name", '{"offset":0}']).args, {
    name: "name",
    variables: { offset: 0 },
  });
});
test("reject malformed, missing and duplicate inputs before app execution", () => {
  for (const args of [
    ["volume", "101"],
    ["seek", "-1"],
    ["seek", "NaN"],
    ["search", "x", "--limit", "1.5"],
    ["search"],
    ["seek", "1", "--seconds", "2"],
    ["search", "x", "--typo", "y"],
    ["setting", "x", "undefined"],
    ["search", "x", "--limit"],
  ])
    assert.throws(
      () => parseCommand(args),
      (e) => e.code === "INVALID_ARGUMENT",
      args.join(" "),
    );
  assert.throws(
    () =>
      validateArguments(
        catalog.find((c) => c.name === "pause"),
        { uri: "x" },
      ),
    (e) => e.code === "INVALID_ARGUMENT",
  );
});
test("zero volume and empty description survive argument parsing", () => {
  assert.equal(parseCommand(["volume", "0"]).args.percent, 0);
  assert.equal(
    parseCommand(["playlist", "update", "spotify:playlist:x", "--description", ""]).args
      .description,
    "",
  );
});

test("discovery and refresh boolean flags share exact CLI/MCP values", () => {
  assert.equal(parseCommand(["discover", "--refresh"]).args.refresh, true);
  assert.equal(parseCommand(["devices", "--network=false"]).args.network, false);
  assert.equal(parseCommand(["devices", "--network", "false", "--refresh", "true"]).args.refresh, true);
  assert.equal(parseCommand(["search", "jazz", "--refresh"]).args.refresh, true);
  assert.throws(() => parseCommand(["devices", "--network=maybe"]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parseCommand(["discover", "--timeout-ms", "6000"]), { code: "INVALID_ARGUMENT" });
});
