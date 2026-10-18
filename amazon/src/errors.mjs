export class AmazonError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'AmazonError'; this.code = code; this.details = details; }
}
