/**
 * One log file per Blender job: everything Blender and the authored script
 * printed, including a Python traceback, which a worker's result only keeps
 * the last few kilobytes of. Capped at 16 MiB per job; a directory that holds
 * many job logs can keep only the newest `kept`.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// A script printing in a tight loop must not fill the disk through its log.
const MAX_BYTES = 16 * 1024 * 1024;

async function dropOldLogs(directory, kept) {
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.log'));
  if (names.length < kept) return;
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => b.at - a.at);
  for (const { name } of dated.slice(kept - 1)) await rm(join(directory, name), { force: true });
}

/**
 * Open `directory/name` for appending. `write` appends one line; `close`
 * resolves once the file is flushed. `label` names the job in a write failure.
 */
export async function openBlenderJobLogFile({ directory, name, label, kept = null }) {
  await mkdir(directory, { recursive: true });
  if (kept) await dropOldLogs(directory, kept);
  const stream = createWriteStream(join(directory, name), { flags: 'a' });
  let failed = false;
  let bytes = 0;
  let full = false;
  // Logging is best effort: a full disk fails the job through its outputs, not here.
  stream.on('error', (error) => {
    if (!failed) console.error(`❌ ${label} log could not be written: ${error.message}`);
    failed = true;
  });
  return {
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
