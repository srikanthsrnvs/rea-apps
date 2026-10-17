import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { catalog } from "../src/catalog.mjs";
import { nativeCommands } from "../src/standalone/capabilities.mjs";

test("real stdio MCP catalog and pre-execution argument rejection", async () => {
  const client = new Client({ name: "spotify-cli-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "mcp"],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, catalog.filter(c => nativeCommands.has(c.name)).length + 1);
    assert.equal(tools.find((t) => t.name === "spotify_login").annotations.readOnlyHint, false);
    assert.equal(
      tools.find((t) => t.name === "spotify_login_status").annotations.readOnlyHint,
      true,
    );
    const pause = tools.find((t) => t.name === "spotify_pause");
    assert.equal(pause.annotations.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === "spotify_search").annotations.readOnlyHint, true);
    assert.equal(
      tools.find((t) => t.name === "spotify_unsave").annotations.destructiveHint,
      true,
    );
    const bad = await client.callTool({ name: "spotify_volume", arguments: { percent: 101 } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /101|maximum|100|validation|outside/i);
  } finally {
    await client.close();
  }
});
