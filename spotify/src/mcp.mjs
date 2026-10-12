import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { catalog } from "./catalog.mjs";
import { execute } from "./client.mjs";
import { connectSpotify } from "./lifecycle.mjs";

export async function serveMcp(options = {}) {
  const server = new McpServer({ name: "spotify-desktop", version: "0.1.0" });
  const register = (name, description, inputSchema, effect, handler) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: fromJsonSchema(inputSchema),
        annotations: {
          readOnlyHint: effect === "read",
          destructiveHint: effect !== "read" && /remove|unsave|clear|api_call/.test(name),
          openWorldHint: true,
        },
      },
      async (args) => {
        let output;
        try {
          output = { ok: true, result: await handler(args) };
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
        };
      },
    );
  };
  register(
    "spotify_connect",
    "Connect or launch Spotify. Headless Linux uses Xvfb and D-Bus. On macOS restart:true enables debugging by restarting the app. If logged out, use spotify_login.",
    {
      type: "object",
      properties: { restart: { type: "boolean", default: false } },
      additionalProperties: false,
    },
    "write",
    (args) => connectSpotify({ ...options, restart: args.restart ?? false }),
  );
  for (const command of catalog)
    register(
      `spotify_${command.name.replaceAll("-", "_")}`,
      command.description,
      command.inputSchema,
      command.effect,
      (args) => execute(command.name, args, options),
    );
  await server.connect(new StdioServerTransport());
}
