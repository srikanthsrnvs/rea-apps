export class ClaudeError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ClaudeError'; this.code = code; this.details = details; }
}
