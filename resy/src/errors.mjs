export class ResyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ResyError';
    this.code = code;
    this.details = details;
  }
}
