import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { AmexError } from './errors.mjs';

const LIMIT = 16_384;
const invalid = message => { throw new AmexError('INVALID_CREDENTIAL_INPUT', message); };
async function privateFile(filename) {
  let file;
  try {
    file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LIMIT || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) {
      invalid('Credentials must be in a small, owner-only regular file (chmod 600).');
    }
    return await file.readFile('utf8');
  } catch (error) {
    if (error instanceof AmexError) throw error;
    invalid('The private credential file could not be read.');
  } finally { await file?.close(); }
}
async function readInput(input) {
  const chunks = []; let bytes = 0;
  for await (const chunk of input) {
    const part = Buffer.from(chunk); bytes += part.byteLength;
    if (bytes > LIMIT) invalid('Credential input exceeds the size limit.');
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Never accept a password in argv or save one to CLI state. Callers keep this
// result in memory for the single login request, and must not log the request.
export async function readCredentials({ userId, credentialsFile, credentialsStdin = false, passwordFile, passwordStdin = false, prompt = false } = {}, input = process.stdin) {
  if ([credentialsFile !== undefined, credentialsStdin, passwordFile !== undefined, passwordStdin, prompt].filter(Boolean).length !== 1) {
    invalid('Choose exactly one credential input: hidden prompt, private file or stdin.');
  }
  if (prompt) return promptCredentials(userId, input);
  if (credentialsFile !== undefined || credentialsStdin) {
    if (userId !== undefined) invalid('The credentials JSON already supplies the user ID.');
    const text = credentialsStdin ? await readInput(input) : await privateFile(credentialsFile);
    let value;
    try { value = JSON.parse(text); } catch { invalid('Provide JSON containing only userId and password.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['userId', 'password'].includes(key))
      || typeof value.userId !== 'string' || !value.userId || typeof value.password !== 'string' || !value.password) invalid('Provide JSON containing only userId and password.');
    return value;
  }
  if (typeof userId !== 'string' || !userId) invalid('Provide the Amex user ID.');
  const text = passwordStdin ? await readInput(input) : await privateFile(passwordFile);
  const password = text.replace(/\r?\n$/, '');
  if (!password) invalid('An Amex password is required.');
  return { userId, password };
}

async function promptCredentials(userId, input) {
  const output = process.stderr;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') invalid('The hidden prompt requires an interactive terminal. Use private stdin or a chmod 600 file instead.');
  if (userId === undefined) {
    const terminal = createInterface({ input, output, historySize: 0 });
    try { userId = await new Promise((resolve, reject) => {
      const cancelled = () => reject(new AmexError('CREDENTIAL_INPUT_CANCELLED', 'Credential entry was cancelled.'));
      terminal.once('SIGINT', cancelled); terminal.once('close', cancelled);
      terminal.question('Amex user ID: ', value => {
        terminal.off('SIGINT', cancelled); terminal.off('close', cancelled); resolve(value);
      });
    }); }
    finally { terminal.close(); }
  }
  if (typeof userId !== 'string' || !userId.trim()) invalid('An Amex user ID is required.');
  output.write('Amex password (hidden): ');
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  input.setRawMode(true); input.resume();
  let password = '';
  try {
    password = await new Promise((resolve, reject) => {
      const finish = (error) => { input.off('keypress', onKey); input.off('end', onEnd); error ? reject(error) : resolve(password); };
      const onEnd = () => finish(new AmexError('CREDENTIAL_INPUT_CANCELLED', 'Credential entry was cancelled.'));
      function onKey(text, key = {}) {
        if (key.ctrl && ['c', 'd'].includes(key.name)) return onEnd();
        if (key.name === 'return' || key.name === 'enter') return finish();
        if (key.name === 'backspace') { password = [...password].slice(0, -1).join(''); return; }
        if (key.ctrl && key.name === 'u') { password = ''; return; }
        if (typeof text === 'string' && !/[\x00-\x1f\x7f]/u.test(text)) password += text;
        if (Buffer.byteLength(password) > LIMIT) finish(new AmexError('INVALID_CREDENTIAL_INPUT', 'Credential input exceeds the size limit.'));
      }
      input.on('keypress', onKey); input.once('end', onEnd);
    });
  } finally { input.setRawMode(Boolean(wasRaw)); if (wasPaused) input.pause(); output.write('\n'); }
  if (!password) invalid('An Amex password is required.');
  return { userId, password };
}
