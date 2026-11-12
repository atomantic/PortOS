/**
 * One log file per Blender film job under renders/logs/: everything Blender
 * and the film printed, including a Python traceback, which a worker's result
 * only keeps the last few kilobytes of. The newest 60 are kept.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { blenderRendersDir } from './workspace.js';

const KEPT = 60;
// A film printing in a tight loop must not fill the disk through its log.
const MAX_BYTES = 16 * 1024 * 1024;

async function dropOldLogs(directory) {
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.log'));
  if (names.length < KEPT) return;
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => b.at - a.at);
  for (const { name } of dated.slice(KEPT - 1)) await rm(join(directory, name), { force: true });
}

/**
 * Open the log of `jobId`. `file` is its path for the media route; `write`
 * appends one line; `close` resolves once the file is flushed.
 */
export async function openBlenderJobLog(owner, jobId) {
  const directory = join(blenderRendersDir(owner), 'logs');
  await mkdir(directory, { recursive: true });
  await dropOldLogs(directory);
  const stream = createWriteStream(join(directory, `${jobId}.log`), { flags: 'a' });
  let failed = false;
  let bytes = 0;
  let full = false;
  // Logging is best effort: a full disk fails the render through its frames, not here.
  stream.on('error', (error) => {
    if (!failed) console.error(`❌ Blender film job log ${jobId} could not be written: ${error.message}`);
    failed = true;
  });
  return {
    file: `logs/${jobId}.log`,
    write: (line) => {
      if (failed || full) return;
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > MAX_BYTES) {
        full = true;
        stream.write('[log truncated: this job printed more than 16 MiB]\n');
        return;
      }
      stream.write(`${line}\n`);
    },
    close: () => new Promise((resolve) => {
      if (failed || stream.destroyed) { resolve(); return; }
      stream.once('error', resolve);
      stream.end(resolve);
    }),
  };
}
