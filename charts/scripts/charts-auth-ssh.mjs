// Optional forced-command gate for a dedicated receiver SSH key. This allows
// only the two callback operations; it never evaluates a shell command.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function allowedAuthCommand(value, home = os.homedir()) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const pieces = [...value.matchAll(/'([^']*)'/gu)].map(match => match[1]);
  if (pieces.map(piece => `'${piece}'`).join(' ') !== value || pieces[0] !== path.join(home, '.local/bin/charts')) return null;
  const args = pieces.slice(1);
  const id = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (args[0] !== 'auth' || args[2] !== '--login-id' || !new RegExp(`^${id}$`, 'u').test(args[3] ?? '')) return null;
  if (args.length === 4 && args[1] === 'poll') return args;
  if (args.length === 7 && args[1] === 'complete' && args[4] === '--callback-stdin' && args[5] === '--timeout-ms' && args[6] === '60000') return args;
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = allowedAuthCommand(process.env.SSH_ORIGINAL_COMMAND);
  if (!args) {
    console.log(JSON.stringify({ status: 'error', message: 'This SSH key permits only Charts login polling and callback completion.' }));
    process.exitCode = 1;
  } else {
    const child = spawn(path.join(os.homedir(), '.local/bin/charts'), args, { stdio: 'inherit',
      env: { HOME: os.homedir(), USER: process.env.USER, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    child.on('error', () => { process.exitCode = 1; });
    child.on('close', code => { process.exitCode = code ?? 1; });
  }
}
