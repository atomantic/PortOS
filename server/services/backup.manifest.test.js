/** Backup service suite: restoreSnapshot manifest verification of legacy database metadata, preview-to-execution byte rechecks and the CoS legacy config slice. Shared mocks and helpers live in backup.test.fixture.js (#16215). */
import { useManifestVerification } from './backup.test.fixture.js';
import { describe, it, expect } from 'vitest';
import { join as joinPath } from 'path';
import { query } from '../lib/db.js';
import { spawn } from '../lib/childProcess.js';
import { getBackendName } from './memoryBackend.js';
import { PATHS } from '../lib/fileUtils.js';
import { restoreSnapshot } from './backup.js';
import { withLiveCosRestore } from './cos/cosState.js';

describe('restoreSnapshot manifest verification', () => {
  let tmpRoot;
  let snapshotDir;
  let snapshotDataDir;
  let realFs;
  const { writeSnapshotFile, writeManifest, finishRestore } = useManifestVerification(state => ({ tmpRoot, snapshotDir, snapshotDataDir, realFs } = state));

  it.each([
    ['universes', 'universes/universe-example/index.json', { id: 'universe-example' }],
    ['universes', 'universes/index.json', { config: { runs: [{ id: 'run-example' }] } }],
    ['pipeline-issues', 'pipeline-issues/iss-example/index.json', { id: 'iss-example' }],
    ['pipeline-series', 'pipeline-series/ser-example/index.json', { id: 'ser-example' }],
    ['story-builder', 'story-builder/stb-example/index.json', { id: 'stb-example' }],
    ['writers-room', 'writers-room/folders.json', [{ id: 'folder-example' }]],
    ['writers-room', 'writers-room/exercises.json', [{ id: 'exercise-example' }]],
    ['writers-room', 'writers-room/works/wr-work-aabb/manifest.json', { id: 'wr-work-aabb' }],
    ['creative-director', 'creative-director-projects.json', [{ id: 'project-example' }]],
    ['cos-tasks', 'TASKS.md', '# User Tasks'],
    ['cos-tasks', 'COS-TASKS.md', '# Internal Tasks'],
  ])('refuses %s legacy metadata at %s before preview or execution (#12397)', async (domain, path, record) => {
    getBackendName.mockReturnValue('postgres');
    const savedBackend = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    const markerPath = joinPath(PATHS.data, `${domain === 'creative-director' ? 'creative-director-projects' : domain}.migrated.json`);
    await realFs.writeFile(markerPath, '{"imported":1}');
    try {
      const hash = await writeSnapshotFile(path, typeof record === 'string' ? record : JSON.stringify(record));
      await writeManifest({ [path]: hash });
      // Both empty and overlapping destination databases must refuse: this is
      // source compatibility, not an opportunistic ON CONFLICT merge.
      for (const rows of [[], [{ id: 'existing-record' }]]) {
        query.mockResolvedValue({ rows });
        for (const dryRun of [true, false]) {
          for (const subdirFilter of [null, path.split('/')[0], path]) {
            await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun, subdirFilter }))
              .rejects.toMatchObject({ code: 'BACKUP_LEGACY_DB_METADATA', context: { domains: [domain] } });
          }
        }
      }
      expect(spawn).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(await realFs.readFile(markerPath, 'utf8')).toBe('{"imported":1}');
      // Pre-manifest snapshots get the same compatibility preflight.
      await realFs.rm(joinPath(snapshotDir, 'manifest.json'));
      await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false }))
        .rejects.toMatchObject({ code: 'BACKUP_LEGACY_DB_METADATA' });
    } finally {
      if (savedBackend === undefined) delete process.env.MEMORY_BACKEND;
      else process.env.MEMORY_BACKEND = savedBackend;
      getBackendName.mockReturnValue(null);
      query.mockResolvedValue({ rows: [] });
      await realFs.rm(markerPath);
    }
  });

  it('admits current file-primary siblings and parked recovery evidence on PostgreSQL', async () => {
    getBackendName.mockReturnValue('postgres');
    const savedBackend = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    try {
      const paths = [
        'universes/universe-example/assets/sheet.png', 'universes.imported/universe-example/index.json',
        'universes/index.json', 'pipeline-issues/iss-example/render.png',
        'pipeline-series/ser-example/manuscript-review.json', 'pipeline-series/ser-example/index.json.imported',
        'story-builder.imported/stb-example/index.json', 'writers-room/folders.imported.json',
        'writers-room/exercises.imported.json', 'writers-room/works/wr-work-aabb/manifest.imported.json',
        'writers-room/works/wr-work-aabb/drafts/draft-example.md', 'creative-director-projects.imported.json',
        'TASKS.md.imported', 'COS-TASKS.md.imported-123',
      ];
      const files = {};
      for (const path of paths) files[path] = await writeSnapshotFile(path, '{}');
      await writeManifest(files);
      await expect(finishRestore({ dryRun: true })).resolves.toMatchObject({ verification: { status: 'verified' } });
      // A mixed snapshot still permits selecting only the current draft body.
      files['writers-room/folders.json'] = await writeSnapshotFile('writers-room/folders.json', '[]');
      await writeManifest(files);
      spawn.mockReset();
      await expect(finishRestore({ dryRun: false, subdirFilter: 'writers-room/works/wr-work-aabb/drafts' }))
        .resolves.toMatchObject({ verification: { status: 'verified', checkedFiles: 1 } });
    } finally {
      if (savedBackend === undefined) delete process.env.MEMORY_BACKEND;
      else process.env.MEMORY_BACKEND = savedBackend;
      getBackendName.mockReturnValue(null);
    }
  });

  it.each(['cos/config.json', 'cos/state.json'])('checks configured CoS task files using snapshot %s', async (configPath) => {
    getBackendName.mockReturnValue('postgres');
    const savedBackend = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    try {
      const userQueue = 'custom/user.md';
      const internalQueue = 'custom/internal.md';
      const config = {
        userTasksFile: ' ./data/custom/user.md ',
        cosTasksFile: joinPath(PATHS.data, internalQueue),
      };
      const files = {
        [configPath]: await writeSnapshotFile(configPath, JSON.stringify(configPath === 'cos/config.json' ? config : { config })),
        [userQueue]: await writeSnapshotFile(userQueue, '# User Tasks'),
        [internalQueue]: await writeSnapshotFile(internalQueue, '# Internal Tasks'),
        'custom/note.md': await writeSnapshotFile('custom/note.md', 'unrelated file'),
        'custom/user.md.imported': await writeSnapshotFile('custom/user.md.imported', 'parked queue'),
      };
      await writeManifest(files);

      for (const dryRun of [true, false]) {
        for (const subdirFilter of [null, 'custom', userQueue, internalQueue]) {
          await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun, subdirFilter }))
            .rejects.toMatchObject({ code: 'BACKUP_LEGACY_DB_METADATA', context: { domains: ['cos-tasks'] } });
        }
      }
      expect(spawn).not.toHaveBeenCalled();
      for (const subdirFilter of ['custom/note.md', 'custom/user.md.imported']) {
        spawn.mockClear();
        await expect(finishRestore({ subdirFilter }))
          .resolves.toMatchObject({ verification: { status: 'verified', checkedFiles: 1 } });
      }
    } finally {
      if (savedBackend === undefined) delete process.env.MEMORY_BACKEND;
      else process.env.MEMORY_BACKEND = savedBackend;
      getBackendName.mockReturnValue(null);
    }
  });

  it('ignores obsolete CoS config and configured queues outside the data tree', async () => {
    getBackendName.mockReturnValue('postgres');
    const savedBackend = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    try {
      const files = {
        'cos/config.json': await writeSnapshotFile('cos/config.json', JSON.stringify({
          userTasksFile: 'data/../custom/user.md',
          cosTasksFile: joinPath(PATHS.data, '..', 'custom/internal.md'),
        })),
        'cos/state.json': await writeSnapshotFile('cos/state.json', JSON.stringify({ config: { userTasksFile: 'data/custom/user.md' } })),
        'custom/user.md': await writeSnapshotFile('custom/user.md', 'ordinary file'),
        'custom/internal.md': await writeSnapshotFile('custom/internal.md', 'ordinary file'),
      };
      await writeManifest(files);
      await expect(finishRestore()).resolves.toMatchObject({ verification: { status: 'verified' } });
    } finally {
      if (savedBackend === undefined) delete process.env.MEMORY_BACKEND;
      else process.env.MEMORY_BACKEND = savedBackend;
      getBackendName.mockReturnValue(null);
    }
  });

  it('rechecks snapshot bytes on execution and refuses a post-preview change before rsync', async () => {
    const relativePath = 'restore-integrity/example.json';
    const originalHash = await writeSnapshotFile(relativePath, 'trusted backup');
    await writeManifest({ [relativePath]: originalHash });
    const livePath = joinPath(PATHS.data, relativePath);
    await realFs.mkdir(joinPath(livePath, '..'), { recursive: true });
    await realFs.writeFile(livePath, 'healthy live data');

    await expect(finishRestore({ dryRun: true })).resolves.toMatchObject({
      verification: { status: 'verified', checkedFiles: 1 },
    });

    await realFs.writeFile(joinPath(snapshotDataDir, relativePath), 'changed after preview');
    spawn.mockReset();
    await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false }))
      .rejects.toMatchObject({ code: 'BACKUP_FILE_INTEGRITY_FAILED' });
    expect(spawn).not.toHaveBeenCalled();
    expect(await realFs.readFile(livePath, 'utf8')).toBe('healthy live data');
  });

  it('refuses a file added after preview when it is absent from the manifest', async () => {
    const relativePath = 'restore-integrity/example.json';
    const originalHash = await writeSnapshotFile(relativePath, 'trusted backup');
    await writeManifest({ [relativePath]: originalHash });
    const livePath = joinPath(PATHS.data, relativePath);
    await realFs.mkdir(joinPath(livePath, '..'), { recursive: true });
    await realFs.writeFile(livePath, 'healthy live data');

    await expect(finishRestore({ dryRun: true })).resolves.toMatchObject({
      verification: { status: 'verified', checkedFiles: 1 },
    });

    await writeSnapshotFile('restore-integrity/unrecorded.json', 'added after backup');
    spawn.mockReset();
    await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false }))
      .rejects.toMatchObject({ code: 'BACKUP_FILE_INTEGRITY_FAILED' });
    expect(spawn).not.toHaveBeenCalled();
    expect(await realFs.readFile(livePath, 'utf8')).toBe('healthy live data');
  });

  // A pre-#6182 snapshot keeps the CoS config in state.json's `config` slice.
  it.each([
    { name: 'pre-split snapshot, full restore', files: ['cos/state.json'], subdirFilter: undefined, expected: { maxConcurrentAgents: 7 } },
    { name: 'pre-split snapshot, state.json scope', files: ['cos/state.json'], subdirFilter: 'cos/state.json', expected: { maxConcurrentAgents: 7 } },
    { name: 'pre-split snapshot, agents scope', files: ['cos/state.json'], subdirFilter: 'cos/agents', expected: null },
    { name: 'snapshot with config.json', files: ['cos/state.json', 'cos/config.json'], subdirFilter: undefined, expected: null },
  ])('hands CoS restore the legacy config slice the snapshot installs: $name', async ({ files, subdirFilter, expected }) => {
    const bodies = { 'cos/state.json': '{"agents":{},"config":{"maxConcurrentAgents":7}}', 'cos/config.json': '{"maxConcurrentAgents":5}' };
    const manifest = {};
    for (const file of files) manifest[file] = await writeSnapshotFile(file, bodies[file]);
    await writeManifest(manifest);
    withLiveCosRestore.mockClear();
    await finishRestore({ dryRun: false, subdirFilter });
    expect(withLiveCosRestore).toHaveBeenCalledWith(expect.any(Function), { snapshotLegacyConfig: expected });
  });

});
