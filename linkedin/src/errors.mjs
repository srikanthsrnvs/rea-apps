export class LinkedInError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LinkedInError';
    this.code = code;
    this.details = details;
  }
}
