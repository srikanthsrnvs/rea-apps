#!/usr/bin/env node
import { catalog, parseCommand, invalid } from "./catalog.mjs";
import { execute } from "./client.mjs";
import { connectSpotify } from "./lifecycle.mjs";

const raw = process.argv.slice(2);
const portIndex = raw.indexOf("--port");
let port = Number(process.env.SPOTIFY_PORT ?? 9222);
if (portIndex !== -1) {
  port = Number(raw[portIndex + 1]);
  raw.splice(portIndex, 2);
}
const print = (value) =>
  process.stdout.write(
    JSON.stringify(value, null, raw.includes("--pretty") ? 2 : undefined) + "\n",
  );
try {
  if (raw.length === 1 && ["--version", "-v"].includes(raw[0])) {
    process.stdout.write("0.1.0\n");
    process.exit(0);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw invalid("Port must be between 1024 and 65535.");
  const parsed = parseCommand(raw);
  if (parsed.name === "help") {
    const selected = parsed.subject ?? parsed.tokens?.[0];
    const entries = selected ? catalog.filter((c) => c.name === selected) : catalog;
    if (selected && !entries.length) throw invalid(`Unknown command: ${selected}`);
    if (raw.includes("--json")) print({ name: "spotify", commands: entries });
    else {
      process.stdout.write("spotify — control your logged-in Spotify desktop app\n\n");
      if (!selected)
        process.stdout.write(
          "  connect [--restart]        Start or reconnect local runtime control\n  tools                      Print the command catalog as JSON\n  mcp                        Serve these commands over MCP stdio\n\n",
        );
      for (const c of entries) {
        process.stdout.write(`  ${c.name.padEnd(22)} ${c.description}\n`);
        if (selected)
          for (const [k, s] of Object.entries(c.inputSchema.properties))
            process.stdout.write(
              `    --${k} (${s.type ?? "JSON"}) ${s.description ?? ""}${s.enum ? " [" + s.enum.join("|") + "]" : ""}${"default" in s ? " default=" + JSON.stringify(s.default) : ""}\n`,
            );
      }
      process.stdout.write(
        '\nAll commands return JSON. Use --pretty for indentation and --port N for another local port.\nMulti-word aliases work: spotify queue add URI; spotify playlist create "Name".\n',
      );
    }
  } else if (parsed.name === "tools") {
    print({ name: "spotify-desktop", version: "0.1.0", commands: catalog });
  } else if (parsed.name === "connect") {
    if (parsed.tokens.some((t) => !["--restart", "--json", "--pretty"].includes(t)))
      throw invalid("Usage: spotify connect [--restart] [--port N]");
    print({
      ok: true,
      result: await connectSpotify({ port, restart: parsed.tokens.includes("--restart") }),
    });
  } else if (parsed.name === "mcp") {
    if (parsed.tokens.length) throw invalid("Usage: spotify mcp [--port N]");
    const { serveMcp } = await import("./mcp.mjs");
    await serveMcp({ port });
  } else {
    print({ ok: true, result: await execute(parsed.name, parsed.args, { port }) });
  }
} catch (error) {
  print({
    ok: false,
    error: {
      code: error.code ?? "INTERNAL_ERROR",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
  process.exitCode = error.code === "INVALID_ARGUMENT" || error.code === "UNKNOWN_COMMAND" ? 2 : 1;
}
