import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { BankAccountsError } from './errors.mjs';
const invalid = message => { throw new BankAccountsError('PRIVATE_INPUT_REQUIRED', message); };
export async function privateInput({ file, stdin = false, prompt = false } = {}, input = process.stdin) {
  if ([file !== undefined, stdin, prompt].filter(Boolean).length !== 1) invalid('Choose exactly one private key input: file, stdin or hidden terminal prompt.');
  let value;
  if (file !== undefined) {
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16384 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) invalid('Use an owner-only regular credential file (chmod 600).');
      value = await handle.readFile('utf8');
    } catch (error) { if (error instanceof BankAccountsError) throw error; invalid('The private credential file could not be read.'); }
    finally { await handle?.close(); }
  } else if (stdin) {
    value = ''; for await (const part of input) { value += part.toString(); if (Buffer.byteLength(value) > 16384) invalid('Private credential input is too large.'); }
  } else {
    if (!input.isTTY || !process.stderr.isTTY || !input.setRawMode) invalid('The hidden prompt requires an interactive terminal.');
    process.stderr.write('Quiltt Sandbox API secret (hidden): ');
    const raw = input.isRaw, paused = input.isPaused(); emitKeypressEvents(input); input.setRawMode(true); input.resume(); value = '';
    try { await new Promise((resolve, reject) => {
      const cleanup = () => { input.off('keypress', keypress); input.off('end', cancelled); };
      const cancelled = () => { cleanup(); reject(new BankAccountsError('INPUT_CANCELLED', 'Credential entry was cancelled.')); };
      const keypress = (text, key = {}) => {
        if (key.ctrl && ['c', 'd'].includes(key.name)) return cancelled();
        if (['return', 'enter'].includes(key.name)) { cleanup(); return resolve(); }
        if (key.name === 'backspace') { value = [...value].slice(0, -1).join(''); return; }
        if (key.ctrl && key.name === 'u') { value = ''; return; }
        if (typeof text === 'string' && !/[\x00-\x1f\x7f]/u.test(text)) value += text;
        if (Buffer.byteLength(value) > 16384) cancelled();
      };
      input.on('keypress', keypress); input.once('end', cancelled);
    }); } finally { input.setRawMode(Boolean(raw)); if (paused) input.pause(); process.stderr.write('\n'); }
  }
  value = value.trim(); if (!value) invalid('A private credential is required.'); return value;
}
