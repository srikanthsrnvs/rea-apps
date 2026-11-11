import WebSocket from 'ws';

export function boundedTransport(request, handlers) {
  const socket = new WebSocket(request.url, { origin: request.origin, headers: { Origin: request.origin, ...request.headers },
    maxPayload: 2 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 15000 });
  socket.on('open', handlers.onOpen);
  socket.on('message', data => handlers.onMessage(data.toString('utf8')));
  socket.on('error', handlers.onError);
  socket.on('close', (code, reason) => handlers.onClose(code, reason.toString()));
  return { get isOpen() { return socket.readyState === WebSocket.OPEN; },
    send(data) { socket.send(data); },
    close() { if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else if (socket.readyState !== WebSocket.CLOSED) socket.close(); },
    terminate() { socket.terminate(); } };
}
