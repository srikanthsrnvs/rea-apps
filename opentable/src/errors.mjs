export class OpenTableError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OpenTableError';
    this.code = code;
    this.details = details;
  }
}
