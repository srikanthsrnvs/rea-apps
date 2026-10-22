export class BankAccountsError extends Error {
  constructor(code, message) { super(message); this.name = 'BankAccountsError'; this.code = code; }
}
