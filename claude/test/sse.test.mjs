import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, parseCompletionEvent, createCompletionAccumulator, consumeCompletionStream } from '../src/sse.mjs';

async function* chunks(text, size = 7) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const start = { type: 'message_start', message: { uuid: 'invented-assistant', parent_uuid: 'invented-parent' } };
const block = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const text = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A café ☕' } };
const stop = { type: 'message_stop' };

test('SSE preserves fragmented UTF-8, CRLF split between chunks and multiple data lines', async () => {
  const raw = '\ufeff: keepalive\r\nid: 7\r\nevent: example\r\ndata: café\r\ndata: ☕\r\nretry: 1500\r\n\r\ndata: second\r\n\r\n';
  const frames = await Array.fromAsync(parseSSE(chunks(raw, 1)));
  assert.deepEqual(frames, [
    { event: 'example', data: 'café\n☕', id: '7', retry: 1500 },
    { event: 'message', data: 'second', id: '7' },
  ]);
});

test('bare CR delimiters and empty data work; incomplete EOF event is discarded', async () => {
  assert.deepEqual(await Array.fromAsync(parseSSE(chunks('data:\r\rdata: not-dispatched'))), [{ event: 'message', data: '', id: '' }]);
});

test('invalid UTF-8 and oversized line or frame fail with bounded errors', async () => {
  async function* malformed() { yield Uint8Array.of(0xff); }
  await assert.rejects(Array.fromAsync(parseSSE(malformed())), { code: 'INVALID_STREAM' });
  await assert.rejects(Array.fromAsync(parseSSE(chunks('data: abcdef\n\n'), { maxLineBytes: 8 })), { code: 'SSE_TOO_LARGE' });
  await assert.rejects(Array.fromAsync(parseSSE(chunks('data: a\ndata: b\n\n'), { maxFrameBytes: 12 })), { code: 'SSE_TOO_LARGE' });
});

test('native error envelope is recognized independently of its embedded type', () => {
  assert.deepEqual(parseCompletionEvent({ event: 'ping', data: '' }), { type: 'ping' });
  assert.deepEqual(parseCompletionEvent({ event: 'error', data: '{"error":{"type":"rate_limit_error","message":"Wait"}}' }), { type: 'error', error: { type: 'rate_limit_error', message: 'Wait' } });
  assert.throws(() => parseCompletionEvent({ event: 'message_start', data: '{}' }), { code: 'INVALID_STREAM' });
});

test('completion assembles text and preserves limits, stop metadata, usage and message identity', async () => {
  const raw = [start, block, text,
    { type: 'message_limit', message_limit: { type: 'within_limit', resetsAt: 1900000000 } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }, stop,
  ].map(event).join('');
  const result = await consumeCompletionStream(chunks(raw, 1));
  assert.equal(result.completed, true);
  assert.equal(result.text, 'A café ☕');
  assert.equal(result.messages[0].uuid, 'invented-assistant');
  assert.equal(result.messages[0].parent_uuid, 'invented-parent');
  assert.equal(result.messages[0].stop_reason, 'end_turn');
  assert.deepEqual(result.messages[0].usage, { output_tokens: 8 });
  assert.equal(result.messageLimits[0].type, 'within_limit');
});

test('transport EOF never implies completion and includes partial state for reconciliation', async () => {
  await assert.rejects(consumeCompletionStream(chunks([start, block, text].map(event).join(''))), error => {
    assert.equal(error.code, 'STREAM_INCOMPLETE');
    assert.equal(error.details.partial.text, 'A café ☕');
    assert.equal(error.details.partial.completed, false);
    return true;
  });
});

test('rate limit error retains already streamed content without replay', () => {
  const state = createCompletionAccumulator();
  for (const item of [start, block, text]) state.push(item);
  assert.throws(() => state.push({ type: 'error', error: { type: 'rate_limit_error', message: 'Limit reached' } }), error => {
    assert.equal(error.code, 'COMPLETION_ERROR');
    assert.equal(error.details.error.type, 'rate_limit_error');
    assert.equal(error.details.partial.text, 'A café ☕');
    return true;
  });
});

test('tool JSON fragments and unknown deltas remain structured and trigger reconciliation', () => {
  const state = createCompletionAccumulator();
  state.push(start);
  state.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-example', name: 'example' } });
  for (const partial of ['{"city":', '"Venice"}']) state.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } });
  state.push({ type: 'content_block_stop', index: 0 });
  state.push({ type: 'future_event', detail: 'unknown' });
  state.push(stop);
  const result = state.finish();
  assert.deepEqual(result.messages[0].content[0].input, { city: 'Venice' });
  assert.equal(result.text, '');
  assert.equal(result.requiresReconciliation, true);
  assert.deepEqual(result.unknownEventTypes, ['future_event']);
});

test('retracted text disappears and replacement blocks use their correct index', () => {
  const state = createCompletionAccumulator();
  for (const item of [start, block, text]) state.push(item);
  state.push({ type: 'content_block_retract', from_index: 0 });
  state.push(block);
  state.push({ ...text, delta: { type: 'text_delta', text: 'Replacement' } });
  state.push(stop);
  assert.equal(state.finish().text, 'Replacement');
});

test('out-of-order block references and message identity replacement fail closed', () => {
  const state = createCompletionAccumulator();
  state.push(start);
  assert.throws(() => state.push(text), { code: 'INVALID_STREAM' });
  assert.throws(() => state.push({ type: 'message_delta', delta: { uuid: 'other' } }), { code: 'INVALID_STREAM' });
});

test('unrecognized content deltas are retained and require authoritative reread', () => {
  const state = createCompletionAccumulator();
  state.push(start); state.push(block);
  state.push({ type: 'content_block_delta', index: 0, delta: { type: 'citation_delta', citation: { title: 'Example' } } });
  state.push(stop);
  const result = state.finish();
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.messages[0].content[0].deltas[0].citation.title, 'Example');
});

test('consumer callback is called once per decoded event and can abort', async () => {
  const seen = [];
  await consumeCompletionStream(chunks([start, block, text, stop].map(event).join('')), { onEvent: item => seen.push(item.type) });
  assert.deepEqual(seen, ['message_start', 'content_block_start', 'content_block_delta', 'message_stop']);
  await assert.rejects(consumeCompletionStream(chunks([start, stop].map(event).join('')), { onEvent: () => { throw new Error('Caller abort'); } }), /Caller abort/);
});
