import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// A long-lived viewer cannot hold the Docker command lock for its whole life.
// Keep flock alive through a pipe for each read transaction instead. Parent
// death closes stdin, so the owned helper exits and the kernel releases its lock.
export async function withKernelRequestLock(
  operation,
  { directory, timeoutMs = 30000 },
) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const helper =
    'process.stdout.write("LOCKED\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));';
  const child = spawn(
    'flock',
    [
      '-w',
      String(timeoutMs / 1000),
      '-E',
      '75',
      path.join(directory, '.command.lock'),
      process.execPath,
      '-e',
      helper,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  let ready = false,
    output = '';
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null }));
  });
  const acquired = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('LOCKED\n')) {
        ready = true;
        resolve();
      }
    });
    child.once('exit', (code) => {
      if (!ready)
        reject(
          Object.assign(
            new Error(
              code === 75
                ? 'Timed out waiting for the Uber kernel state lock'
                : 'Kernel state lock helper failed',
            ),
            {
              code:
                code === 75
                  ? 'UBER_STATE_LOCK_TIMEOUT'
                  : 'UBER_KERNEL_LOCK_FAILED',
            },
          ),
        );
    });
  });
  try {
    await acquired;
    return await operation();
  } finally {
    child.stdin.end();
    await exited;
  }
}
