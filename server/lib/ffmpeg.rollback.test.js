import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinPlatform } from './testHelper.js';

let failRestore = false;
let failInitialMove = false;
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, rename: async (from, to) => {
    if ((failRestore && from.includes('.bak.')) || (failInitialMove && to.includes('.bak.'))) {
      throw Object.assign(new Error('synthetic access refusal'), { code: 'EACCES' });
    }
    return actual.rename(from, to);
  } };
});
vi.mock('./childProcess.js', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('./processEnv.js', () => ({ safeChildProcessOptions: () => ({}), whichFirst: vi.fn() }));
vi.mock('./fileUtils.js', () => ({ ensureDir: vi.fn(), PATHS: {} }));
// Load the Windows branch on every CI host, then immediately restore the host.
const restorePlatform = pinPlatform('win32');
let installEncodedVideo;
try {
  ({ installEncodedVideo } = await import('./ffmpeg.js'));
} finally { restorePlatform(); }
const { withBackupAssetPublication, acquireBackupSnapshotCut, backupPublicationAdmissionStatus } = await import('./backupSnapshotBoundary.js');
const root = await mkdtemp(join(tmpdir(), 'portos-ffmpeg-rollback-'));
const target = join(root, 'video.mp4');
const missing = join(root, 'missing.mp4');
beforeEach(async () => {
  failRestore = false; failInitialMove = false;
  await writeFile(target, 'original');
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('Windows encoded video rollback admission', () => {
  it('retains the original and durable owner when install and restore both fail', async () => {
    failRestore = true;
    try {
      await expect(withBackupAssetPublication(() => installEncodedVideo(missing, target, 'mux'))).rejects.toMatchObject({ backupPublicationUncertain: true });
      const original = (await readdir(root)).find(name => name.includes('.bak.'));
      expect(await readFile(join(root, original), 'utf8')).toBe('original');
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(acquireBackupSnapshotCut({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY', blockers: [expect.objectContaining({ uncertain: true })] });
    } finally {
      for (const owner of backupPublicationAdmissionStatus().publications) await rm(owner.path, { recursive: true, force: true });
    }
  });

  it.each([false, true])('releases admission when original remains coherent (initial move failure=%s)', async initial => {
    failInitialMove = initial;
    expect((await withBackupAssetPublication(() => installEncodedVideo(missing, target, 'mux'))).ok).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('original');
    const release = await acquireBackupSnapshotCut({ timeoutMs: 10 });
    release();
  });
});
