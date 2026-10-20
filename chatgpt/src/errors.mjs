export class ChatGptError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChatGptError';
    this.code = code;
    this.details = details;
  }
}
