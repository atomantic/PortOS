/** Backup service suite: restoreSnapshot manifest verification of store-split and older snapshots, OS metadata, selective restore scope, real-rsync byte checks and snapshot source lifetime. Shared mocks and helpers live in backup.test.fixture.js (#16215). */
import { runFileMigrations, machineHost, fakeProc, flush, useManifestVerification } from './backup.test.fixture.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join as joinPath } from 'path';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { spawn } from '../lib/childProcess.js';
import { PATHS } from '../lib/fileUtils.js';
import * as fs from 'fs/promises';
import { reloadSettings } from './settings.js';
import { invalidateAllCaches as invalidateBrainCaches } from './brainStorage.js';
import { openSnapshotStream, restoreSnapshot, deleteSnapshot } from './backup.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { registerManagedVisitorCredentialRestore } from './bootHookRegistry.js';

const credentialRestoreLock = vi.fn(createFileWriteQueue());
registerManagedVisitorCredentialRestore(credentialRestoreLock);

describe('restoreSnapshot manifest verification', () => {
  let tmpRoot;
  let snapshotDir;
  let snapshotDataDir;
  let realFs;
  const { writeSnapshotFile, writeManifest, finishRestore } = useManifestVerification(state => ({ tmpRoot, snapshotDir, snapshotDataDir, realFs } = state));

  describe('snapshot from before a store split (#12626)', () => {
    const legacyPeople = JSON.stringify({ records: {
      'p-1': { name: 'Example Person', updatedAt: '2026-01-01T00:00:00.000Z' },
      'p-2': { _deleted: true, updatedAt: '2026-01-02T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z' },
    } });
    const live = (...parts) => joinPath(PATHS.data, ...parts);
    const readLive = async (...parts) => JSON.parse(await realFs.readFile(live(...parts), 'utf8'));

    beforeEach(async () => {
      // An upgraded install: split layout at v1 with a record of its own.
      await realFs.mkdir(live('brain', 'people', 'live-1'), { recursive: true });
      await realFs.writeFile(live('brain', 'people', 'index.json'), JSON.stringify({ schemaVersion: 1, type: 'people', config: {} }));
      await realFs.writeFile(live('brain', 'people', 'live-1', 'index.json'), JSON.stringify({ name: 'Live Person' }));
      invalidateBrainCaches.mockClear();
    });

    afterEach(async () => {
      await realFs.rm(live('brain'), { recursive: true, force: true });
    });

    async function seedSnapshot(files) {
      const manifest = {};
      for (const [path, body] of Object.entries(files)) manifest[path] = await writeSnapshotFile(path, body);
      await writeManifest(manifest);
    }

    it.each([undefined, 'brain', 'brain/people.json'])('converts a restored legacy Brain store and parks the live one (scope %s)', async (subdirFilter) => {
      await seedSnapshot({ 'brain/people.json': legacyPeople });

      const preview = await finishRestore({ dryRun: true, subdirFilter });
      expect(preview.restoredLegacyStores).toEqual([{ store: 'brain/people', legacyFile: 'brain/people.json', status: 'pending', parkedAs: null }]);
      expect(await readLive('brain', 'people', 'live-1', 'index.json')).toEqual({ name: 'Live Person' });

      // rsync is faked, so stand in for its transfer of the snapshot monolith.
      await realFs.writeFile(live('brain', 'people.json'), legacyPeople);
      spawn.mockReset();
      const result = await finishRestore({ dryRun: false, subdirFilter });

      const [converted] = result.restoredLegacyStores;
      expect(converted).toMatchObject({ store: 'brain/people', status: 'converted', parkedAs: expect.stringMatching(/^brain\/people\.pre-restore-/) });
      expect(await readLive('brain', 'people', 'p-1', 'index.json')).toMatchObject({ name: 'Example Person' });
      expect(await readLive('brain', 'people', 'p-2', 'index.json')).toMatchObject({ _deleted: true });
      expect(existsSync(live('brain', 'people', 'live-1'))).toBe(false);
      expect(await readLive(converted.parkedAs, 'live-1', 'index.json')).toEqual({ name: 'Live Person' });
      expect(existsSync(live('brain', 'people.json.bak-200'))).toBe(true);
      expect(invalidateBrainCaches).toHaveBeenCalled();
    });

    it('treats a split snapshot with a stray re-seeded monolith as current', async () => {
      await seedSnapshot({
        'brain/people.json': legacyPeople,
        'brain/people/index.json': JSON.stringify({ schemaVersion: 1, type: 'people', config: {} }),
      });
      await realFs.writeFile(live('brain', 'people.json'), legacyPeople);

      const result = await finishRestore({ dryRun: false });
      expect(result).not.toHaveProperty('restoredLegacyStores');
      expect(await readLive('brain', 'people', 'live-1', 'index.json')).toEqual({ name: 'Live Person' });
      expect(existsSync(live('brain', 'people', 'p-1'))).toBe(false);
    });

    it('leaves Brain alone when the restore scope excludes it', async () => {
      await seedSnapshot({ 'brain/people.json': legacyPeople, 'cos/example.json': '{}' });

      const result = await finishRestore({ dryRun: false, subdirFilter: 'cos' });
      expect(result).not.toHaveProperty('restoredLegacyStores');
      expect(await readLive('brain', 'people', 'live-1', 'index.json')).toEqual({ name: 'Live Person' });
      await realFs.rm(live('cos', 'example.json'), { force: true });
    });

    it('replays the adopted ledger through the split and reports it in preview and result (#12813)', async () => {
      const ledgerPath = live('migrations.applied.json');
      const legacyLedgerPath = live('migrations', '.applied.json');
      const split = '200-split-brain-stores-to-per-record.js';
      const journals = JSON.stringify({ records: { '2025-03-01': { id: 'jrnl-example', date: '2025-03-01' } } });
      await seedSnapshot({ 'brain/journals.json': journals, 'migrations/.applied.json': JSON.stringify(['001-example.js']) });
      await realFs.writeFile(ledgerPath, JSON.stringify(['001-example.js', split]));
      try {
        const preview = await finishRestore({ dryRun: true });
        expect(preview.restoredLegacyMigrations).toMatchObject({ status: 'pending', through: split });
        expect(preview.restoredLegacyMigrations.names).toContain('081-brain-daily-log-inbox-sync.js');
        expect(preview.restoredLegacyMigrations.names.at(-1)).toBe(split);
        expect(preview.restoredLegacyStores.map(entry => entry.store)).toEqual(['brain/people', 'brain/journals']);

        // rsync is faked, so stand in for its transfer of the snapshot files.
        await realFs.writeFile(live('brain', 'journals.json'), journals);
        await realFs.mkdir(live('migrations'), { recursive: true });
        await realFs.writeFile(legacyLedgerPath, JSON.stringify(['001-example.js']));
        runFileMigrations.mockImplementationOnce(async ({ through }) => {
          // The replay must read the snapshot's ledger, so adoption runs first.
          expect(JSON.parse(await realFs.readFile(ledgerPath, 'utf8'))).toEqual(['001-example.js']);
          await realFs.writeFile(ledgerPath, JSON.stringify(['001-example.js', through]));
        });
        spawn.mockReset();
        const result = await finishRestore({ dryRun: false });

        expect(runFileMigrations).toHaveBeenCalledWith(expect.objectContaining({ through: split }));
        expect(result.restoredLegacyLedger).toMatchObject({ status: 'adopted' });
        expect(result.restoredLegacyMigrations).toEqual({ ...preview.restoredLegacyMigrations, status: 'applied' });
        expect(existsSync(live('brain', 'people', 'live-1'))).toBe(false);
      } finally {
        runFileMigrations.mockReset();
        await realFs.rm(live('migrations'), { recursive: true, force: true });
        for (const name of await realFs.readdir(PATHS.data)) {
          if (name.startsWith('migrations.applied.json')) await realFs.rm(live(name), { force: true });
        }
      }
    });

    it('never parks the live store for a monolith the split would refuse', async () => {
      const malformed = JSON.stringify({ records: [{ id: 'p-1' }] });
      await seedSnapshot({ 'brain/people.json': malformed });
      await realFs.writeFile(live('brain', 'people.json'), malformed);

      const result = await finishRestore({ dryRun: false });
      expect(result.restoredLegacyStores).toEqual([{ store: 'brain/people', legacyFile: 'brain/people.json', status: 'unreadable', parkedAs: null }]);
      expect(await readLive('brain', 'people', 'live-1', 'index.json')).toEqual({ name: 'Live Person' });
    });
  });

  describe('folder restore of an older snapshot (#12355)', () => {
    const liveLedgerPath = () => joinPath(PATHS.data, 'migrations.applied.json');
    const liveQuotaBurnPath = () => joinPath(PATHS.cos, 'quota-burn.json');
    const liveJobsPath = () => joinPath(PATHS.cos, 'autonomous-jobs.json');
    const legacyPlan = JSON.stringify({ families: { grok: { enabled: true, jobs: [{
      id: 'step-1', enabled: true, label: 'Example pass', jobType: 'agent-prompt',
      params: { appId: 'app-example', prompt: 'Rewrite the example copy.' },
    }] } } });

    afterEach(async () => {
      for (const path of [liveLedgerPath(), liveQuotaBurnPath(), liveJobsPath()]) await realFs.rm(path, { force: true });
    });

    async function seedSnapshot({ ledger } = {}) {
      const manifest = { 'cos/quota-burn.json': await writeSnapshotFile('cos/quota-burn.json', legacyPlan) };
      if (ledger) manifest['migrations.applied.json'] = await writeSnapshotFile('migrations.applied.json', JSON.stringify(ledger));
      await writeManifest(manifest);
    }

    it('reports the migrations the live ledger has applied that the snapshot lacks, in preview and execution', async () => {
      await seedSnapshot({ ledger: ['001-example.js'] });
      await realFs.writeFile(liveLedgerPath(), JSON.stringify(['001-example.js', '359-example.js']));
      const gap = { count: 1, names: ['359-example.js'] };

      await expect(finishRestore({ dryRun: true, subdirFilter: 'cos' })).resolves.toMatchObject({ ledgerGap: gap });
      spawn.mockReset();
      await expect(finishRestore({ dryRun: false, subdirFilter: 'cos' })).resolves.toMatchObject({ ledgerGap: gap });
    });

    it.each([
      { name: 'matching ledger', ledger: ['001-example.js'], expected: { count: 0, names: [] } },
      { name: 'snapshot without a ledger', ledger: undefined, expected: null },
    ])('reports $name as $expected', async ({ ledger, expected }) => {
      await seedSnapshot({ ledger });
      await realFs.writeFile(liveLedgerPath(), JSON.stringify(['001-example.js']));
      expect((await finishRestore({ dryRun: true, subdirFilter: 'cos' })).ledgerGap).toEqual(expected);
    });

    it('omits the gap from a full restore, which installs the snapshot ledger itself', async () => {
      await seedSnapshot({ ledger: ['001-example.js'] });
      await realFs.writeFile(liveLedgerPath(), JSON.stringify(['001-example.js', '359-example.js']));
      expect(await finishRestore({ dryRun: true })).not.toHaveProperty('ledgerGap');
    });

    // Snapshots from before migrations moved out of data/ (May 2026) carry the
    // ledger at migrations/.applied.json. rsync lands it beside the live
    // migrations.applied.json, which the runner then keeps, so without adoption
    // a full restore would re-run nothing over the restored records.
    describe('snapshot with the pre-May-2026 ledger location', () => {
      const liveLegacyLedgerPath = () => joinPath(PATHS.data, 'migrations', '.applied.json');
      const parkedLedgers = async () => (await realFs.readdir(PATHS.data)).filter(name => name.startsWith('migrations.applied.json.pre-restore-'));

      afterEach(async () => {
        await realFs.rm(joinPath(PATHS.data, 'migrations'), { recursive: true, force: true });
        for (const name of await parkedLedgers()) await realFs.rm(joinPath(PATHS.data, name), { force: true });
      });

      async function seedLegacySnapshot({ alsoCurrent = false } = {}) {
        const manifest = { 'migrations/.applied.json': await writeSnapshotFile('migrations/.applied.json', JSON.stringify(['001-example.js'])) };
        if (alsoCurrent) manifest['migrations.applied.json'] = await writeSnapshotFile('migrations.applied.json', JSON.stringify(['001-example.js']));
        await writeManifest(manifest);
      }

      it('announces the adoption in a preview without touching the live ledger', async () => {
        await seedLegacySnapshot();
        await realFs.writeFile(liveLedgerPath(), JSON.stringify(['001-example.js', '359-example.js']));

        await expect(finishRestore({ dryRun: true })).resolves.toMatchObject({ restoredLegacyLedger: { status: 'pending', parkedAs: null } });
        expect(JSON.parse(await realFs.readFile(liveLedgerPath(), 'utf8'))).toEqual(['001-example.js', '359-example.js']);
      });

      it('installs the restored legacy ledger as the live one and parks the previous ledger', async () => {
        await seedLegacySnapshot();
        await realFs.writeFile(liveLedgerPath(), JSON.stringify(['001-example.js', '359-example.js']));
        // rsync is faked, so stand in for its transfer of the snapshot ledger.
        await realFs.mkdir(joinPath(PATHS.data, 'migrations'), { recursive: true });
        await realFs.writeFile(liveLegacyLedgerPath(), JSON.stringify(['001-example.js']));

        const result = await finishRestore({ dryRun: false });

        expect(result.restoredLegacyLedger).toEqual({ status: 'adopted', parkedAs: expect.stringMatching(/^migrations\.applied\.json\.pre-restore-/) });
        expect(JSON.parse(await realFs.readFile(liveLedgerPath(), 'utf8'))).toEqual(['001-example.js']);
        expect(JSON.parse(await realFs.readFile(joinPath(PATHS.data, result.restoredLegacyLedger.parkedAs), 'utf8'))).toEqual(['001-example.js', '359-example.js']);
        expect(existsSync(liveLegacyLedgerPath())).toBe(false);
      });

      it('restores the live ledger when installing the legacy ledger fails', async () => {
        await seedLegacySnapshot();
        const liveLedger = JSON.stringify(['001-example.js', '359-example.js']);
        const legacyLedger = JSON.stringify(['001-example.js']);
        await realFs.writeFile(liveLedgerPath(), liveLedger);
        await realFs.mkdir(joinPath(PATHS.data, 'migrations'), { recursive: true });
        await realFs.writeFile(liveLegacyLedgerPath(), legacyLedger);
        const installError = Object.assign(new Error('Legacy ledger rename denied'), { code: 'EACCES' });
        fs.rename.mockImplementation(async (source, destination) => {
          if (source === liveLegacyLedgerPath() && destination === liveLedgerPath()) throw installError;
          return realFs.rename(source, destination);
        });

        await expect(finishRestore({ dryRun: false })).rejects.toMatchObject({ code: 'EACCES', message: expect.stringContaining(installError.message) });
        expect(await realFs.readFile(liveLedgerPath(), 'utf8')).toBe(liveLedger);
        expect(await realFs.readFile(liveLegacyLedgerPath(), 'utf8')).toBe(legacyLedger);
        expect(await parkedLedgers()).toEqual([]);
      });

      it('adopts the ledger on an install that had none, parking nothing', async () => {
        await seedLegacySnapshot();
        await realFs.mkdir(joinPath(PATHS.data, 'migrations'), { recursive: true });
        await realFs.writeFile(liveLegacyLedgerPath(), JSON.stringify(['001-example.js']));

        await expect(finishRestore({ dryRun: false })).resolves.toMatchObject({ restoredLegacyLedger: { status: 'adopted', parkedAs: null } });
        expect(JSON.parse(await realFs.readFile(liveLedgerPath(), 'utf8'))).toEqual(['001-example.js']);
        expect(await parkedLedgers()).toEqual([]);
      });

      it('reports an unreadable legacy ledger and keeps the live ledger', async () => {
        await writeManifest({ 'migrations/.applied.json': await writeSnapshotFile('migrations/.applied.json', '{ not a ledger') });
        await realFs.writeFile(liveLedgerPath(), JSON.stringify(['001-example.js', '359-example.js']));
        await realFs.mkdir(joinPath(PATHS.data, 'migrations'), { recursive: true });
        await realFs.writeFile(liveLegacyLedgerPath(), '{ not a ledger');

        await expect(finishRestore({ dryRun: true })).resolves.toMatchObject({ restoredLegacyLedger: { status: 'unreadable', parkedAs: null } });
        spawn.mockReset();
        await expect(finishRestore({ dryRun: false })).resolves.toMatchObject({ restoredLegacyLedger: { status: 'unreadable', parkedAs: null } });
        expect(JSON.parse(await realFs.readFile(liveLedgerPath(), 'utf8'))).toEqual(['001-example.js', '359-example.js']);
        expect(await parkedLedgers()).toEqual([]);
      });

      it('leaves a snapshot that also carries a current-path ledger to rsync', async () => {
        await seedLegacySnapshot({ alsoCurrent: true });
        await realFs.writeFile(liveLedgerPath(), JSON.stringify(['001-example.js', '359-example.js']));

        const result = await finishRestore({ dryRun: false });
        expect(result).not.toHaveProperty('restoredLegacyLedger');
        expect(await parkedLedgers()).toEqual([]);
      });

      it('keeps the live ledger on a folder restore and reads the legacy ledger for the gap', async () => {
        await seedLegacySnapshot();
        await realFs.writeFile(liveLedgerPath(), JSON.stringify(['001-example.js', '359-example.js']));

        const result = await finishRestore({ dryRun: true, subdirFilter: 'cos' });
        expect(result).not.toHaveProperty('restoredLegacyLedger');
        expect(result.ledgerGap).toEqual({ count: 1, names: ['359-example.js'] });
      });
    });

    it('converts a restored legacy quota-burn plan to task references, once', async () => {
      await seedSnapshot();
      // rsync is faked, so stand in for its transfer of the snapshot plan.
      await realFs.mkdir(PATHS.cos, { recursive: true });
      await realFs.writeFile(liveQuotaBurnPath(), legacyPlan);

      await finishRestore({ dryRun: false, subdirFilter: 'cos' });
      const converted = JSON.parse(await realFs.readFile(liveQuotaBurnPath(), 'utf8')).families.grok.jobs[0];
      expect(converted).toMatchObject({ jobType: null, taskRef: { kind: 'custom', jobId: 'job-burn-grok-step-1' } });

      // A second restore of the same snapshot finds the job it created last time.
      await realFs.writeFile(liveQuotaBurnPath(), legacyPlan);
      spawn.mockReset();
      await finishRestore({ dryRun: false, subdirFilter: 'cos' });
      const jobs = JSON.parse(await realFs.readFile(liveJobsPath(), 'utf8')).jobs;
      expect(jobs.filter(job => job.id === 'job-burn-grok-step-1')).toHaveLength(1);
      expect(JSON.parse(await realFs.readFile(liveQuotaBurnPath(), 'utf8')).families.grok.jobs[0].taskRef)
        .toEqual({ kind: 'custom', jobId: 'job-burn-grok-step-1' });
    });
  });

  it('names the unmanifested file so the operator can act on it', async () => {
    const relativePath = 'restore-integrity/example.json';
    await writeManifest({ [relativePath]: await writeSnapshotFile(relativePath, 'trusted backup') });
    await writeSnapshotFile('restore-integrity/unrecorded.json', 'added after backup');

    await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true }))
      .rejects.toThrow(/restore-integrity\/unrecorded\.json/);
  });

  it('restores despite OS metadata a file browser dropped into the snapshot', async () => {
    // The destination is commonly an iCloud/Finder folder, so merely BROWSING a
    // snapshot writes .DS_Store beside the data — long after the manifest was
    // sealed. Refusing that would strand an intact snapshot permanently.
    const relativePath = 'brain/example.json';
    await writeManifest({ [relativePath]: await writeSnapshotFile(relativePath, 'snapshot data') });
    await writeSnapshotFile('brain/.DS_Store', 'finder metadata');
    await writeSnapshotFile('brain/._example.json', 'appledouble');

    await expect(finishRestore({ dryRun: true, subdirFilter: 'brain' }))
      .resolves.toMatchObject({ verification: { status: 'verified', checkedFiles: 1 } });
    // ...and rsync must not carry them across either, or the transfer would
    // exceed what the inventory verified.
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--exclude=.DS_Store', '--exclude=._*',
    ]));
  });

  it.each(['modified', 'deleted'])('restores a snapshot whose manifest hashed a .DS_Store that was later %s', async (change) => {
    // Manifests written before OS metadata was excluded still list it; Finder
    // rewriting that file must not fail verification of an intact snapshot.
    const relativePath = 'images/example.png';
    const metaPath = 'images/.DS_Store';
    await writeManifest({
      [relativePath]: await writeSnapshotFile(relativePath, 'snapshot data'),
      [metaPath]: await writeSnapshotFile(metaPath, 'original finder metadata'),
    });
    if (change === 'modified') await writeSnapshotFile(metaPath, 'finder rewrote this');
    else await realFs.unlink(joinPath(snapshotDataDir, metaPath));

    await expect(finishRestore({ dryRun: true }))
      .resolves.toMatchObject({ verification: { status: 'verified', checkedFiles: 1 } });
  });

  it.each(['brain/', './brain', 'brain/.', 'brain//'])(
    'selects and verifies the same files for the equivalent scope %s',
    async (spelling) => {
      const relativePath = 'brain/example.json';
      await writeManifest({ [relativePath]: await writeSnapshotFile(relativePath, 'snapshot data') });

      await expect(finishRestore({ dryRun: true, subdirFilter: spelling })).resolves.toMatchObject({
        subdirFilter: 'brain',
        verification: { status: 'verified', checkedFiles: 1 },
      });
      expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--include=/brain', '--include=/brain/***']));
    },
  );

  it.each([
    ['missing', async (path) => realFs.unlink(path)],
    ['unreadable', async (path) => {
      fs.readFile.mockImplementation(async (candidate, ...args) => {
        if (String(candidate) === path) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
        return realFs.readFile(candidate, ...args);
      });
    }],
  ])('refuses a %s selected file before rsync', async (_case, breakFile) => {
    const relativePath = 'brain/example.json';
    const filePath = joinPath(snapshotDataDir, relativePath);
    const hash = await writeSnapshotFile(relativePath, 'snapshot data');
    await writeManifest({ [relativePath]: hash });
    await breakFile(filePath);

    await expect(restoreSnapshot(tmpRoot, 'snap-1', { subdirFilter: 'brain' }))
      .rejects.toMatchObject({ code: 'BACKUP_FILE_INTEGRITY_FAILED' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('validates the whole manifest but hashes only the literal selective scope', async () => {
    const brainHash = await writeSnapshotFile('brain/example.json', 'brain');
    await writeSnapshotFile('media/example.json', 'media');
    await writeManifest({
      'brain/example.json': brainHash,
      'media/example.json': '0'.repeat(64),
      '../portos-db.sql': '1'.repeat(64),
    });

    await expect(finishRestore({ dryRun: true, subdirFilter: 'brain' })).resolves.toMatchObject({
      verification: { status: 'verified', checkedFiles: 1 },
    });
  });

  it('ignores an unrecorded file outside a literal selective scope', async () => {
    const brainHash = await writeSnapshotFile('brain/example.json', 'brain');
    await writeSnapshotFile('media/unrecorded.json', 'outside selection');
    await writeManifest({ 'brain/example.json': brainHash });

    await expect(finishRestore({ dryRun: true, subdirFilter: 'brain' })).resolves.toMatchObject({
      verification: { status: 'verified', checkedFiles: 1 },
    });
  });

  it.each([
    ['malformed JSON', '{"files":'],
    ['a null root', 'null'],
    ['an invalid shape', JSON.stringify({ fileCount: 1, files: [] })],
    ['an unsafe data path', JSON.stringify({ fileCount: 1, files: { '../outside.json': '0'.repeat(64) } })],
  ])('fails closed when an existing manifest has %s', async (_case, manifestBytes) => {
    await realFs.writeFile(joinPath(snapshotDir, 'manifest.json'), manifestBytes);

    await expect(restoreSnapshot(tmpRoot, 'snap-1'))
      .rejects.toMatchObject({ code: expect.stringMatching(/^BACKUP_MANIFEST_(UNREADABLE|INVALID)$/) });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps legacy snapshots explicit and preserves manifest-compatible symlinks', async () => {
    await expect(finishRestore({ dryRun: true })).resolves.toMatchObject({
      verification: { status: 'unverified', reason: 'manifest_absent', checkedFiles: 0 },
    });
    expect(spawn.mock.calls[0][1]).toContain('--checksum');

    const targetHash = await writeSnapshotFile('example.txt', 'example');
    await realFs.symlink('example.txt', joinPath(snapshotDataDir, 'readable-link'));
    await realFs.symlink('missing.txt', joinPath(snapshotDataDir, 'dangling-link'));
    await writeManifest({
      'example.txt': targetHash,
      'readable-link': targetHash,
    });
    spawn.mockReset();

    await expect(finishRestore({ dryRun: true })).resolves.toMatchObject({
      verification: { status: 'verified', checkedFiles: 2 },
    });
  });

  it('restores differing bytes when size and mtime match through real rsync', async context => {
    // Windows CI does not provision MSYS rsync. Unix coverage remains mandatory;
    // installed Windows rsync errors still fail this test rather than being hidden.
    if (process.platform === 'win32' && spawnSync('rsync', ['--version']).error?.code === 'ENOENT') {
      context.skip('Windows runner has no rsync executable; real rsync remains required on Linux/macOS.');
      return;
    }
    const relativePath = 'brain/example.json';
    const snapshotContent = '{"value":"old"}';
    const liveContent = '{"value":"new"}';
    const sourcePath = joinPath(snapshotDataDir, relativePath);
    const livePath = joinPath(PATHS.data, relativePath);
    const snapshotHash = await writeSnapshotFile(relativePath, snapshotContent);
    await writeManifest({ [relativePath]: snapshotHash });
    await realFs.mkdir(joinPath(livePath, '..'), { recursive: true });
    await realFs.writeFile(livePath, liveContent);

    const matchingMtime = new Date('2026-09-12T00:00:00.000Z');
    await realFs.utimes(sourcePath, matchingMtime, matchingMtime);
    await realFs.utimes(livePath, matchingMtime, matchingMtime);

    const previousRsync = process.env.PORTOS_RSYNC;
    delete process.env.PORTOS_RSYNC;
    spawn.mockImplementation((...args) => spawnChild(...args));

    try {
      const fullPreview = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true });
      expect(fullPreview.changedFiles.some(line => line.includes(relativePath))).toBe(true);
      expect(await realFs.readFile(livePath, 'utf8')).toBe(liveContent);

      await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false });
      expect(await realFs.readFile(livePath, 'utf8')).toBe(snapshotContent);

      await realFs.writeFile(livePath, liveContent);
      await realFs.utimes(livePath, matchingMtime, matchingMtime);
      const selectivePreview = await restoreSnapshot(tmpRoot, 'snap-1', {
        dryRun: true,
        subdirFilter: 'brain',
      });
      expect(selectivePreview.changedFiles.some(line => line.includes(relativePath))).toBe(true);
      expect(await realFs.readFile(livePath, 'utf8')).toBe(liveContent);

      await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false, subdirFilter: 'brain' });
      expect(await realFs.readFile(livePath, 'utf8')).toBe(snapshotContent);

      const equalPreview = await restoreSnapshot(tmpRoot, 'snap-1', {
        dryRun: true,
        subdirFilter: 'brain',
      });
      expect(equalPreview.changedFiles.filter(line => line.includes(relativePath))).toEqual([]);

      // A selected file needs an exact include rule on rsync 3.x; the
      // directory-only /file/*** pattern silently skips it there.
      await realFs.writeFile(livePath, liveContent);
      const filePreview = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true, subdirFilter: relativePath });
      expect(filePreview.changedFiles.some(line => line.includes(relativePath))).toBe(true);
      expect(await realFs.readFile(livePath, 'utf8')).toBe(liveContent);
      await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false, subdirFilter: relativePath });
      expect(await realFs.readFile(livePath, 'utf8')).toBe(snapshotContent);
    } finally {
      if (previousRsync === undefined) delete process.env.PORTOS_RSYNC;
      else process.env.PORTOS_RSYNC = previousRsync;
      spawn.mockReset();
    }
  });

  describe.skipIf(process.platform === 'win32')('owner-only credential restore', () => {
    const settings = 'settings.json';
    const visitor = 'managed-visitor-credentials.json';
    const other = `restore-integrity/${settings}`;
    const snapshotBytes = '{ "example": "snapshot" }\n';
    const liveBytes = '{ "example": "live" }\n';
    const livePath = name => joinPath(PATHS.data, name);
    const mode = async path => (await realFs.stat(path)).mode & 0o777;

    async function writeLegacySnapshot(name) {
      const hash = await writeSnapshotFile(name, snapshotBytes);
      await realFs.chmod(joinPath(snapshotDataDir, name), 0o644);
      return hash;
    }

    afterEach(async () => {
      await realFs.rm(livePath(settings), { force: true });
      await realFs.rm(livePath(visitor), { force: true });
    });

    it('previews and restores verified credential bytes and permissions in a full restore', async () => {
      credentialRestoreLock.mockClear();
      await writeManifest({
        [settings]: await writeLegacySnapshot(settings),
        [visitor]: await writeLegacySnapshot(visitor),
        [other]: await writeLegacySnapshot(other),
      });
      await realFs.writeFile(livePath(settings), liveBytes, { mode: 0o600 });
      await realFs.writeFile(livePath(visitor), snapshotBytes, { mode: 0o644 });
      await realFs.chmod(livePath(visitor), 0o644);
      spawn.mockImplementation((...args) => spawnChild(...args));

      const preview = await restoreSnapshot(tmpRoot, 'snap-1');
      expect(preview.verification).toMatchObject({ status: 'verified', checkedFiles: 3 });
      expect(preview.changedFiles).toHaveLength(3);
      expect(preview.changedFiles).toEqual(expect.arrayContaining([
        `>fc........ ${settings}`, `.f...p..... ${visitor}`, expect.stringContaining(other),
      ]));
      expect(await mode(livePath(visitor))).toBe(0o644);
      expect(await realFs.readFile(livePath(settings), 'utf8')).toBe(liveBytes);
      await expect(realFs.stat(livePath(other))).rejects.toMatchObject({ code: 'ENOENT' });

      const result = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false });
      expect(credentialRestoreLock).toHaveBeenCalledOnce();
      expect(result.changedFiles).toEqual(preview.changedFiles);
      for (const name of [settings, visitor]) {
        expect(await realFs.readFile(livePath(name), 'utf8')).toBe(snapshotBytes);
        expect(await mode(livePath(name))).toBe(0o600);
        expect(await mode(joinPath(snapshotDataDir, name))).toBe(0o644);
      }
      expect(await mode(livePath(other))).toBe(0o644);
      expect((await restoreSnapshot(tmpRoot, 'snap-1')).changedFiles).toEqual([]);
      expect((await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false })).changedFiles).toEqual([]);
      expect(await mode(livePath(settings))).toBe(0o600);
      expect(await mode(livePath(visitor))).toBe(0o600);
    });

    it.each([settings, visitor])('restores only %s from a pre-manifest snapshot', async subdirFilter => {
      await writeLegacySnapshot(settings);
      await writeLegacySnapshot(visitor);
      spawn.mockImplementation((...args) => spawnChild(...args));

      const preview = await restoreSnapshot(tmpRoot, 'snap-1', { subdirFilter });
      expect(preview.verification.status).toBe('unverified');
      expect(preview.changedFiles).toEqual([expect.stringContaining(subdirFilter)]);
      await expect(realFs.stat(livePath(subdirFilter))).rejects.toMatchObject({ code: 'ENOENT' });

      await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false, subdirFilter });
      expect(await mode(livePath(subdirFilter))).toBe(0o600);
      expect(await realFs.readFile(livePath(subdirFilter), 'utf8')).toBe(snapshotBytes);
      await expect(realFs.stat(livePath(subdirFilter === settings ? visitor : settings)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each([23, null])('keeps live bytes private when the bulk transfer closes with %s', async exitCode => {
      await writeLegacySnapshot(settings);
      await writeLegacySnapshot(visitor);
      await realFs.writeFile(livePath(settings), liveBytes);
      await realFs.chmod(livePath(settings), 0o644);
      const proc = fakeProc();
      spawn.mockReturnValueOnce(proc);
      const pending = restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false });
      await flush();
      const modeDuringTransfer = await mode(livePath(settings));
      proc.emit('close', exitCode);

      await expect(pending).rejects.toThrow(/rsync exited with code/);
      expect(modeDuringTransfer).toBe(0o600);
      expect(await realFs.readFile(livePath(settings), 'utf8')).toBe(liveBytes);
      expect(await mode(livePath(settings))).toBe(0o600);
      await expect(realFs.stat(livePath(visitor))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(reloadSettings).toHaveBeenCalledTimes(1);
    });

    it('verifies staged credential bytes before either planning or writing a restore', async () => {
      await writeManifest({ [settings]: await writeLegacySnapshot(settings) });
      await realFs.writeFile(joinPath(snapshotDataDir, settings), liveBytes);
      for (const dryRun of [true, false]) {
        await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun, subdirFilter: settings }))
          .rejects.toMatchObject({ code: 'BACKUP_FILE_INTEGRITY_FAILED' });
      }
      expect(spawn).not.toHaveBeenCalled();
      await expect(realFs.stat(livePath(settings))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['source', 'destination'])('refuses a credential symlink at the %s before transferring', async side => {
      const sourcePath = joinPath(snapshotDataDir, settings);
      const target = joinPath(snapshotDataDir, 'example.json');
      const hash = await writeSnapshotFile('example.json', snapshotBytes);
      if (side === 'source') await realFs.symlink(target, sourcePath);
      else {
        await writeLegacySnapshot(settings);
        await realFs.symlink(target, livePath(settings));
      }
      await writeManifest({ [settings]: hash, 'example.json': hash });
      for (const dryRun of [true, false]) {
        await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun, subdirFilter: settings }))
          .rejects.toMatchObject({ code: 'BACKUP_RESTORE_UNSAFE_CREDENTIAL' });
      }
      expect(spawn).not.toHaveBeenCalled();
      expect(await realFs.readFile(target, 'utf8')).toBe(snapshotBytes);
    });
  });

  // #10898: a verified source is worth nothing if it can be deleted while rsync
  // still reads it. The child is paused after spawn so each interleaving is
  // deterministic; verification, ownership and deletion run for real.
  describe('snapshot source lifetime (#10898)', () => {
    const relativePath = 'restore-integrity/example.json';

    beforeEach(async () => {
      await writeManifest({ [relativePath]: await writeSnapshotFile(relativePath, 'trusted backup') });
    });

    async function startRestore(options) {
      const proc = fakeProc();
      spawn.mockReturnValueOnce(proc);
      const pending = restoreSnapshot(tmpRoot, 'snap-1', options);
      await flush();
      return { proc, pending };
    }

    it('refuses deletion through a source alias while a manifested restore reads the snapshot, until rsync closes', async () => {
      // A symlinked destination plus an explicit current-machine source is a
      // second spelling of the same snapshot; it must meet the same owner.
      const aliasRoot = await realFs.mkdtemp(joinPath(tmpdir(), 'portos-restore-alias-'));
      const aliasDest = joinPath(aliasRoot, 'dest');
      await realFs.symlink(tmpRoot, aliasDest, 'dir');
      try {
        const { proc, pending } = await startRestore({ dryRun: false, subdirFilter: 'restore-integrity' });

        await expect(deleteSnapshot(aliasDest, 'snap-1', { source: machineHost }))
          .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_IN_USE', context: { snapshotId: 'snap-1' } });
        await expect(realFs.stat(snapshotDir)).resolves.toBeDefined();

        proc.emit('close', 0);
        await expect(pending).resolves.toMatchObject({ dryRun: false, verification: { status: 'verified' } });
        await deleteSnapshot(aliasDest, 'snap-1', { source: machineHost });
        await expect(realFs.stat(snapshotDir)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await realFs.rm(aliasRoot, { recursive: true, force: true });
      }
    });

    it('refuses a new reader while an admitted deletion is still running', async () => {
      let openGate;
      const gate = new Promise(resolveGate => { openGate = resolveGate; });
      // deleteSnapshot's first stat is its existence check, made under the lease.
      fs.stat.mockImplementationOnce(async (path) => { await gate; return realFs.stat(path); });
      const deleting = deleteSnapshot(tmpRoot, 'snap-1');
      await vi.waitFor(() => expect(fs.stat).toHaveBeenCalled());

      await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true }))
        .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_DELETING' });
      await expect(openSnapshotStream(tmpRoot, 'snap-1', { source: machineHost }))
        .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_DELETING' });
      expect(spawn).not.toHaveBeenCalled();

      openGate();
      await expect(deleting).resolves.toMatchObject({ deleted: true });
      await expect(realFs.stat(snapshotDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects a live restore whose source vanished (rsync exit 24) as partial, reconciles caches, and releases the source', async () => {
      const { proc, pending } = await startRestore({ dryRun: false, subdirFilter: 'restore-integrity' });
      reloadSettings.mockClear();
      proc.stderr.emit('data', Buffer.from('file has vanished: "restore-integrity/example.json"'));
      proc.emit('close', 24);

      await expect(pending).rejects.toThrow(/rsync exited with code 24 \(source files vanished during transfer\).*not transactional/s);
      expect(reloadSettings).toHaveBeenCalledTimes(1);
      await expect(deleteSnapshot(tmpRoot, 'snap-1')).resolves.toMatchObject({ deleted: true });
    });

    it('rejects a preview whose source vanished (rsync exit 24) rather than reporting a clean plan', async () => {
      const { proc, pending } = await startRestore({ dryRun: true });
      proc.emit('close', 24);

      await expect(pending).rejects.toThrow(/rsync exited with code 24/);
      await expect(deleteSnapshot(tmpRoot, 'snap-1')).resolves.toMatchObject({ deleted: true });
    });

    it('releases the source when the integrity preflight refuses the restore', async () => {
      await writeSnapshotFile('restore-integrity/unrecorded.json', 'added after backup');

      await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false }))
        .rejects.toMatchObject({ code: 'BACKUP_FILE_INTEGRITY_FAILED' });
      expect(spawn).not.toHaveBeenCalled();
      await expect(deleteSnapshot(tmpRoot, 'snap-1')).resolves.toMatchObject({ deleted: true });
    });
  });
});
