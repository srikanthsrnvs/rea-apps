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

test('MCP keeps complete plot rows for renderers and compact summaries for the model', async () => {
  const script=`
    import {createMcpServer} from ${JSON.stringify(new URL('../src/mcp.mjs',import.meta.url).href)};
    import {createCharts} from ${JSON.stringify(new URL('../src/service.mjs',import.meta.url).href)};
    import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
    const service=createCharts({store:{load:async()=>null},sdk:{getCandles:async()=>[
      {time:1,open:100,high:100,low:100,close:100},
      {time:2,open:110,high:110,low:110,close:110}
    ]}});
    await createMcpServer({service}).connect(new StdioServerTransport());
  `;
  const client=new Client({name:'charts-render-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval',script],cwd:fileURLToPath(new URL('..',import.meta.url)),stderr:'pipe'});
  try {
    await client.connect(transport);
    const result=await client.callTool({name:'charts_compare',arguments:{symbols:['X:A','X:B'],'include-data':true,count:2}});
    assert.equal(result.isError,false);
    assert.deepEqual(result.structuredContent.data.chart.rows,[[1,0,0],[2,10,10]]);
    const text=JSON.parse(result.content[0].text);
    assert.equal(text.data.chart.rows,undefined);
    assert.equal(text.data.series[0].changePercent,10);
    assert.equal(text.data.chart.fullDataLocation,'structuredContent.data.chart');
  } finally {await client.close();}
});
