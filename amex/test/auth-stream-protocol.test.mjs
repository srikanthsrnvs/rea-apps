import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLoginTimelineRequest, buildStreamingPasswordLogin, parseLoginSseFrame,
  createLoginSseDecoder, parseLoginSseResponse,
} from '../src/auth-stream-protocol.mjs';
import { parseLoginSummary } from '../src/auth-protocol.mjs';

const login = {
  status: { success: true }, logonData: { status: 0, jsonWebToken: { rawToken: 'synthetic-jwt' } },
  summary: { status: 0, cardList: [] },
};
const loginFrame = `event: LOGIN\ndata: ${JSON.stringify(login)}\n\n`;

test('streaming login sends the native login/timeline wrapper with truthful runtime metadata', () => {
  const now = Date.parse('2026-10-21T15:04:05.006Z');
  const request = buildStreamingPasswordLogin({ userId: 'example-user', password: 'synthetic-password', now, timeZone: 'America/Los_Angeles' });
  assert.equal(request.path, '/services/accountservicing/streaming/v1/loginsummarytimeline');
  assert.equal(request.responseType, 'login-sse');
  assert.equal(request.retry, false);
  assert.equal(request.body.login.loginCredentials.userIdLogin.userId, 'example-user');
  assert.deepEqual(request.body.timeline, {
    sortedIndex: 0, localTime: '10-21-2026T08:04:05 AM PDT', timeZone: 'America/Los_Angeles',
    timestampInMilli: String(now), timeZoneOffsetInMilli: '-25200000',
    pendingChargeEnabled: false, cmlEnabled: false, payWithPointsEnabled: false,
    pushEnabled: false, goodsSvcOfferEnabled: false, payYourWayEnabled: false,
    biometrics: { fingerprintStatus: 'NotCapable' },
  });
  assert.equal(buildLoginTimelineRequest({ now, timeZone: 'UTC' }).timeZoneOffsetInMilli, '0');
  assert.equal(buildLoginTimelineRequest({ now: Date.parse('2026-01-21T15:04:05Z'), timeZone: 'America/Los_Angeles' }).timeZoneOffsetInMilli, '-28800000');
  assert.throws(() => buildLoginTimelineRequest({ now: NaN }));
  assert.throws(() => buildLoginTimelineRequest({ now, timeZone: 'invalid-zone' }));
});

test('the LOGIN event is a direct LoginSummaryResponse and remains an unvalidated candidate', () => {
  const parsed = parseLoginSseFrame({ event: 'LOGIN', data: JSON.stringify(login) });
  assert.equal(parsed.type, 'login');
  assert.deepEqual(parsed.response, login);
  const candidate = parseLoginSummary(parsed.response);
  assert.equal(candidate.phase, 'candidate_authenticated');
  assert.equal(candidate.authenticated, false);
  assert.equal(candidate.requiresAccountValidation, true);
});

test('decoder handles arbitrary text chunks, CRLF, comments and timeline frames before LOGIN', () => {
  const source = `\uFEFF: keep-alive\r\nevent: TIMELINE\r\ndata: {"status":{"success":true}}\r\n\r\n${loginFrame.replaceAll('\n', '\r\n')}`;
  const decoder = createLoginSseDecoder();
  let result = null;
  for (const character of source) {
    const next = decoder.push(character);
    if (next) { result = next; break; }
  }
  assert.equal(result.type, 'login');
  assert.deepEqual(result.response, login);
  assert.deepEqual(decoder.finish(), result);
});

test('decoder supports SSE multi-line JSON and stops on the first native login result', () => {
  const text = 'event: LOGIN\ndata: {"status":{"success":true},\ndata: "logonData":{"status":4}}\n\n';
  const result = parseLoginSseResponse(`${text}event: UNKNOWN\ndata: {}\n\n`);
  assert.equal(result.type, 'login');
  assert.equal(parseLoginSummary(result.response).phase, 'mfa_required');
  assert.deepEqual(parseLoginSseResponse(`${loginFrame}${loginFrame}`), { type: 'login', response: login });
});

test('native filtering keeps timeline parse errors and untagged status from masking a later LOGIN', () => {
  const timelineError = `event: TIMELINE\ndata: invalid\n\n${loginFrame}`;
  assert.equal(parseLoginSseResponse(timelineError).type, 'login');
  const untagged = `data: {"success":false,"reportingCode":"SYNTHETIC"}\n\n${loginFrame}`;
  assert.equal(parseLoginSseResponse(untagged).type, 'login');
  const loginError = `event: LOGIN\ndata: invalid\n\n${loginFrame}`;
  assert.equal(parseLoginSseResponse(loginError).reason, 'invalid_stream_json');
});

test('unknown events, malformed data and untagged status errors cannot authenticate', () => {
  assert.equal(parseLoginSseResponse('event: login\ndata: {}\n\n').reason, 'unknown_stream_event');
  assert.equal(parseLoginSseResponse('event: LOGIN\ndata: invalid\n\n').reason, 'invalid_stream_json');
  assert.equal(parseLoginSseResponse('event: LOGIN\ndata: []\n\n').reason, 'invalid_stream_response');
  const error = parseLoginSseResponse('data: {"success":false,"reportingCode":"SYNTHETIC"}\n\n');
  assert.equal(error.type, 'error');
  assert.equal(error.status.reportingCode, 'SYNTHETIC');
  assert.equal(parseLoginSseResponse('data: {"success":true}\n\n').type, 'error');
});

test('EOF before a complete LOGIN frame is explicitly unsuccessful and never inferred from timeline', () => {
  for (const source of ['', ': ping\n\n', 'event: TIMELINE\ndata: {}\n\n', `event: LOGIN\ndata: ${JSON.stringify(login)}\n`]) {
    assert.deepEqual(parseLoginSseResponse(source), { type: 'error', reason: 'stream_closed_without_login' });
  }
  const crOnly = `event: LOGIN\rdata: ${JSON.stringify(login)}\r\r`;
  assert.equal(parseLoginSseResponse(crOnly).type, 'login');
});

test('stream limits are bounded and a server retry field never triggers replay', () => {
  const decoder = createLoginSseDecoder({ maxBytes: 16 });
  assert.equal(decoder.push('x'.repeat(17)).reason, 'stream_byte_limit');
  assert.equal(createLoginSseDecoder({ maxFrames: 1 }).push('event: TIMELINE\ndata: {}\n\nevent: TIMELINE\ndata: {}\n\n').reason, 'stream_frame_limit');
  assert.equal(parseLoginSseResponse(`retry: 1\nid: synthetic\n${loginFrame}`).type, 'login');
  assert.throws(() => createLoginSseDecoder({ maxBytes: 0 }));
});
