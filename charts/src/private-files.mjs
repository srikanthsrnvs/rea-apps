import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { ChartsError } from './errors.mjs';

// A stat followed by readFile can race a growing file; an ordinary open can
// also block forever on a FIFO. Keep both the file type and actual read bounded.
export async function readPrivateText(filename, maxBytes, { repairPermissions = false } = {}) {
  let file;
  try {
    file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes || (process.getuid && info.uid !== process.getuid())) {
      throw new ChartsError('PRIVATE_FILE_ERROR', 'Use a regular private file owned by the current user within the documented size limit.');
    }
    if (info.mode & 0o077) {
      if (!repairPermissions) throw new ChartsError('PRIVATE_FILE_ERROR', 'The private file must not grant group or other access.');
      await file.chmod(0o600);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > maxBytes) throw new ChartsError('PRIVATE_FILE_ERROR', 'The private file exceeds its documented size limit.');
    return buffer.toString('utf8', 0, used);
  } finally { await file?.close(); }
}
