export class AirbnbError extends Error {
  constructor(code, message, details) { super(message); this.name = 'AirbnbError'; this.code = code; this.details = details; }
}
