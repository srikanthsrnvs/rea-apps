export class QuilttError extends Error {
  constructor(code, message) { super(message); this.name = 'QuilttError'; this.code = code; }
}
