// Stands in for lib/nativeTrash.js inside a peerMachine worker (see
// peerMachine.js): "trashed" files move into the machine's own trash-bin
// directory, so a federation test never reaches the OS trash.
import { mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { workerData } from 'node:worker_threads';

export const NATIVE_TRASH_DEADLINE_MS = 30_000;

let moved = 0;

export async function moveToNativeTrash(paths) {
  const bin = join(workerData.root, 'trash-bin');
  await mkdir(bin, { recursive: true });
  for (const path of paths) await rename(path, join(bin, `${++moved}-${basename(path)}`));
}
