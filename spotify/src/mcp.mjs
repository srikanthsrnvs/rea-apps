import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { catalog } from "./catalog.mjs";
import { execute } from "./client.mjs";
import { connectSpotify } from "./lifecycle.mjs";
import { PLAYER_URI, PLAYER_MIME, playerCommands, playerToolMeta, playerResource, playbackResult } from "./player.mjs";
import { backendName, nativeCommands } from "./standalone/capabilities.mjs";

export function createMcpServer(options = {}, { run = execute, connect = connectSpotify } = {}) {
  const server = new McpServer({ name: "spotify-desktop", version: "0.2.0" });
  server.registerResource("spotify-player", PLAYER_URI,
    { mimeType: PLAYER_MIME, description: "Prebuilt Spotify playback controls" },
    async () => ({ contents: [await playerResource()] }));
  const register = (name, description, inputSchema, effect, handler) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: fromJsonSchema(inputSchema),
        ...(playerCommands.has(name.replace(/^spotify_/, "").replaceAll("_", "-"))
          ? { _meta: playerToolMeta } : {}),
        annotations: {
          readOnlyHint: effect === "read",
          destructiveHint: effect !== "read" && /remove|unsave|clear|api_call/.test(name),
          openWorldHint: true,
        },
      },
      async (args) => {
        let output;
        try {
          output = playbackResult(name.replace(/^spotify_/, "").replaceAll("_", "-"), await handler(args));
        } catch (error) {
          output = {
            ok: false,
            error: {
              code: error.code ?? "INTERNAL_ERROR",
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            },
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
          isError: !output.ok,
          ...(output.component ? { _meta: playerToolMeta } : {}),
        };
      },
    );
  };
  register(
    "spotify_connect",
    "Inspect the standalone Spotify connection. No browser or desktop application is started. If logged out, use spotify_login and approve its Spotify pairing URL.",
    {
      type: "object",
      properties: { restart: { type: "boolean", default: false } },
      additionalProperties: false,
    },
    "write",
    (args) => connect({ ...options, restart: args.restart ?? false }),
  );
  for (const command of catalog)
    if (backendName() === "desktop" ? command.name !== "logout" : nativeCommands.has(command.name))
    register(
      `spotify_${command.name.replaceAll("-", "_")}`,
      command.description,
      command.inputSchema,
      command.effect,
      (args) => run(command.name, args, options),
    );
  return server;
}

export async function serveMcp(options = {}) {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}
