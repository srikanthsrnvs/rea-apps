import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toolDefinitions } from './tool-definitions.mjs';
import { createCharts } from './service.mjs';
import { publicError } from './errors.mjs';

export function createMcpServer({ service = createCharts() } = {}) {
  const server = new McpServer({ name: 'charts', version: '0.1.0' });
  for (const tool of toolDefinitions) server.registerTool(tool.name, {
    description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema),
    annotations: { readOnlyHint: tool.effect === 'read', destructiveHint: tool.effect === 'local',
      idempotentHint: tool.effect === 'read', openWorldHint: tool.online || tool.effect === 'auth' },
  }, async (args, context) => {
    let output;
    try { output = await service.execute(tool.name, args, { signal: context?.signal }); }
    catch (error) { const detail = publicError(error, context?.signal); output = { status: 'error', message: detail.message, error: detail }; }
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output, isError: output.status === 'error' };
  });
  return server;
}

export async function serveMcp() {
  const server = createMcpServer();
  const stop = () => { void server.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await server.connect(new StdioServerTransport());
}
