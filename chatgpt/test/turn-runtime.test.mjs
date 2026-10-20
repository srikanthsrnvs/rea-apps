import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-turn-test-'));
process.env.CHATGPT_STATE_DIR = root;
const { saveState } = await import('../src/state.mjs');
const { sendTurn } = await import('../src/turns.mjs');
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); });

await saveState('session', { accessToken: 'test-token', deviceId: 'test-device', generation: 'test-generation',
  expiresAt: Date.now() + 3_600_000, account: { id: 'user' } });

test('sending a new chat is verified independently and the same operation is not submitted twice', async () => {
  let writes = 0, reads = 0, submitted;
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('/models')) return Response.json({ default_model_slug: 'test-model' });
    if (endpoint.endsWith('/sentinel/chat-requirements')) return Response.json({ token: 'test-requirements' });
    if (endpoint.endsWith('/f/conversation')) {
      writes++;
      submitted = JSON.parse(options.body);
      assert.equal(new Headers(options.headers).get('OpenAI-Sentinel-Chat-Requirements-Token'), 'test-requirements');
      return new Response('data: {"conversation_id":"chat-1","type":"main_stream_complete"}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    }
    if (endpoint.endsWith('/conversations/chat-1')) {
      reads++;
      return Response.json({ id: 'chat-1', current_node: 'answer', mapping: {
        root: { parent: null },
        request: { parent: 'root', message: submitted.messages[0] },
        answer: { parent: 'request', message: { id: 'answer', author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Hello'] }, end_turn: true, status: 'finished_successfully' } },
      } });
    }
    throw new Error('Unexpected endpoint');
  };
  const args = { operationId: randomUUID(), prompt: 'Hi' };
  const first = await sendTurn(args);
  assert.equal(first.phase, 'complete');
  assert.equal(first.reconciliation.completed, true);
  assert.equal(first.reconciliation.assistant_messages[0].content.parts[0], 'Hello');
  const second = await sendTurn(args);
  assert.equal(second.phase, 'complete');
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test('lost initial response retains an unknown outcome and never resends the prompt', async () => {
  let writes = 0;
  globalThis.fetch = async url => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('/sentinel/chat-requirements')) return Response.json({ token: 'test-requirements' });
    if (endpoint.endsWith('/f/conversation')) { writes++; throw new Error('connection lost'); }
    throw new Error('Unexpected request');
  };
  const args = { operationId: randomUUID(), prompt: 'Hi', model: 'test-model' };
  assert.equal((await sendTurn(args)).phase, 'outcome_unknown');
  assert.equal((await sendTurn(args)).phase, 'outcome_unknown');
  assert.equal(writes, 1);
});

test('an unsatisfied verification requirement prevents message submission', async () => {
  let writes = 0;
  globalThis.fetch = async url => {
    if (new URL(url).pathname.endsWith('/sentinel/chat-requirements')) {
      return Response.json({ token: 'test-requirements', turnstile: { required: true } });
    }
    writes++;
    throw new Error('No message may be sent');
  };
  await assert.rejects(sendTurn({ operationId: randomUUID(), prompt: 'Hi', model: 'test-model' }), { code: 'VERIFICATION_REQUIRED' });
  assert.equal(writes, 0);
});
