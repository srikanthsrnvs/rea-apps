export class InstagramError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InstagramError';
    this.code = code;
    this.details = details;
  }
}
