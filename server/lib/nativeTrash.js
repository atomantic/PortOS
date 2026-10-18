/** OS recycling adapter using the pinned trash package's native helper assets. */
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export async function moveToNativeTrash(paths) {
  const binary = { darwin: 'macos-trash', win32: 'windows-trash.exe' }[process.platform];
  if (binary) {
    // Own the spawn: Windows must stay console-free, and macOS must not use
    // the package's fallback to a working-directory .Trash outside the OS bin.
    const command = fileURLToPath(new URL(`./lib/${binary}`, import.meta.resolve('trash')));
    const { execFile } = await import('./childProcess.js');
    await promisify(execFile)(command, paths, { timeout: 30_000 });
    return;
  }
  if (process.platform !== 'linux') throw new Error('Native trash is unavailable on this platform');
  const { default: trash } = await import('trash');
  await trash(paths, { glob: false });
}
