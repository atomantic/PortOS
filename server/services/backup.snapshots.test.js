/** Backup service suite: excludes, snapshot listing/deletion/streaming, dumpPostgres status, manifest generation, the subdirFilter guard and backup state persistence. Shared mocks and helpers live in backup.test.fixture.js (#16215). */
import { testDataRoot, machineHost, fakeProc, flush, overridable, nonOverridable, assertPoolToolSpawn, COMPLETE_DUMP } from './backup.test.fixture.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReadStream, existsSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join as joinPath, join, resolve } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { spawn } from '../lib/childProcess.js';
import { checkHealth, getServerMajorVersion } from '../lib/db.js';
import { getBackendName } from './memoryBackend.js';
import * as fs from 'fs/promises';
import { reloadSettings } from './settings.js';
import { invalidateAllCaches as invalidateBrainCaches } from './brainStorage.js';
import { DEFAULT_EXCLUDES, computeEffectiveExcludes, listSnapshots, openSnapshotStream, restoreSnapshot, resolveRsyncBinary, deleteSnapshot } from './backup.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { EXCLUDE_PATTERN_MAX_LENGTH, anchorUserExclude, anchorUserExcludes, isSafeExcludePattern } from '../lib/sharedSchemas.js';

describe('DEFAULT_EXCLUDES anchoring', () => {
  // These are rsync FILTER patterns, not globs: an unanchored pattern matches at
  // ANY depth, so `model.obj` would drop a file of that name anywhere under data/.
  // That is a silent data-loss bug rather than a style nit, which is why it gets a
  // test rather than a convention.
  it('excludes disposable Autofixer repair worktrees', () => {
    expect(DEFAULT_EXCLUDES.map((e) => e.path)).toContain('/autofixer/worktrees/');
  });

  it('anchors every default exclude at the data root', () => {
    const unanchored = DEFAULT_EXCLUDES.filter((e) => !e.path.startsWith('/'));
    expect(unanchored.map((e) => e.path)).toEqual([]);
  });

  it('gives every default exclude a reason a user can act on', () => {
    // The reason string is surfaced in the backup UI; a blank one makes an
    // overridable exclude undecidable for whoever is looking at the toggle.
    for (const entry of DEFAULT_EXCLUDES) {
      expect(entry.reason, entry.path).toBeTruthy();
      expect(typeof entry.overridable, entry.path).toBe('boolean');
    }
  });

  it('excludes the TRELLIS.2 full-resolution mesh sidecar, overridably', () => {
    // ~1 GB per render of a file PortOS never serves. Overridable because it is
    // the only copy of the geometry the bake decimation discards.
    const entry = DEFAULT_EXCLUDES.find((e) => e.path === '/image-to-3d/*/model.obj');
    expect(entry).toBeDefined();
    expect(entry.overridable).toBe(true);
    // Scoped to the sidecar only — the served GLB and keyed source stay backed up.
    const paths = DEFAULT_EXCLUDES.map((e) => e.path);
    expect(paths).not.toContain('/image-to-3d/');
    expect(paths.some((x) => x.includes('model.glb'))).toBe(false);
  });
});

describe('deployed LoRA backup recovery', () => {
  it('restores selected adapter bytes while excluding both runtimes checkpoints and honoring custom filters', async context => {
    if (process.platform === 'win32' && spawnSync('rsync', ['--version']).error?.code === 'ENOENT') {
      context.skip('Windows runner has no rsync executable; real rsync remains required on Linux/macOS.');
    }
    const root = await fs.mkdtemp(joinPath(tmpdir(), 'portos-lora-backup-'));
    const source = joinPath(root, 'source');
    const snapshot = joinPath(root, 'snapshot');
    const restored = joinPath(root, 'restored');
    const customSnapshot = joinPath(root, 'custom');
    const selected = Buffer.from('selected checkpoint step 250');
    const final = Buffer.from('different final checkpoint step 500');
    const sidecar = JSON.stringify({ name: 'Example trained adapter', step: 250 });
    const files = {
      'loras/selected.safetensors': selected,
      'loras/selected.metadata.json': sidecar,
      'training-runs/torch-run/checkpoints/step-250.safetensors': selected,
      'training-runs/mflux-run/mflux/checkpoints/step-250.safetensors': selected,
      'training-runs/torch-run/final.safetensors': final,
    };
    try {
      for (const [relative, bytes] of Object.entries(files)) {
        const file = joinPath(source, relative);
        await fs.mkdir(joinPath(file, '..'), { recursive: true });
        await fs.writeFile(file, bytes);
      }
      for (const dest of [snapshot, restored, customSnapshot]) await fs.mkdir(dest);
      // A legacy disabled default is accepted without rewriting settings; it
      // cannot resurrect the removed exclusion or disable checkpoint filtering.
      const legacy = ['/loras/*.safetensors'];
      const copy = (from, to, excludes = []) => {
        const result = spawnSync(resolveRsyncBinary(), ['-a', ...excludes.flatMap(path => ['--exclude', path]), `${from}/`, `${to}/`], { encoding: 'utf8' });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      };
      copy(source, snapshot, computeEffectiveExcludes({ disabledDefaultExcludes: legacy }));
      copy(snapshot, restored);
      expect(await fs.readFile(joinPath(restored, 'loras/selected.safetensors'))).toEqual(selected);
      expect(await fs.readFile(joinPath(restored, 'loras/selected.metadata.json'), 'utf8')).toBe(sidecar);
      expect(await fs.readFile(joinPath(restored, 'training-runs/torch-run/final.safetensors'))).toEqual(final);
      for (const path of ['training-runs/torch-run/checkpoints', 'training-runs/mflux-run/mflux/checkpoints']) {
        expect(existsSync(joinPath(restored, path))).toBe(false);
      }
      const custom = ['/loras/*.safetensors'];
      copy(source, customSnapshot, computeEffectiveExcludes({ excludePaths: custom, disabledDefaultExcludes: legacy }));
      expect(existsSync(joinPath(customSnapshot, 'loras/selected.safetensors'))).toBe(false);
      expect(await fs.readFile(joinPath(customSnapshot, 'loras/selected.metadata.json'), 'utf8')).toBe(sidecar);
      expect(custom).toEqual(['/loras/*.safetensors']);
      expect(legacy).toEqual(['/loras/*.safetensors']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('computeEffectiveExcludes', () => {
  it('includes every DEFAULT_EXCLUDES path when nothing is disabled', () => {
    const result = computeEffectiveExcludes({ excludePaths: [], disabledDefaultExcludes: [] });
    for (const path of DEFAULT_EXCLUDES.map(e => e.path)) {
      expect(result).toContain(path);
    }
  });

  it('honors disabling an overridable default', () => {
    const target = overridable[0];
    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: [target]
    });
    expect(result).not.toContain(target);
  });

  it('keeps Beeper download partials excluded when the attachment mirror is re-enabled', () => {
    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: ['/beeper/attachments/']
    });
    expect(result).not.toContain('/beeper/attachments/');
    expect(result).toContain('/beeper/attachments/.tmp/');
  });

  it('ignores attempts to disable a non-overridable default', () => {
    const target = nonOverridable[0];
    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: [target]
    });
    expect(result).toContain(target);
  });

  it('merges user excludePaths on top of active defaults, anchored to the data root', () => {
    const result = computeEffectiveExcludes({
      excludePaths: ['my/custom/path', 'cache/'],
      disabledDefaultExcludes: []
    });
    // Anchored: a bare `cache/` is rsync for "every cache/ at any depth", which
    // would also drop training-runs/*/cache/ and friends (#7241).
    expect(result).toContain('/my/custom/path');
    expect(result).toContain('/cache/');
    expect(result).not.toContain('my/custom/path');
    expect(result).not.toContain('cache/');
  });

  it('anchors every returned pattern unless it is deliberately wildcard-led', () => {
    const result = computeEffectiveExcludes({
      excludePaths: ['repos/', 'cache', '**/raw/', '/already/anchored'],
      disabledDefaultExcludes: []
    });
    expect(result).toEqual(expect.arrayContaining(['/repos/', '/cache', '**/raw/', '/already/anchored']));
    // The whole list — defaults included — is anchored or wildcard-led. This is
    // the invariant, not the four spellings above: an unanchored entry anywhere
    // in the list silently drops user data at any depth.
    for (const pattern of result) {
      expect(pattern.startsWith('/') || pattern.startsWith('*'), pattern).toBe(true);
    }
  });

  it('passes a **-led user pattern through unchanged', () => {
    // Any-depth matching stays available DELIBERATELY — it is just no longer
    // what a user gets by accident from typing a bare directory name.
    const result = computeEffectiveExcludes({
      excludePaths: ['**/node_modules/', '*.tmp'],
      disabledDefaultExcludes: []
    });
    expect(result).toContain('**/node_modules/');
    expect(result).toContain('*.tmp');
  });

  it('dedupes user patterns that differ only by anchoring or whitespace', () => {
    const result = computeEffectiveExcludes({
      excludePaths: ['repos/', '/repos/', '  repos/  '],
      disabledDefaultExcludes: []
    });
    expect(result.filter(p => p === '/repos/')).toHaveLength(1);
  });

  it('measures the length bound on the ANCHORED form, not the raw input', () => {
    // A 255-char relative pattern anchors to exactly 256 and survives; 256 would
    // anchor to 257. Bounding the RAW input instead would let the settings
    // boundary accept a chip that this normalizer then silently dropped, so the
    // snapshot would run without an exclude the UI had shown as saved.
    const fits = 'a'.repeat(EXCLUDE_PATTERN_MAX_LENGTH - 1);
    const overflows = 'a'.repeat(EXCLUDE_PATTERN_MAX_LENGTH);
    const result = computeEffectiveExcludes({ excludePaths: [fits, overflows], disabledDefaultExcludes: [] });
    expect(result).toContain(`/${fits}`);
    expect(result).not.toContain(`/${overflows}`);
    // An ALREADY-anchored pattern of exactly the max is untouched and kept.
    const anchoredMax = `/${'b'.repeat(EXCLUDE_PATTERN_MAX_LENGTH - 1)}`;
    expect(computeEffectiveExcludes({ excludePaths: [anchoredMax] })).toContain(anchoredMax);
    // The settings boundary agrees with the normalizer in both directions.
    expect(isSafeExcludePattern(fits)).toBe(true);
    expect(isSafeExcludePattern(overflows)).toBe(false);
    expect(isSafeExcludePattern(anchoredMax)).toBe(true);
  });

  // The Backup settings tab anchors a pattern as the user adds it, so the chip
  // they see is the filter that runs. A one-sided edit to either copy would put
  // the preview and the snapshot out of step silently — which is the whole
  // failure mode #7241 is about. The mirror is a dependency-free leaf, so
  // importing it here costs nothing.
  it('the client mirror applies the identical rule', async () => {
    const mirror = await import('../../client/src/lib/backupExcludes.js');
    const cases = ['repos/', 'cache', '**/raw/', '*.tmp', '/anchored', '  spaced/  ', '', '../../etc', 'a/../../b',
      'x'.repeat(EXCLUDE_PATTERN_MAX_LENGTH - 1), 'x'.repeat(EXCLUDE_PATTERN_MAX_LENGTH), `/${'x'.repeat(EXCLUDE_PATTERN_MAX_LENGTH - 1)}`];
    for (const input of cases) {
      expect(mirror.anchorUserExclude(input), input).toBe(anchorUserExclude(input));
      expect(mirror.isSafeExcludePattern(input), input).toBe(isSafeExcludePattern(input));
    }
    expect(mirror.anchorUserExcludes(cases)).toEqual(anchorUserExcludes(cases));
    expect(mirror.EXCLUDE_PATTERN_MAX_LENGTH).toBe(EXCLUDE_PATTERN_MAX_LENGTH);
  });

  it('drops a user pattern that tries to escape the data root', () => {
    // Defense in depth — the settings boundary rejects these, but a hand-edited
    // settings.json is read straight through by the scheduler.
    const result = computeEffectiveExcludes({
      excludePaths: ['../../etc/', 'a/../../b', 'ok/path'],
      disabledDefaultExcludes: []
    });
    expect(result).toContain('/ok/path');
    expect(result.some(p => p.includes('..'))).toBe(false);
  });

  it('dedupes when a user exclude matches an active default', () => {
    const target = overridable[0];
    const result = computeEffectiveExcludes({
      excludePaths: [target],
      disabledDefaultExcludes: []
    });
    expect(result.filter(p => p === target)).toHaveLength(1);
  });

  it('drops falsy entries from excludePaths', () => {
    const result = computeEffectiveExcludes({
      excludePaths: ['', null, undefined, 'real/path'],
      disabledDefaultExcludes: []
    });
    expect(result).toContain('/real/path');
    expect(result).not.toContain('');
    expect(result).not.toContain(null);
  });

  it('tolerates a non-array disabledDefaultExcludes without throwing', () => {
    // Simulates a hand-edited settings.json with bad shape — should not crash.
    expect(() => computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: 'loras/*.safetensors'
    })).not.toThrow();

    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: { bogus: true }
    });
    // Bogus value is ignored — all defaults stay active.
    for (const path of DEFAULT_EXCLUDES.map(e => e.path)) {
      expect(result).toContain(path);
    }
  });

  it('tolerates a non-array excludePaths without throwing', () => {
    expect(() => computeEffectiveExcludes({
      excludePaths: 'just/one/string',
      disabledDefaultExcludes: []
    })).not.toThrow();

    const result = computeEffectiveExcludes({
      excludePaths: null,
      disabledDefaultExcludes: []
    });
    // Null user list is treated as empty — only defaults remain.
    expect(result).toEqual(DEFAULT_EXCLUDES.map(e => e.path));
  });

  it('handles being called with no arguments (defensive)', () => {
    expect(() => computeEffectiveExcludes()).not.toThrow();
    const result = computeEffectiveExcludes();
    expect(result).toEqual(DEFAULT_EXCLUDES.map(e => e.path));
  });

  it('does NOT exclude legacy file→DB migration artifacts (they are the recovery source while a prune is blocked)', () => {
    // The boot-time prune deletes these on disk once the DB is authoritative;
    // excluding them from snapshots would strip the only recovery source during
    // a blocked (wiped/partial-restore) prune, while pg_dump captures the
    // incomplete DB. So none of these patterns may appear in the default set.
    const mustNotExclude = ['/*.imported', '/*.bak-034', '/*.migrated.json', '/writers-room/works/*/manifest.imported.json'];
    const paths = DEFAULT_EXCLUDES.map(e => e.path);
    for (const p of mustNotExclude) {
      expect(paths, `${p} must NOT be a default exclude`).not.toContain(p);
    }
  });
});

describe('listSnapshots', () => {
  beforeEach(() => vi.clearAllMocks());
  const dirent = (name, isDir) => ({ name, isDirectory: () => isDir });

  it('skips non-directory entries like .DS_Store (iCloud/Finder droppings)', async () => {
    // The backup target is commonly an iCloud folder; macOS drops a `.DS_Store`
    // FILE into every dir. It must not be treated as a snapshot id (reading
    // `<.DS_Store>/manifest.json` would throw ENOTDIR).
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(async (path) => {
      if (String(path) === joinPath('/dest', 'snapshots')) {
        return [dirent('.DS_Store', false), dirent(machineHost, true)];
      }
      return [
        dirent('.DS_Store', false),
        dirent('2026-06-08T15-18-34', true),
        dirent('2026-06-07T09-00-00', true),
      ];
    });
    vi.spyOn(fs, 'readFile').mockImplementation(async (p) => {
      if (String(p).includes('.DS_Store')) throw new Error('ENOTDIR — .DS_Store should never be read');
      return JSON.stringify({ generatedAt: '2026-06-08T00:00:00Z', fileCount: 10 });
    });
    const result = await listSnapshots('/dest');
    const ids = result.map(s => s.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('2026-06-08T15-18-34');
    expect(ids).not.toContain('.DS_Store');
    readdirSpy.mockRestore();
  });

  it('lists healthy snapshots alongside malformed or absent manifest timestamps', async () => {
    const generatedAt = [{ malformed: true }, ['2026-01-01'], 'not-a-date', null, '2026-01-05T00:00:00Z'];
    const ids = generatedAt.map((_, index) => `2026-01-0${index + 1}T00-00-00`);
    vi.spyOn(fs, 'readdir').mockImplementation(async path =>
      String(path) === joinPath('/dest', 'snapshots')
        ? [dirent(machineHost, true)]
        : ids.map(id => dirent(id, true)));
    vi.spyOn(fs, 'readFile').mockImplementation(async path =>
      JSON.stringify({ generatedAt: generatedAt[ids.indexOf(basename(dirname(String(path))))], fileCount: 0 }));

    const result = await listSnapshots('/dest');

    expect(result.map(({ id, createdAt }) => ({ id, createdAt }))).toEqual([
      { id: ids[4], createdAt: generatedAt[4] },
      ...ids.slice(0, 4).reverse().map(id => ({ id, createdAt: null })),
    ]);
  });

  it('discovers legacy and machine snapshots with collision-safe identities', async () => {
    const destRoot = await fs.mkdtemp(joinPath(tmpdir(), 'portos-backup-sources-'));
    const snapshotId = '2026-06-08T15-18-34';
    const legacyId = '2025-12-31T23-59-59';
    const roots = [
      joinPath(destRoot, 'snapshots', legacyId),
      joinPath(destRoot, 'snapshots', 'legacy', snapshotId),
      joinPath(destRoot, 'snapshots', 'previous-machine', snapshotId),
      joinPath(destRoot, 'snapshots', machineHost, snapshotId),
    ];
    try {
      await Promise.all(roots.map(root => fs.mkdir(joinPath(root, 'data'), { recursive: true })));
      await Promise.all(roots.map((root, index) => fs.writeFile(
        joinPath(root, 'manifest.json'),
        JSON.stringify({ generatedAt: `2026-01-0${index + 1}T00:00:00Z`, fileCount: index + 1 }),
      )));

      const result = await listSnapshots(destRoot);

      expect(result).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: legacyId,
          source: '@legacy',
          sourceLabel: 'Legacy (pre-namespace)',
          selectionKey: `@legacy/${legacyId}`,
        }),
        expect.objectContaining({
          id: snapshotId,
          source: 'legacy',
          selectionKey: `legacy/${snapshotId}`,
          currentMachine: false,
        }),
        expect.objectContaining({
          id: snapshotId,
          source: 'previous-machine',
          selectionKey: `previous-machine/${snapshotId}`,
          currentMachine: false,
        }),
        expect.objectContaining({
          id: snapshotId,
          source: machineHost,
          selectionKey: `${machineHost}/${snapshotId}`,
          currentMachine: true,
        }),
      ]));
      expect(new Set(result.map(snapshot => snapshot.selectionKey))).toHaveProperty('size', 4);
    } finally {
      await fs.rm(destRoot, { recursive: true, force: true });
    }
  });

  it.each(['EIO', 'EACCES'])('rejects root and namespace %s without exposing paths or returning partial data', async code => {
    const cause = Object.assign(new Error('private destination and machine'), { code });
    const spy = vi.spyOn(fs, 'readdir').mockRejectedValue(cause);
    await expect(listSnapshots('/dest')).rejects.toMatchObject({
      code: 'BACKUP_INVENTORY_UNAVAILABLE',
      message: `Backup inventory unavailable: read-snapshots-root (${code})`,
      context: { operation: 'read-snapshots-root', filesystemCode: code },
    });
    spy.mockImplementation(async path => {
      if (String(path) === joinPath('/dest', 'snapshots')) return [dirent('healthy', true), dirent('unreadable', true)];
      if (String(path).endsWith('unreadable')) throw cause;
      return [dirent('2026-06-08T15-18-34', true)];
    });
    await expect(listSnapshots('/dest')).rejects.toMatchObject({
      code: 'BACKUP_INVENTORY_UNAVAILABLE',
      message: `Backup inventory unavailable: read-namespace (${code})`,
    });
    spy.mockRestore();
  });

  it('accepts missing snapshots only under a readable destination', async () => {
    const missing = Object.assign(new Error('private path'), { code: 'ENOENT' });
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(async path => {
      if (String(path) === '/dest') return [];
      throw missing;
    });
    expect(await listSnapshots('/dest')).toEqual([]);
    spy.mockRejectedValue(missing);
    await expect(listSnapshots('/dest')).rejects.toMatchObject({
      code: 'BACKUP_INVENTORY_UNAVAILABLE',
      context: { operation: 'read-destination', filesystemCode: 'ENOENT' },
    });
    spy.mockRestore();
  });

  it('skips a namespace removed during enumeration', async () => {
    const spy = vi.spyOn(fs, 'readdir').mockResolvedValueOnce([dirent('disappeared', true)])
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await listSnapshots('/dest')).toEqual([]);
    spy.mockRestore();
  });

  it('returns [] for a falsy destPath without touching the filesystem', async () => {
    const readdirSpy = vi.spyOn(fs, 'readdir');
    expect(await listSnapshots('')).toEqual([]);
    expect(readdirSpy).not.toHaveBeenCalled();
  });
});

describe('deleteSnapshot', () => {
  let destRoot;

  beforeEach(async () => {
    destRoot = await fs.mkdtemp(joinPath(tmpdir(), 'portos-backup-delete-'));
  });

  afterEach(async () => {
    await fs.rm(destRoot, { recursive: true, force: true });
  });

  async function makeSnapshot(source, id, { marker, markerContent = '' } = {}) {
    const dir = joinPath(destRoot, 'snapshots', source, id);
    await fs.mkdir(joinPath(dir, 'data'), { recursive: true });
    await fs.writeFile(joinPath(dir, 'manifest.json'), JSON.stringify({ generatedAt: '2026-01-01T00:00:00Z', fileCount: 0 }));
    if (marker) await fs.writeFile(joinPath(dir, marker), markerContent);
    return dir;
  }

  it('removes exactly the selected source/ID pair, leaving a same-ID snapshot on another source untouched', async () => {
    const targetDir = await makeSnapshot(machineHost, '2026-06-08T15-18-34');
    const siblingDir = await makeSnapshot('previous-machine', '2026-06-08T15-18-34');

    const result = await deleteSnapshot(destRoot, '2026-06-08T15-18-34', { source: machineHost });

    expect(result).toEqual({ deleted: true, snapshotId: '2026-06-08T15-18-34', source: machineHost });
    await expect(fs.stat(targetDir)).rejects.toThrow();
    await expect(fs.stat(siblingDir)).resolves.toBeDefined();
  });

  it('defaults to the current machine when source is omitted', async () => {
    const targetDir = await makeSnapshot(machineHost, '2026-06-08T15-18-34');
    await deleteSnapshot(destRoot, '2026-06-08T15-18-34');
    await expect(fs.stat(targetDir)).rejects.toThrow();
  });

  it('404s for a snapshot that does not exist, without touching the disk', async () => {
    await expect(deleteSnapshot(destRoot, '2026-06-08T15-18-34', { source: machineHost }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  // Only the server process runs runBackup, so in this machine's namespace an
  // in-progress marker another process wrote (or the legacy empty one) is a
  // run that a restart killed (#12618).
  it.each([
    ['the legacy empty marker', ''],
    ['another process token', 'previous-process-token'],
  ])('reports a dead run left by %s as interrupted: never restorable or downloadable, but deletable', async (_label, markerContent) => {
    const id = '2026-06-08T15-18-34';
    const dir = await makeSnapshot(machineHost, id, { marker: '.in-progress', markerContent });

    const [snapshot] = await listSnapshots(destRoot);
    expect(snapshot).toMatchObject({ id, incomplete: false, failed: false, interrupted: true });
    await expect(openSnapshotStream(destRoot, id, { source: machineHost }))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INTERRUPTED' });
    await expect(restoreSnapshot(destRoot, id, { source: machineHost, dryRun: true }))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INTERRUPTED' });

    await deleteSnapshot(destRoot, id, { source: machineHost });
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("keeps another machine's in-progress snapshot incomplete (409 SNAPSHOT_INCOMPLETE), leaving it on disk", async () => {
    const dir = await makeSnapshot('previous-machine', '2026-06-08T15-18-34', { marker: '.in-progress' });
    const [snapshot] = await listSnapshots(destRoot);
    expect(snapshot).toMatchObject({ incomplete: true, interrupted: false });
    await expect(deleteSnapshot(destRoot, '2026-06-08T15-18-34', { source: 'previous-machine' }))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it('allows deleting a failed snapshot — unlike restore, deletion has no reason to require success', async () => {
    const dir = await makeSnapshot(machineHost, '2026-06-08T15-18-34', { marker: '.failed' });
    await deleteSnapshot(destRoot, '2026-06-08T15-18-34', { source: machineHost });
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it('rejects an explicitly selected source namespace that is a symbolic link', async () => {
    const outsideRoot = await fs.mkdtemp(joinPath(tmpdir(), 'portos-backup-delete-outside-'));
    try {
      await makeSnapshot('evil', '2026-06-08T15-18-34');
      await fs.rm(joinPath(destRoot, 'snapshots', 'evil'), { recursive: true, force: true });
      await fs.symlink(outsideRoot, joinPath(destRoot, 'snapshots', 'evil'), 'dir');
      await expect(deleteSnapshot(destRoot, '2026-06-08T15-18-34', { source: 'evil' }))
        .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe('openSnapshotStream', () => {
  afterEach(async () => {
    const actual = await vi.importActual('fs/promises');
    fs.stat.mockImplementation(actual.stat);
    fs.access.mockImplementation(actual.access);
    spawn.mockReset();
  });

  beforeEach(() => {
    fs.access.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  });

  // An existing, COMPLETE snapshot directory, ready for tar: the directory stats
  // fine while the .in-progress marker is absent.
  function readySnapshot() {
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.access.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    return proc;
  }

  // Same directory, but an in-progress marker whose owner cannot be read: it
  // is never presumed dead, so it stays incomplete.
  function unreadableMarkerSnapshot() {
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.access.mockImplementation((path) => String(path).endsWith('.failed')
      ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      : Promise.resolve());                             // .in-progress present
    fs.readFile.mockRejectedValue(Object.assign(new Error('unreadable'), { code: 'EIO' }));
  }

  const ended = (stream) => new Promise((resolveEnd) => stream.once('end', resolveEnd));
  const errored = (stream) => new Promise((resolveError) => stream.once('error', resolveError));

  it.each([
    ['a slash', 'snap/id'],
    ['a wildcard', 'snap*id'],
    ['a traversal id', '..'],
  ])('rejects %s before touching the disk or spawning tar', async (_label, snapshotId) => {
    await expect(openSnapshotStream('/dest', snapshotId))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it('rejects a traversing source before touching the disk or spawning tar', async () => {
    await expect(openSnapshotStream('/dest', 'snap-1', { source: '../other-machine' }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it('rejects an explicitly selected source namespace that is a symbolic link', async () => {
    const destRoot = await fs.mkdtemp(joinPath(tmpdir(), 'portos-backup-source-link-'));
    const outsideRoot = await fs.mkdtemp(joinPath(tmpdir(), 'portos-backup-source-outside-'));
    try {
      await fs.mkdir(joinPath(destRoot, 'snapshots'), { recursive: true });
      await fs.mkdir(joinPath(outsideRoot, 'snap-1'), { recursive: true });
      await fs.symlink(outsideRoot, joinPath(destRoot, 'snapshots', 'previous-machine'));

      await expect(openSnapshotStream(destRoot, 'snap-1', { source: 'previous-machine' }))
        .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
      expect(spawn).not.toHaveBeenCalled();
      expect(fs.stat).not.toHaveBeenCalled();
    } finally {
      await fs.rm(destRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('refuses a snapshot whose .in-progress marker owner cannot be read', async () => {
    unreadableMarkerSnapshot();

    await expect(openSnapshotStream('/dest', 'snap-1'))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown snapshot without spawning tar', async () => {
    fs.stat.mockRejectedValue(new Error('ENOENT'));

    await expect(openSnapshotStream('/dest', 'snap-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns tar with the snapshot directory as its archive root', async () => {
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'snap-1');

    expect(spawn).toHaveBeenCalledWith(
      'tar',
      ['-czf', '-', '-C', resolve(join('/dest', 'snapshots', machineHost)), 'snap-1'],
      { shell: false },
    );
    const done = ended(stream);
    stream.resume();
    proc.emit('close', 0);
    await expect(done).resolves.toBeUndefined();
  });

  it('archives an explicitly selected previous-machine snapshot', async () => {
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'snap-1', { source: 'previous-machine' });

    expect(spawn).toHaveBeenCalledWith(
      'tar',
      ['-czf', '-', '-C', resolve(join('/dest', 'snapshots', 'previous-machine')), 'snap-1'],
      { shell: false },
    );
    const done = ended(stream);
    stream.resume();
    proc.emit('close', 0);
    await expect(done).resolves.toBeUndefined();
  });

  it('archives a legacy pre-manifest snapshot without consulting a manifest', async () => {
    // listSnapshots deliberately keeps snapshots taken before manifests existed,
    // so a missing manifest.json must never gate the download.
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'legacy-snapshot', { source: '@legacy' });

    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.stat.mock.calls.flat().join(' ')).not.toContain('manifest.json');
    expect(spawn).toHaveBeenCalledWith(
      'tar',
      ['-czf', '-', '-C', resolve(join('/dest', 'snapshots')), 'legacy-snapshot'],
      { shell: false },
    );
    const done = ended(stream);
    stream.resume();
    proc.emit('close', 0);
    await expect(done).resolves.toBeUndefined();
  });

  it('fails the archive stream when tar exits unsuccessfully, reporting its stderr', async () => {
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'snap-1');
    const failed = errored(stream);
    proc.stderr.emit('data', Buffer.from('tar: Permission denied'));
    proc.emit('close', 2);

    await expect(failed).resolves.toMatchObject({
      message: 'tar exited with code 2: tar: Permission denied',
    });
  });

  it('escalates the kill when the response disconnects', async () => {
    vi.useFakeTimers();
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'snap-1');
    const failed = errored(stream);
    stream.abort();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    // A tar wedged on a stalled mount ignores SIGTERM. The escalation must still
    // fire after the grace window — it is gated on the CHILD's exit state, not on
    // the archive stream's, which abort() has already settled by this point.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();

    await expect(failed).resolves.toMatchObject({ message: 'Snapshot download aborted: snap-1' });
    // The killed child closes, ending its hold on the snapshot (#10898).
    proc.emit('close', null, 'SIGKILL');
  });

  it('holds the snapshot against deletion until tar closes, even after the download aborts (#10898)', async () => {
    const proc = readySnapshot();
    const stream = await openSnapshotStream('/dest', 'snap-1');
    stream.on('error', () => {});

    await expect(deleteSnapshot('/dest', 'snap-1', { source: machineHost }))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_IN_USE' });
    // The response is gone but tar may still be reading the snapshot.
    stream.abort();
    await expect(deleteSnapshot('/dest', 'snap-1'))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_IN_USE' });

    proc.exitCode = 143;
    proc.emit('close', null, 'SIGTERM');
    // Past the lease, deletion reaches its own existence check.
    fs.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(deleteSnapshot('/dest', 'snap-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('releases the snapshot when tar cannot be spawned (#10898)', async () => {
    const proc = readySnapshot();
    const stream = await openSnapshotStream('/dest', 'snap-1');
    const failed = errored(stream);
    proc.emit('error', Object.assign(new Error('spawn tar ENOENT'), { code: 'ENOENT' }));
    await expect(failed).resolves.toMatchObject({ code: 'ENOENT' });

    fs.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(deleteSnapshot('/dest', 'snap-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('does not escalate once tar has already exited', async () => {
    vi.useFakeTimers();
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'snap-1');
    stream.on('error', () => {});
    proc.exitCode = 0;
    stream.abort();

    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(proc.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
    proc.emit('close', 0);
  });

  it('terminates a silent tar at the wall-time deadline without an idle kill and holds the read lease until close', async () => {
    vi.useFakeTimers();
    try {
      const proc = readySnapshot();
      const stream = await openSnapshotStream('/dest', 'snap-1');
      const failed = errored(stream);

      // Browser backpressure can leave tar silent well past the 10-minute idle
      // window; only the 4-hour wall ceiling should terminate the download.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(proc.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000 + 30 * 60 * 1000);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      // Escalate to SIGKILL if the child is wedged on a stalled mount.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

      // Deletion remains blocked until the child actually closes.
      await expect(deleteSnapshot('/dest', 'snap-1', { source: machineHost }))
        .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_IN_USE' });

      proc.emit('close', null, 'SIGKILL');
      await expect(failed).resolves.toMatchObject({
        code: 'BACKUP_PROCESS_TIMEOUT',
        message: expect.stringMatching(/4 hours/),
      });

      fs.stat.mockResolvedValue({ isDirectory: () => false });
      await expect(deleteSnapshot('/dest', 'snap-1'))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the wall-time deadline when tar exits normally, errors, or aborts', async () => {
    vi.useFakeTimers();
    try {
      const normalProc = readySnapshot();
      const normalStream = await openSnapshotStream('/dest', 'snap-1');
      const normalDone = ended(normalStream);
      normalStream.resume();
      normalProc.emit('close', 0);
      await expect(normalDone).resolves.toBeUndefined();

      const errorProc = readySnapshot();
      const errorStream = await openSnapshotStream('/dest', 'snap-1');
      const errorFailed = errored(errorStream);
      errorProc.emit('close', 2);
      await expect(errorFailed).resolves.toMatchObject({ message: 'tar exited with code 2' });

      const abortedProc = readySnapshot();
      const abortedStream = await openSnapshotStream('/dest', 'snap-1');
      const abortFailed = errored(abortedStream);
      abortedStream.abort();
      await expect(abortFailed).resolves.toMatchObject({ message: 'Snapshot download aborted: snap-1' });
      abortedProc.kill.mockClear();
      abortedProc.signalCode = 'SIGTERM';
      abortedProc.emit('close', null, 'SIGTERM');

      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 10_000);
      expect(normalProc.kill).not.toHaveBeenCalled();
      expect(errorProc.kill).not.toHaveBeenCalled();
      expect(abortedProc.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dumpPostgres status classification', () => {
  let dumpPostgres;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ dumpPostgres } = await import('./backup.js'));
  });

  it('returns skipped/not_configured when PG is down and the backend resolved to file (escape hatch)', async () => {
    const prev = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    getBackendName.mockReturnValue('file'); // dev/test escape hatch resolved to file
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(spawn).not.toHaveBeenCalled();
    getBackendName.mockReturnValue(null);
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns failed/pg_unreachable when PG is down, env unset, and backend not yet initialized (null)', async () => {
    // Post-mandatory-Postgres contract: a default install whose memory backend
    // hasn't initialized yet (getBackendName() === null) still REQUIRES Postgres.
    // A DB outage before the first memory access must degrade the backup, not
    // read as a benign "not configured" skip.
    const prev = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    getBackendName.mockReturnValue(null);
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false, error: 'ECONNREFUSED' });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_unreachable');
    expect(spawn).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns failed/pg_unreachable when PG is required (MEMORY_BACKEND=postgres) but down', async () => {
    const prev = process.env.MEMORY_BACKEND;
    process.env.MEMORY_BACKEND = 'postgres';
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false, error: 'ECONNREFUSED' });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_unreachable');
    expect(spawn).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns failed/pg_unreachable when PG was auto-detected (MEMORY_BACKEND unset) but is down at backup time', async () => {
    // Regression: in the common default config PortOS auto-detects Postgres as
    // the active backend at startup. A later DB outage must degrade the backup,
    // not read as a benign "not configured" skip — otherwise a green backup
    // silently omits everything that lives in Postgres.
    const prev = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    getBackendName.mockReturnValue('postgres'); // resolved backend at startup
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false, error: 'ECONNREFUSED' });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_unreachable');
    expect(spawn).not.toHaveBeenCalled();
    getBackendName.mockReturnValue(null);
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns skipped/not_configured in explicit file mode even if a stale backend name says postgres', async () => {
    const prev = process.env.MEMORY_BACKEND;
    process.env.MEMORY_BACKEND = 'file';
    getBackendName.mockReturnValue('postgres'); // must be ignored — file is explicit
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(spawn).not.toHaveBeenCalled();
    getBackendName.mockReturnValue(null);
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns failed/pg_unreachable when connected but schema missing and PG required', async () => {
    // Post-mandatory-Postgres: a reachable-but-uninitialized DB on a non-file
    // install is a real backup failure (required schema/data not capturable),
    // not a benign skip.
    getBackendName.mockReturnValue(null);
    checkHealth.mockResolvedValue({ connected: true, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_unreachable');
  });

  it('returns skipped/not_configured when connected but no schema in file escape-hatch mode', async () => {
    const prev = process.env.MEMORY_BACKEND;
    process.env.MEMORY_BACKEND = 'file';
    checkHealth.mockResolvedValue({ connected: true, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('not_configured');
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('dumps the checked pool endpoint despite changed credentials and poisoned libpq settings', async () => {
    for (const key of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGSSLMODE']) vi.stubEnv(key, 'poisoned');
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096 });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    createReadStream.mockImplementation(() => Readable.from([Buffer.from(COMPLETE_DUMP)]));
    const result = dumpPostgres('/tmp/example.sql');
    await flush();
    assertPoolToolSpawn(spawn.mock.calls[0]);
    expect(spawn.mock.calls[0][1]).toContain('--exclude-table-data=media_assets');
    proc.emit('close', 0);
    expect(await result).toMatchObject({ status: 'ok' });
    vi.unstubAllEnvs();
  });

  it('returns failed/pg_dump_missing when spawn errors', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.emit('error', new Error('spawn pg_dump ENOENT'));
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_dump_missing');
  });

  it('returns failed/dump_error on non-zero exit', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.stderr.emit('data', Buffer.from('FATAL: auth failed'));
    proc.emit('close', 1);
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('dump_error');
    expect(result.error).toContain('auth failed');
  });

  it('honors the PORTOS_PGDUMP override outright, even when the server version is known', async () => {
    // Escape hatch: an explicit override must win over auto-discovery's
    // closest-major selection, not be funneled through it (a known server
    // version triggers resolvePgDump, which is where the override short-circuits).
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    getServerMajorVersion.mockResolvedValue(17);
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 2048 });
    createReadStream.mockImplementation(() => Readable.from([Buffer.from(COMPLETE_DUMP)]));
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    process.env.PORTOS_PGDUMP = '/custom/bin/pg_dump';
    try {
      const p = dumpPostgres('/tmp/x.sql');
      await flush();
      proc.emit('close', 0);
      await p;
      expect(spawn).toHaveBeenCalledWith('/custom/bin/pg_dump', expect.arrayContaining(['--no-comments']), expect.any(Object));
    } finally {
      delete process.env.PORTOS_PGDUMP;
      // clearAllMocks() doesn't reset implementations — restore the null default
      // so later tests keep the bare-pg_dump path (no live binary discovery).
      getServerMajorVersion.mockResolvedValue(null);
    }
  });

  it('honors the PORTOS_PGDUMP override even when the server version is unknown (detection failed)', async () => {
    // The override is the documented escape hatch for exactly this case — when
    // getServerMajorVersion() returns null, dumpPostgres must still use the
    // override instead of falling back to bare pg_dump.
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    getServerMajorVersion.mockResolvedValue(null);
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 2048 });
    createReadStream.mockImplementation(() => Readable.from([Buffer.from(COMPLETE_DUMP)]));
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    process.env.PORTOS_PGDUMP = '/custom/bin/pg_dump';
    try {
      const p = dumpPostgres('/tmp/x.sql');
      await flush();
      proc.emit('close', 0);
      await p;
      expect(spawn).toHaveBeenCalledWith('/custom/bin/pg_dump', expect.any(Array), expect.any(Object));
    } finally {
      delete process.env.PORTOS_PGDUMP;
    }
  });

  it('classifies a "server version mismatch" stderr as failed/version_mismatch, not dump_error', async () => {
    // Even with the server version unknown (default mock → bare pg_dump), the
    // stderr regex must reclassify pg_dump's own mismatch error so the UI can
    // point at "install a newer pg_dump" instead of the generic hint.
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.stderr.emit('data', Buffer.from(
      'pg_dump: error: aborting because of server version mismatch\n' +
      'pg_dump: detail: server version: 17.10; pg_dump version: 15.18'
    ));
    proc.emit('close', 1);
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('version_mismatch');
    expect(result.error).toContain('server version mismatch');
  });

  it('unlinks the partial dump file on non-zero exit (no restorable artifact left behind)', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.emit('close', 1);
    await p;
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/x.sql');
  });

  it('kills a stalled pg_dump and removes its partial SQL file', async () => {
    vi.useFakeTimers();
    try {
      checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
      vi.spyOn(fs, 'stat').mockResolvedValue({ size: 0 });
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue();
      const proc = fakeProc();
      spawn.mockReturnValue(proc);

      const pending = dumpPostgres('/tmp/x.sql');
      await flush();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(8 * 1000);
      expect(proc.kill).toHaveBeenLastCalledWith('SIGKILL');
      proc.emit('close', null, 'SIGTERM');
      await expect(pending).resolves.toMatchObject({
        status: 'failed',
        reason: 'timeout',
        error: expect.stringMatching(/10 minutes without progress/),
      });
      expect(unlinkSpy).toHaveBeenCalledWith('/tmp/x.sql');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a growing pg_dump output file as progress beyond ten minutes', async () => {
    vi.useFakeTimers();
    try {
      checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
      let dumpSize = 0;
      vi.spyOn(fs, 'stat').mockImplementation(async () => ({ size: dumpSize }));
      createReadStream.mockImplementation(() => Readable.from([Buffer.from(COMPLETE_DUMP)]));
      const proc = fakeProc();
      spawn.mockReturnValue(proc);

      const pending = dumpPostgres('/tmp/x.sql');
      await flush();
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
      dumpSize = 2048;
      await vi.advanceTimersByTimeAsync(30 * 1000);
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);

      expect(proc.kill).not.toHaveBeenCalled();
      proc.emit('close', 0);
      await expect(pending).resolves.toMatchObject({ status: 'ok', sizeBytes: 2048 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns failed/empty_dump when exit 0 but file is 0 bytes', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 0 });
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.emit('close', 0);
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('empty_dump');
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/x.sql');
  });

  it('returns ok with streamed sizeBytes and tableCount on a good dump', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 2048 });
    const readFileSpy = vi.spyOn(fs, 'readFile');
    createReadStream.mockImplementation(() => Readable.from([Buffer.from(COMPLETE_DUMP)]));
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.emit('close', 0);
    const result = await p;
    expect(result).toMatchObject({ status: 'ok', sizeBytes: 2048, tableCount: 2 });
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('settles failed/inspect_error when streaming the dump fails', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 2048 });
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue();
    createReadStream.mockImplementation(() => new Readable({
      read() { this.destroy(Object.assign(new Error('boom'), { code: 'EIO' })); }
    }));
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.emit('close', 0);
    await expect(p).resolves.toMatchObject({ status: 'failed', reason: 'inspect_error' });
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/x.sql');
  });
});

describe('runBackup pg status propagation', () => {
  let _backup;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('maps dumpPostgres failed -> overall status degraded', async () => {
    const { backupStatusForPg } = await import('./backup.js');
    expect(backupStatusForPg({ status: 'failed', reason: 'dump_error' })).toBe('degraded');
  });

  it('maps dumpPostgres skipped -> overall status ok', async () => {
    const { backupStatusForPg } = await import('./backup.js');
    expect(backupStatusForPg({ status: 'skipped', reason: 'not_configured' })).toBe('ok');
  });

  it('maps dumpPostgres ok -> overall status ok', async () => {
    const { backupStatusForPg } = await import('./backup.js');
    expect(backupStatusForPg({ status: 'ok', sizeBytes: 10, tableCount: 1 })).toBe('ok');
  });
});

describe('generateManifest', () => {
  // Regression: the manifest write used a bare `writeFile` that was never
  // imported, so every real backup threw `writeFile is not defined` at the
  // very end of generateManifest. This exercises the actual write path
  // (atomicWrite) end-to-end against a real temp dir so a missing import
  // can never silently reappear.
  let tmpRoot;
  beforeEach(async () => {
    // Earlier suites install persistent vi.spyOn(fs, 'readdir'/'stat') mocks
    // (e.g. stat → { isFile: () => true }). Those leak into these real-
    // filesystem tests, so restore the spies AND re-point the factory-level
    // stat/readFile wrappers back at the genuine implementations.
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const realFs = await vi.importActual('fs/promises');
    fs.stat.mockImplementation(realFs.stat);
    fs.readFile.mockImplementation(realFs.readFile);
    vi.resetModules();
    const { mkdtemp } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    tmpRoot = await mkdtemp(join(tmpdir(), 'portos-manifest-'));
  });

  afterEach(async () => {
    const { rm } = await import('fs/promises');
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes the manifest file and returns hashes for every data file', async () => {
    const { mkdir, writeFile, readFile } = await import('fs/promises');
    const { join } = await import('path');
    const dataDir = join(tmpRoot, 'data');
    await mkdir(join(dataDir, 'sub'), { recursive: true });
    await writeFile(join(dataDir, 'a.txt'), 'hello');
    await writeFile(join(dataDir, 'sub', 'b.txt'), 'world');

    const manifestPath = join(tmpRoot, 'manifest.json');
    const { generateManifest } = await import('./backup.js');
    const manifest = await generateManifest(dataDir, manifestPath);

    expect(manifest.fileCount).toBe(2);
    expect(manifest.files['a.txt']).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files[join('sub', 'b.txt')]).toMatch(/^[0-9a-f]{64}$/);

    // The file must actually be written (the regression was a write-time throw).
    const written = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(written).toEqual(manifest);
  });

  it('includes the parent-relative pg dump hash when a dump path is given', async () => {
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');
    const { mkdir } = await import('fs/promises');
    const dataDir = join(tmpRoot, 'data');
    await mkdir(dataDir, { recursive: true });
    const dumpPath = join(tmpRoot, 'portos-db.sql');
    await writeFile(dumpPath, 'PG DUMP');

    const { generateManifest } = await import('./backup.js');
    const manifest = await generateManifest(dataDir, join(tmpRoot, 'manifest.json'), dumpPath);

    expect(manifest.files['../portos-db.sql']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves dangling links without dropping hashes for readable link targets', async () => {
    const fsp = await vi.importActual('fs/promises');
    const dataDir = joinPath(tmpRoot, 'data');
    await fsp.mkdir(dataDir);
    await fsp.writeFile(joinPath(dataDir, 'example.txt'), 'example');
    await fsp.symlink('example.txt', joinPath(dataDir, 'readable-link'));
    await fsp.symlink('excluded.txt', joinPath(dataDir, 'dangling-link'));
    const { generateManifest } = await import('./backup.js');
    const manifest = await generateManifest(dataDir, joinPath(tmpRoot, 'manifest.json'));
    expect(manifest.fileCount).toBe(2);
    expect(manifest.files['readable-link']).toBe(manifest.files['example.txt']);
    expect(manifest.files).not.toHaveProperty('dangling-link');
    expect((await fsp.lstat(joinPath(dataDir, 'dangling-link'))).isSymbolicLink()).toBe(true);
  });

  it('records no OS metadata files in a new manifest', async () => {
    const fsp = await vi.importActual('fs/promises');
    const dataDir = joinPath(tmpRoot, 'data');
    await fsp.mkdir(joinPath(dataDir, 'images'), { recursive: true });
    await fsp.writeFile(joinPath(dataDir, 'images', 'example.png'), 'png');
    await fsp.writeFile(joinPath(dataDir, 'images', '.DS_Store'), 'finder');
    await fsp.writeFile(joinPath(dataDir, 'images', '._example.png'), 'appledouble');
    const { generateManifest } = await import('./backup.js');
    const manifest = await generateManifest(dataDir, joinPath(tmpRoot, 'manifest.json'));
    expect(Object.keys(manifest.files)).toEqual([joinPath('images', 'example.png')]);
    expect(manifest.fileCount).toBe(1);
  });
});

// restoreSnapshot's service-side subdirFilter guard (issue #1822). These reject
// BEFORE runRsync/spawn is reached, so no fake child process is needed — an
// invalid filter must never make it into an `--include=` rsync arg.
describe('restoreSnapshot subdirFilter guard', () => {
  it('refuses to begin a file restore while an update holds maintenance', async () => {
    const update = maintenance.deferredUpdate.request();
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    try {
      await expect(restoreSnapshot('/dest', 'snap-1', { dryRun: false }))
        .rejects.toMatchObject({ code: 'MAINTENANCE_HELD' });
    } finally { maintenance.deferredUpdate.finish(update.id, false); }
  });
  beforeEach(() => {
    spawn.mockReset();
  });

  it('rejects a wildcard filter before spawning rsync', async () => {
    await expect(restoreSnapshot('/dest', 'snap-1', { subdirFilter: '*' }))
      .rejects.toThrow(/Invalid subdirFilter/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a traversal filter before spawning rsync', async () => {
    await expect(restoreSnapshot('/dest', 'snap-1', { subdirFilter: '../escape' }))
      .rejects.toThrow(/Invalid subdirFilter/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects an absolute-path filter before spawning rsync', async () => {
    await expect(restoreSnapshot('/dest', 'snap-1', { subdirFilter: '/etc' }))
      .rejects.toThrow(/Invalid subdirFilter/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves complete restore preview paths across stdout byte boundaries', async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const restore = restoreSnapshot('/dest', 'snap-1');
    await flush();

    proc.stdout.emit('data', Buffer.from('>f+++++++++ example'));
    const tail = Buffer.from('-settings.json\ncd+++++++++ ignored/\n<f.st...... café.json');
    const split = tail.indexOf(Buffer.from('é')) + 1;
    proc.stdout.emit('data', tail.subarray(0, split));
    proc.stdout.emit('data', tail.subarray(split));
    proc.emit('close', 0);

    await expect(restore).resolves.toMatchObject({
      dryRun: true,
      changedFiles: ['>f+++++++++ example-settings.json', '<f.st...... café.json'],
    });
  });

  it('uses PORTOS_RSYNC when configured and keeps shell execution disabled', async () => {
    const previous = process.env.PORTOS_RSYNC;
    process.env.PORTOS_RSYNC = '/custom/bin/rsync';
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    try {
      const restore = restoreSnapshot('/dest', 'snap-1');
      await flush();
      proc.stdout.emit('data', Buffer.from('>f+++++++++ settings.json\n'));
      proc.emit('close', 0);

      await expect(restore).resolves.toMatchObject({
        dryRun: true,
        changedFiles: ['>f+++++++++ settings.json'],
      });
      expect(spawn).toHaveBeenCalledWith(
        '/custom/bin/rsync',
        expect.arrayContaining(['--archive', '--itemize-changes', '--progress', '--checksum', '--dry-run']),
        { shell: false },
      );
    } finally {
      if (previous === undefined) delete process.env.PORTOS_RSYNC;
      else process.env.PORTOS_RSYNC = previous;
    }
  });

  it('falls back to the PATH-resolved rsync command when no override is configured', async () => {
    const previous = process.env.PORTOS_RSYNC;
    delete process.env.PORTOS_RSYNC;
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    try {
      const restore = restoreSnapshot('/dest', 'snap-1');
      await flush();
      proc.emit('close', 0);
      await restore;

      expect(spawn.mock.calls[0][0]).toBe('rsync');
      expect(spawn.mock.calls[0][2]).toEqual({ shell: false });
    } finally {
      if (previous === undefined) delete process.env.PORTOS_RSYNC;
      else process.env.PORTOS_RSYNC = previous;
    }
  });

  it('warns that a timed-out live file restore may have overwritten files', async () => {
    vi.useFakeTimers();
    try {
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      await flush();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      proc.emit('close', null, 'SIGTERM');

      await expect(pending).rejects.toThrow(/files may already have been overwritten/i);
      expect(reloadSettings).toHaveBeenCalledTimes(1);
      expect(invalidateBrainCaches).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps active rsync work past ten minutes but enforces the four-hour ceiling', async () => {
    vi.useFakeTimers();
    try {
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1');
      await flush();

      // Progress every nine minutes continually resets the idle deadline. The
      // final six-minute step crosses the independent four-hour backstop.
      for (let elapsedMinutes = 0; elapsedMinutes < 234; elapsedMinutes += 9) {
        await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
        proc.stdout.emit('data', Buffer.from('>f.st...... still-working.json\n'));
        expect(proc.kill).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      proc.emit('close', null, 'SIGTERM');
      await expect(pending).rejects.toThrow(/4 hours/);
    } finally {
      vi.useRealTimers();
    }
  });
});

// getState / saveState — the persisted `data/backup/state.json` read-merge-write
// cycle (issue #3916). Runs against a real temp dir with `PATHS.data` re-pointed,
// so the assertions cover the ACTUAL bytes on disk (real readJSONFile +
// atomicWrite), not a mocked persistence layer.
describe('getState and saveState', () => {
  let tmpRoot;
  let backup;
  let writeLog;

  beforeEach(async () => {
    // Same spy hygiene as the generateManifest suite: earlier suites leave
    // persistent fs spies installed, and these tests hit the real filesystem.
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const realFs = await vi.importActual('fs/promises');
    fs.stat.mockImplementation(realFs.stat);
    fs.readFile.mockImplementation(realFs.readFile);
    vi.resetModules();

    const { mkdtemp } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    tmpRoot = await mkdtemp(join(tmpdir(), 'portos-backup-state-'));
    writeLog = [];

    // `vi.doMock` is NOT hoisted, so the factory can close over `tmpRoot` and
    // `writeLog`. makePathsProxy rather than a hand-rolled `PATHS: { ...actual.PATHS,
    // data: tmpRoot }`: spelling one member by hand re-roots only `data`, leaving
    // every other data-derived member (`backup`'s siblings, `imageRefs`, …) aimed
    // at the live install — the #3683/#6176 partial-redirect trap. `overrides`
    // carries the atomicWrite spy, which is why this stays a doMock at all.
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => {
      const actual = await importOriginal();
      return makePathsProxy(actual, {
        dataRoot: () => tmpRoot,
        overrides: {
          // Bracket the real write with log markers and a delay, so an unqueued
          // read-merge-write would visibly interleave (start/start/end/end).
          atomicWrite: async (filePath, data) => {
            writeLog.push(`start:${data?.status}`);
            await new Promise((r) => setTimeout(r, 10));
            const result = await actual.atomicWrite(filePath, data);
            writeLog.push(`end:${data?.status}`);
            return result;
          },
        },
      });
    });
    backup = await import('./backup.js');
  });

  afterEach(async () => {
    // Re-register the FILE-LEVEL redirect instead of calling `vi.doUnmock`.
    // `doUnmock` drops the hoisted `vi.mock` at the top of this file too, so
    // every suite AFTER this one resolved PATHS.data to the install's real
    // data/ tree — and `runBackup lifecycle` below then rewrote the
    // developer's genuine data/backup/state.json on every run (#6176; the
    // runtime write guard is what surfaced it).
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => {
      const actual = await importOriginal();
      return makePathsProxy(actual, { dataRoot: testDataRoot, overrides: { atomicWrite: vi.fn(actual.atomicWrite) } });
    });
    vi.resetModules();
    const { rm } = await import('fs/promises');
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  // Read the raw persisted state file (no service helpers) so the assertions
  // describe what a *restore* or another process would actually see.
  async function readStateFile() {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    return JSON.parse(await readFile(join(tmpRoot, 'backup', 'state.json'), 'utf-8'));
  }

  const DEFAULTS = {
    lastRun: null,
    lastSuccessfulRun: null,
    status: 'never',
    lastSnapshotId: null,
    filesChanged: 0,
    pgBackup: null,
    restoreWarning: null,
    error: null
  };

  it('returns the default state when state.json does not exist', async () => {
    expect(await backup.getState()).toEqual(DEFAULTS);
  });

  it('rejects unreadable state instead of returning a saveable default', async () => {
    const { mkdir, writeFile } = await import('fs/promises');
    const { join } = await import('path');
    await mkdir(join(tmpRoot, 'backup'), { recursive: true });
    // Truncated mid-object — the shape a crash during a non-atomic write leaves.
    await writeFile(join(tmpRoot, 'backup', 'state.json'), '{"status":"ok","filesChanged":');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(backup.getState()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
  });

  it('merges a patch into existing state and persists it to disk', async () => {
    await backup.saveState({ lastRun: '2026-01-01T00:00:00Z', status: 'ok', filesChanged: 7 });
    const updated = await backup.saveState({ status: 'degraded', error: 'pg dump failed' });

    // The second patch must not drop the first patch's untouched fields.
    expect(updated).toEqual({
      ...DEFAULTS,
      lastRun: '2026-01-01T00:00:00Z',
      status: 'degraded',
      filesChanged: 7,
      error: 'pg dump failed'
    });
    expect(await readStateFile()).toEqual(updated);
    // A fresh read of the file agrees with the returned value.
    expect(await backup.getState()).toEqual(updated);
  });

  it('serializes concurrent saveState calls so neither patch is clobbered', async () => {
    const [first, second] = await Promise.all([
      backup.saveState({ status: 'running', filesChanged: 10 }),
      backup.saveState({ status: 'ok', lastSnapshotId: 'snap-2' })
    ]);

    // Queue order is call order: the first write sees only its own patch...
    expect(first).toEqual({ ...DEFAULTS, status: 'running', filesChanged: 10 });
    // ...and the second reads the FIRST one's committed image, not the pre-image.
    expect(second).toEqual({
      ...DEFAULTS,
      status: 'ok',
      filesChanged: 10,
      lastSnapshotId: 'snap-2'
    });

    // No interleaving: each read-merge-write completes before the next starts.
    expect(writeLog).toEqual(['start:running', 'end:running', 'start:ok', 'end:ok']);

    // Last write wins on disk, with both patches' fields intact.
    expect(await readStateFile()).toEqual(second);
  });

  it('keeps a rejected write from poisoning the queue for later callers', async () => {
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');
    // A pre-existing FILE where the backup dir must go makes the write throw
    // ENOTDIR, so the first saveState rejects mid-queue.
    await writeFile(join(tmpRoot, 'backup'), 'not a directory');

    await expect(backup.saveState({ status: 'running' })).rejects.toThrow();

    const { rm } = await import('fs/promises');
    await rm(join(tmpRoot, 'backup'));
    // The queue tail must still accept work after the rejection.
    const after = await backup.saveState({ status: 'ok' });
    expect(after).toEqual({ ...DEFAULTS, status: 'ok' });
    expect(await readStateFile()).toEqual(after);
  });
});

it('cannot re-enable Tailcat authority/capability files in backup filters', () => {
  const paths = ['/tailcat-serve.json', '/tailcat-serve.json.*.tmp', '/tailcat-serve.addr'];
  const excluded = computeEffectiveExcludes({ disabledDefaultExcludes: paths });
  for (const path of paths) expect(excluded).toContain(path);
});
