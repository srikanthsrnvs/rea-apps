import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toolDefinitions } from '../src/tool-definitions.mjs';

const bin = fileURLToPath(new URL('../bin/charts', import.meta.url));
test('real CLI keeps stdout JSON-only and refuses browser/password options', () => {
  const tools = spawnSync(process.execPath, [bin, 'tools'], { encoding: 'utf8' });
  assert.equal(tools.status, 0); assert.equal(JSON.parse(tools.stdout).tools.length, toolDefinitions.length);
  for (const args of [['login', '--cdp-url', 'do-not-echo'], ['login', '--password', 'do-not-echo'], ['candles', '--symbol', 'BTCUSD']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /do-not-echo/);
    assert.equal(JSON.parse(result.stderr).status, 'error');
  }
});

test('real MCP stdio lists tools, reports state and rejects bad input before network access', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'charts-mcp-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const client = new Client({ name: 'charts-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], stderr: 'pipe',
    env: { ...process.env, CHARTS_STATE_DIR: directory } });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools(); assert.equal(tools.length, toolDefinitions.length);
    assert.equal(tools.find(tool => tool.name === 'charts_quotes').annotations.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === 'charts_auth_complete').annotations.readOnlyHint, false);
    const state = await client.callTool({ name: 'charts_state', arguments: {} });
    assert.equal(state.structuredContent.data.authenticated, false);
    assert.equal(state.structuredContent.data.providers[0].hostBrowser, false);
    const invalid = await client.callTool({ name: 'charts_quotes', arguments: { symbols: ['BTCUSD'] } });
    assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENT');
    const huge = await client.callTool({ name: 'charts_candles', arguments: { symbol: 'X:Y', count: 1000000 } });
    assert.equal(huge.isError, true);
  } finally { await client.close(); }
});
