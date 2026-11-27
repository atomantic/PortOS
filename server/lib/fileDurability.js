/** Synchronous filesystem flush and exclusive JSON publication for durability-sensitive callers. */
// Database admission loads these helpers before the process execution layer.
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';

/** Flush directory metadata, propagating I/O failures on platforms that support it. */
export function syncDirectorySync(dir) {
  // Node cannot fsync directory handles on Windows.
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Create and flush a private JSON file without replacing an existing path. */
export function writeDurableExclusiveSync(path, value, { indent = 2 } = {}) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, indent) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
