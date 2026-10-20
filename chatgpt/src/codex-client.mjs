import { ChatGptError } from './errors.mjs';
import WebSocket from 'ws';
import {
  CODEX_CLOUD_URL, CODEX_SUBPROTOCOL, buildCodexRequest,
  initializeRequest, parseCodexMessage, parseCodexResponse,
} from './codex-protocol.mjs';

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ChatGptError('INVALID_CODEX_ARGUMENT', `${name} must be a positive integer.`);
  }
  return value;
}

export function createCodexWebSocket(url, init) {
  return new WebSocket(url, init.protocols, {
    headers: init.headers,
    perMessageDeflate: false,
    followRedirects: false,
    maxPayload: init.maxPayload,
  });
}

export class CodexClient {
  constructor({ headers = {}, timeoutMs = 30_000, connectTimeoutMs = 15_000,
    maxNotifications = 100, maxNotificationBytes = 1_048_576, maxFrameBytes = 8_388_608,
    onNotification, onRequest, webSocketFactory = createCodexWebSocket, requestAttestation = false } = {}) {
    this.headers = headers;
    this.timeoutMs = positive(timeoutMs, 'timeoutMs');
    this.connectTimeoutMs = positive(connectTimeoutMs, 'connectTimeoutMs');
    this.maxNotifications = positive(maxNotifications, 'maxNotifications');
    this.maxNotificationBytes = positive(maxNotificationBytes, 'maxNotificationBytes');
    this.maxFrameBytes = positive(maxFrameBytes, 'maxFrameBytes');
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.webSocketFactory = webSocketFactory;
    this.requestAttestation = requestAttestation;
    this.state = 'new';
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.retainedBytes = 0;
    this.droppedNotifications = 0;
    this.droppedServerRequests = 0;
    this.callbackErrors = 0;
    this.socket = null;
    this.lastResponse = null;
    this.connectPromise = null;
    this.closePromise = null;
  }

  async connect() {
    if (this.state === 'closed') throw new ChatGptError('CODEX_CLOSED', 'Create a new client to reconnect to Codex.');
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.open();
    return this.connectPromise;
  }

  async open() {
    this.state = 'connecting';
    try {
      const headers = typeof this.headers === 'function'
        ? await this.headers(CODEX_CLOUD_URL, 'GET') : this.headers;
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new ChatGptError('INVALID_CODEX_ARGUMENT', 'WebSocket headers must be an object.');
      }
      const socket = this.webSocketFactory(CODEX_CLOUD_URL, {
        protocols: [CODEX_SUBPROTOCOL], headers, maxPayload: this.maxFrameBytes,
      });
      this.socket = socket;
      if (typeof socket.on === 'function') {
        socket.on('unexpected-response', (_request, response) => {
          this.upgradeError = new ChatGptError('CODEX_UPGRADE_REJECTED', 'Codex rejected the WebSocket connection.', {
            status: response.statusCode,
            challenge: response.headers['cf-mitigated'] === 'challenge',
          });
          response.resume();
          socket.terminate();
        });
      }
      socket.addEventListener('message', (event) => this.receive(event.data));
      socket.addEventListener('close', () => {
        this.state = 'closed';
        this.rejectPending('CODEX_DISCONNECTED', 'Codex disconnected before the response arrived.');
      });
      socket.addEventListener('error', () => {
        const connected = this.state === 'open';
        this.state = 'closed';
        this.rejectPending(connected ? 'CODEX_DISCONNECTED' : 'CODEX_CONNECTION_ERROR',
          connected ? 'Codex disconnected before the response arrived.' : 'The Codex connection failed.');
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new ChatGptError('CODEX_CONNECT_TIMEOUT', 'Timed out connecting to Codex.'));
        }, this.connectTimeoutMs);
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(this.upgradeError ?? new ChatGptError('CODEX_CONNECTION_ERROR', 'Could not connect to Codex.')); };
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeEventListener('open', opened);
          socket.removeEventListener('error', failed);
          socket.removeEventListener('close', failed);
        };
        socket.addEventListener('open', opened, { once: true });
        socket.addEventListener('error', failed, { once: true });
        socket.addEventListener('close', failed, { once: true });
      });
      this.state = 'open';
      const hello = initializeRequest(1, { requestAttestation: this.requestAttestation });
      this.initializeResult = await this.request(hello.method, hello.params);
      this.sendNotification('initialized', {});
      return this;
    } catch (error) {
      await this.close();
      if (error instanceof ChatGptError) throw error;
      // Never include constructor errors: they can contain request headers.
      throw new ChatGptError('CODEX_CONNECTION_ERROR', 'Could not initialize the Codex connection.');
    }
  }

  request(method, params = {}, options = {}) {
    return this.requestEnvelope(method, params, options).then((response) => response.result);
  }

  requestEnvelope(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    positive(timeoutMs, 'timeoutMs');
    if (this.state !== 'open' || this.socket?.readyState !== 1) {
      return Promise.reject(new ChatGptError('CODEX_NOT_CONNECTED', 'Connect to Codex before sending a request.'));
    }
    const request = buildCodexRequest(this.nextId++, method, params);
    return new Promise((resolve, reject) => {
      const entry = { request, resolve, reject, sent: false, timer: null };
      entry.timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new ChatGptError('CODEX_REQUEST_TIMEOUT', 'Codex did not acknowledge the request in time.',
          { requestId: request.id, method, deliveryUnknown: entry.sent, pendingRequests: this.serverRequests.length }));
      }, timeoutMs);
      this.pending.set(request.id, entry);
      try {
        this.socket.send(JSON.stringify(request));
        entry.sent = true;
      } catch {
        clearTimeout(entry.timer);
        this.pending.delete(request.id);
        reject(new ChatGptError('CODEX_SEND_FAILED', 'Could not send the Codex request.',
          { requestId: request.id, method, deliveryUnknown: true }));
      }
    });
  }

  sendNotification(method, params) {
    if (this.state !== 'open' || this.socket?.readyState !== 1) {
      throw new ChatGptError('CODEX_NOT_CONNECTED', 'Connect to Codex before sending a notification.');
    }
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    this.socket.send(JSON.stringify(message));
  }

  async receive(data) {
    try {
      let raw = data;
      if (data instanceof Blob) raw = await data.text();
      const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
      if (!Number.isFinite(size) || size > this.maxFrameBytes) {
        throw new ChatGptError('CODEX_FRAME_TOO_LARGE', 'Codex sent a frame exceeding the configured limit.');
      }
      const message = parseCodexMessage(raw);
      if (typeof message.method === 'string') {
        const isRequest = Object.hasOwn(message, 'id');
        this.retain(message, size, isRequest);
        // Requests for approval, tool input or credentials are only surfaced.
        // The transport never approves or answers them on its own.
        const callback = isRequest ? this.onRequest : this.onNotification;
        if (callback) {
          try { await callback(message); } catch { this.callbackErrors += 1; }
        }
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) {
        this.retain(message, size, false);
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      this.lastResponse = message;
      try {
        const result = parseCodexResponse(message, { expectedId: entry.request.id });
        entry.resolve({ request: entry.request, response: message, result });
      } catch (error) {
        entry.reject(error);
      }
    } catch (error) {
      this.rejectPending(error.code ?? 'INVALID_CODEX_RESPONSE', 'Codex sent an invalid response.');
      await this.close();
    }
  }

  retain(message, bytes, isRequest) {
    const collection = isRequest ? this.serverRequests : this.notifications;
    if (bytes > this.maxNotificationBytes) {
      if (isRequest) this.droppedServerRequests += 1;
      else this.droppedNotifications += 1;
      return;
    }
    collection.push({ message, bytes });
    this.retainedBytes += bytes;
    while (this.notifications.length + this.serverRequests.length > this.maxNotifications ||
      this.retainedBytes > this.maxNotificationBytes) {
      // Retain outstanding server requests ahead of routine progress events.
      const notification = this.notifications.length > 0;
      const victim = notification ? this.notifications.shift() : this.serverRequests.shift();
      this.retainedBytes -= victim.bytes;
      if (notification) this.droppedNotifications += 1;
      else this.droppedServerRequests += 1;
    }
  }

  snapshot() {
    return {
      state: this.state,
      notifications: this.notifications.map(({ message }) => message),
      pendingRequests: this.serverRequests.map(({ message }) => message),
      droppedNotifications: this.droppedNotifications,
      droppedServerRequests: this.droppedServerRequests,
      requiresUserAction: this.serverRequests.length > 0 || this.droppedServerRequests > 0,
      callbackErrors: this.callbackErrors,
    };
  }

  rejectPending(code, message) {
    for (const { request, reject, timer, sent } of this.pending.values()) {
      clearTimeout(timer);
      reject(new ChatGptError(code, message,
        { requestId: request.id, method: request.method, deliveryUnknown: sent }));
    }
    this.pending.clear();
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.state = 'closed';
    this.rejectPending('CODEX_CLOSED', 'The Codex client was closed before receiving a response.');
    const socket = this.socket;
    if (!socket || socket.readyState === 3) return;
    this.closePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate?.();
        resolve();
      }, 500);
      socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      try { socket.close(1000, 'Client finished'); } catch { clearTimeout(timer); resolve(); }
    });
    return this.closePromise;
  }
}

export async function withCodex(headers, callback, options = {}) {
  const client = new CodexClient({ ...options, headers });
  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.close();
  }
}
