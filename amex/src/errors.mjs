export class AmexError extends Error {
  constructor(code, message, details) { super(message); this.name = 'AmexError'; this.code = code; if (details) this.details = details; }
}
