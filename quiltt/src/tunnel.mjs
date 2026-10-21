import { spawn } from 'node:child_process';

export async function startTunnel(binary, port, { spawnImpl = spawn } = {}) {
  const child = spawnImpl(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tunnel timeout')), 25000); let output = '';
      const fail = () => { clearTimeout(timer); reject(new Error('Tunnel unavailable')); };
      child.once('error', fail); child.once('exit', fail);
      child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-20000); const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    return { child, url };
  } catch (error) { child.kill(); throw error; }
}

