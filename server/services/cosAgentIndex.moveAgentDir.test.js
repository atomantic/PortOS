import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// Isolated file: `rename` is forced to fail (EXDEV / a Windows open handle) so the
// copy fallback runs, and `cp` can be made to fail halfway.
const mock = vi.hoisted(() => ({
  agentsDir: `${process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp'}/portos-cos-movedir-${process.pid}`,
  failCp: false,
}));

vi.mock('./cosState.js', () => ({
  AGENTS_DIR: mock.agentsDir,
  loadState: vi.fn(),
  saveState: vi.fn(),
  withStateLock: async (fn) => fn(),
}));
vi.mock('./domainUsage.js', () => ({ recordDomainUsage: vi.fn(async () => {}) }));
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return {
    ...actual,
    rename: vi.fn(async () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); }),
    cp: vi.fn(async (from, to, opts) => {
      if (!mock.failCp) return actual.cp(from, to, opts);
      // Copy one file, then fail — a half-copied target.
      await actual.mkdir(to, { recursive: true });
      await actual.writeFile(`${to}/metadata.json`, await actual.readFile(`${from}/metadata.json`));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }),
  };
});

import { moveAgentDir } from './cosAgentIndex.js';

// Not valid UTF-8: a text round-trip would replace these with U+FFFD.
const GZIP_BYTES = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x81, 0xc3, 0x28]);

describe('moveAgentDir copy fallback (rename failed)', () => {
  const flatDir = join(mock.agentsDir, 'agent-1');
  const targetDir = join(mock.agentsDir, '2026-01-02', 'agent-1');

  beforeEach(async () => {
    mock.failCp = false;
    await rm(mock.agentsDir, { recursive: true, force: true });
    await mkdir(join(flatDir, 'nested'), { recursive: true });
    await mkdir(join(mock.agentsDir, '2026-01-02'), { recursive: true });
    await writeFile(join(flatDir, 'metadata.json'), '{"id":"agent-1"}');
    await writeFile(join(flatDir, 'raw.txt.gz'), GZIP_BYTES);
    await writeFile(join(flatDir, 'nested', 'extra.txt'), 'kept');
  });
  afterEach(async () => {
    await rm(mock.agentsDir, { recursive: true, force: true });
  });

  it('copies binary recordings byte-for-byte and subdirectories, then removes the source', async () => {
    await moveAgentDir(flatDir, targetDir);

    expect(Buffer.compare(await readFile(join(targetDir, 'raw.txt.gz')), GZIP_BYTES)).toBe(0);
    expect(await readFile(join(targetDir, 'nested', 'extra.txt'), 'utf8')).toBe('kept');
    expect(existsSync(flatDir)).toBe(false);
  });

  it('keeps the source intact and rolls back the partial target when the copy fails', async () => {
    mock.failCp = true;

    await expect(moveAgentDir(flatDir, targetDir)).rejects.toThrow('no space left on device');

    expect(existsSync(targetDir)).toBe(false);
    expect((await readdir(flatDir)).sort()).toEqual(['metadata.json', 'nested', 'raw.txt.gz']);
    expect(Buffer.compare(await readFile(join(flatDir, 'raw.txt.gz')), GZIP_BYTES)).toBe(0);
  });
});
