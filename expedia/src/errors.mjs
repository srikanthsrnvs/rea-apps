export class ExpediaError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ExpediaError'; this.code = code; this.details = details; }
}
export function errorOutput(error) {
  return { error: { code: error.code ?? 'CLI_ERROR', message: error.message, ...(error.details ?? {}) } };
}
