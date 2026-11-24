/** Backup service suite: restoreSnapshot machine-local database authority. Shared mocks and helpers live in backup.test.fixture.js (#16215). */
import { authorityBodies, fakeProc, flush, useManifestVerification } from './backup.test.fixture.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { dirname, join as joinPath } from 'path';
import { createHash } from 'crypto';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { spawn } from '../lib/childProcess.js';
import { PATHS } from '../lib/fileUtils.js';
import * as fs from 'fs/promises';
import { createDatabaseAuthority } from '../lib/databaseAuthority.js';
import { restoreSnapshot, resolveRsyncBinary } from './backup.js';

describe('restoreSnapshot manifest verification', () => {
  let tmpRoot;
  let snapshotDir;
  let snapshotDataDir;
  let realFs;
  const { writeSnapshotFile, writeManifest } = useManifestVerification(state => ({ tmpRoot, snapshotDir, snapshotDataDir, realFs } = state));

  // #10064: database-authority.json is machine-local admission state. A snapshot
  // keeps it as recovery evidence, but a restore must never install it: another
  // machine's (or an older cutover's) record would fence a healthy local backend
  // as DATABASE_RETIRED_BACKEND, including across restarts. Real rsync + the real
  // authority adapter, because a mocked transfer cannot show the fence.
  describe('machine-local database authority (#10064)', () => {
    const it = authorityBodies.it;
    const native = { mode: 'native', host: '127.0.0.1', port: 5432, database: 'example_db', user: 'example_user' };
    const docker = { mode: 'docker', host: '127.0.0.1', port: 5561, database: 'example_db', user: 'example_user' };
    const authorityDoc = (operationId, source, target) => JSON.stringify({
      version: 1, operationId, releasedAt: '2026-09-01T00:00:00.000Z', source, target,
    }, null, 2) + '\n';
    const SNAPSHOT_AUTHORITY = authorityDoc('11111111-1111-4111-8111-111111111111', native, docker);
    const NEWER_LOCAL_AUTHORITY = authorityDoc('22222222-2222-4222-8222-222222222222', docker, native);
    const poolFor = endpoint => ({ host: endpoint.host, port: endpoint.port, database: endpoint.database, user: endpoint.user });
    const authorityPath = () => joinPath(PATHS.data, 'database-authority.json');
    const RECORD = 'brain/authority-neighbor.json';

    async function seedSnapshot({ withManifest = true } = {}) {
      const recordHash = await writeSnapshotFile(RECORD, '{"value":"snapshot"}');
      const authorityHash = await writeSnapshotFile('database-authority.json', SNAPSHOT_AUTHORITY);
      if (withManifest) await writeManifest({ [RECORD]: recordHash, 'database-authority.json': authorityHash });
    }

    async function withRealRsync(context, run) {
      if (process.platform === 'win32' && spawnSync('rsync', ['--version']).error?.code === 'ENOENT') {
        context.skip('Windows runner has no rsync executable; real rsync remains required on Linux/macOS.');
        return;
      }
      const previousRsync = process.env.PORTOS_RSYNC;
      delete process.env.PORTOS_RSYNC;
      spawn.mockImplementation((...args) => spawnChild(...args));
      try {
        await run();
      } finally {
        if (previousRsync === undefined) delete process.env.PORTOS_RSYNC;
        else process.env.PORTOS_RSYNC = previousRsync;
        spawn.mockReset();
        await realFs.rm(joinPath(PATHS.data, 'brain', 'authority-neighbor.json'), { force: true });
      }
    }

    for (const { name, live } of [
      { name: 'a never-federated install', live: null },
      { name: 'this machine\'s own older snapshot', live: '{"self":{"instanceId":"00000000-0000-4000-8000-000000000001"},"peers":[{"id":"newer-peer"}]}' },
    ]) {
      it(`installs instance identity bytes for ${name}, invalidating execution grants first`, async context => {
        await withRealRsync(context, async () => {
          const { createPeerExecutionAuthority } = await import('../lib/peerExecutionAuthority.js');
          const path = joinPath(PATHS.data, 'peer-execution-authority.json');
          const identityPath = joinPath(PATHS.data, 'instances.json');
          await realFs.rm(path, { force: true });
          await realFs.rm(identityPath, { force: true });
          if (live) await realFs.writeFile(identityPath, live);
          try {
            const authority = createPeerExecutionAuthority(PATHS.data);
            const before = authority.initialize();
            const identity = '{"self":{"instanceId":"00000000-0000-4000-8000-000000000001"},"peers":[]}';
            const hash = await writeSnapshotFile('instances.json', identity);
            await writeManifest({ 'instances.json': hash });
            const result = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false, subdirFilter: 'instances.json' });
            expect(result).not.toHaveProperty('identityPreserved');
            expect(authority.read().epoch).not.toBe(before.epoch);
            expect(await realFs.readFile(identityPath, 'utf8')).toBe(identity);
          } finally {
            await realFs.rm(path, { force: true });
            await realFs.rm(identityPath, { force: true });
          }
        });
      });
    }

    // #12596: a shared destination lists every machine's snapshots. Installing
    // another machine's instances.json would give two live installs one
    // federation identity, so a restore keeps the live one unless adopted.
    describe('federation identity (#12596)', () => {
      const LIVE_ID = '00000000-0000-4000-8000-00000000000a';
      const OTHER_ID = '00000000-0000-4000-8000-00000000000b';
      const LIVE_IDENTITY = JSON.stringify({ self: { instanceId: LIVE_ID }, peers: [{ id: 'live-peer' }] });
      const OTHER_IDENTITY = JSON.stringify({ self: { instanceId: OTHER_ID }, peers: [{ id: 'other-peer' }] });
      const identityPath = () => joinPath(PATHS.data, 'instances.json');

      async function seedOtherMachine({ live = LIVE_IDENTITY } = {}) {
        // A wrong manifest hash for instances.json proves a preserved identity
        // is neither verified nor transferred, like the other preserved files.
        await writeSnapshotFile('instances.json', OTHER_IDENTITY);
        const neighbor = await writeSnapshotFile(RECORD, '{"value":"snapshot"}');
        await writeManifest({ 'instances.json': '0'.repeat(64), [RECORD]: neighbor });
        await realFs.rm(joinPath(PATHS.data, RECORD), { force: true });
        await realFs.writeFile(identityPath(), live);
      }

      afterEach(async () => {
        try { await authorityBodies.drain(); }
        finally {
          await realFs.rm(identityPath(), { force: true });
          await realFs.rm(joinPath(PATHS.data, 'peer-execution-authority.json'), { force: true });
          const { resetInstanceIdCache } = await import('./instanceIdentity.js');
          resetInstanceIdCache();
        }
      });

      for (const { name, options } of [
        { name: 'full restore', options: {} },
        { name: 'folder restore of instances.json', options: { subdirFilter: 'instances.json' } },
      ]) {
        it(`a ${name} keeps a different live identity byte-for-byte and reports it in preview and execution`, async context => {
          await withRealRsync(context, async () => {
            await seedOtherMachine();
            const { getInstanceId } = await import('./instanceIdentity.js');
            expect(await getInstanceId()).toBe(LIVE_ID);
            const identityPreserved = { liveInstanceId: LIVE_ID, snapshotInstanceId: OTHER_ID };

            const preview = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true, ...options });
            expect(preview).toMatchObject({ identityPreserved, verification: { status: 'verified' } });
            expect(preview.changedFiles.some(line => line.includes('instances.json'))).toBe(false);

            const result = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false, ...options });
            expect(result).toMatchObject({ identityPreserved });
            expect(await realFs.readFile(identityPath(), 'utf8')).toBe(LIVE_IDENTITY);
            expect(await getInstanceId()).toBe(LIVE_ID);
            expect(existsSync(joinPath(PATHS.data, RECORD))).toBe(!options.subdirFilter);
          });
        });
      }

      it('keeps an unreadable live identity rather than guessing whose it was', async context => {
        await withRealRsync(context, async () => {
          await seedOtherMachine({ live: '{ not json' });
          const result = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false });
          expect(result.identityPreserved).toEqual({ liveInstanceId: null, snapshotInstanceId: OTHER_ID });
          expect(await realFs.readFile(identityPath(), 'utf8')).toBe('{ not json');
        });
      });

      it('refuses, before writing, when a live identity appears after the restore was checked', async context => {
        await withRealRsync(context, async () => {
          await seedOtherMachine();
          await writeManifest({
            'instances.json': createHash('sha256').update(OTHER_IDENTITY).digest('hex'),
            [RECORD]: createHash('sha256').update('{"value":"snapshot"}').digest('hex'),
          });
          // Never federated when checked; paired while verification runs.
          await realFs.rm(identityPath(), { force: true });
          fs.readFile.mockImplementation(async (path, ...rest) => {
            if (String(path).endsWith('manifest.json')) await realFs.writeFile(identityPath(), LIVE_IDENTITY);
            return realFs.readFile(path, ...rest);
          });

          await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false }))
            .rejects.toMatchObject({ status: 409, code: 'BACKUP_RESTORE_IDENTITY_CHANGED' });
          expect(await realFs.readFile(identityPath(), 'utf8')).toBe(LIVE_IDENTITY);
          expect(existsSync(joinPath(PATHS.data, RECORD))).toBe(false);
        });
      });

      it('never installs a snapshot identity that appeared after the check', async context => {
        await withRealRsync(context, async () => {
          // A legacy snapshot (no manifest) without instances.json when checked.
          await writeSnapshotFile(RECORD, '{"value":"snapshot"}');
          await realFs.writeFile(identityPath(), LIVE_IDENTITY);
          fs.readFile.mockImplementation(async (path, ...rest) => {
            if (String(path).endsWith('manifest.json')) await writeSnapshotFile('instances.json', OTHER_IDENTITY);
            return realFs.readFile(path, ...rest);
          });

          await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false });
          expect(await realFs.readFile(identityPath(), 'utf8')).toBe(LIVE_IDENTITY);
          expect(await realFs.readFile(joinPath(PATHS.data, RECORD), 'utf8')).toBe('{"value":"snapshot"}');
        });
      });

      it('installs an adopted identity and serves it without a restart', async context => {
        await withRealRsync(context, async () => {
          await seedOtherMachine();
          await writeManifest({
            'instances.json': createHash('sha256').update(OTHER_IDENTITY).digest('hex'),
            [RECORD]: createHash('sha256').update('{"value":"snapshot"}').digest('hex'),
          });
          const { getInstanceId } = await import('./instanceIdentity.js');
          expect(await getInstanceId()).toBe(LIVE_ID);
          const identityAdopted = { liveInstanceId: LIVE_ID, snapshotInstanceId: OTHER_ID };

          const preview = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true, adoptIdentity: true });
          expect(preview).toMatchObject({ identityAdopted });
          expect(preview).not.toHaveProperty('identityPreserved');
          expect(preview.changedFiles.some(line => line.includes('instances.json'))).toBe(true);

          const result = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false, adoptIdentity: true });
          expect(result).toMatchObject({ identityAdopted });
          expect(await realFs.readFile(identityPath(), 'utf8')).toBe(OTHER_IDENTITY);
          expect(await getInstanceId()).toBe(OTHER_ID);
        });
      });
    });

    for (const path of ['tailcat-serve.json', 'tailcat-serve.addr', 'Tailcat-Serve.json', 'tailcat-serve.json.example.tmp', 'tailcat-forwards.json', 'Tailcat-Forwards.json', 'tailcat-forwards.json.example.tmp', 'peer-execution-grants.json', 'peer-execution-catalog.json', 'peer-execution/fixture-operation/evidence.json', 'peer-execution-authority.json', 'peer-execution-recovery.jsonl', 'workflow-maintenance/state.json', 'workflow-maintenance/recovered-fixture/receipt.json', 'Workflow-Maintenance/state.json', 'backup-admission/cut/owner.json', 'Backup-Admission/publications/owner.json']) {
      it(`preserves non-rewound execution authority and ownership at ${path} (#10127)`, async context => {
        await withRealRsync(context, async () => {
          const localPath = joinPath(PATHS.data, path);
          await realFs.mkdir(dirname(localPath), { recursive: true });
          await realFs.writeFile(localPath, 'current receiver authority');
          for (const withManifest of [true, false]) {
            await realFs.rm(joinPath(snapshotDir, 'manifest.json'), { force: true });
            const hash = await writeSnapshotFile(path, 'obsolete snapshot authority');
            const neighbor = await writeSnapshotFile(RECORD, '{"value":"snapshot"}');
            if (withManifest) await writeManifest({ [path]: hash, [RECORD]: neighbor });
            const preview = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true });
            expect(preview.changedFiles.some(line => line.includes(path))).toBe(false);
            await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false });
            expect(await realFs.readFile(localPath, 'utf8')).toBe('current receiver authority');
          }
        });
      });
    }

    for (const { name, options } of [
      { name: 'full restore', options: {} },
      { name: 'brain-scoped restore', options: { subdirFilter: 'brain' } },
    ]) {
      it(`a ${name} keeps an absent destination authority absent, so a healthy native backend is still admitted`, async context => {
        await withRealRsync(context, async () => {
          for (const manifest of [true, false]) {
            await realFs.rm(joinPath(snapshotDir, 'manifest.json'), { force: true });
            await seedSnapshot({ withManifest: manifest });
            await realFs.rm(authorityPath(), { force: true });
            await realFs.rm(joinPath(PATHS.data, RECORD), { force: true });

            const preview = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true, ...options });
            expect(preview.changedFiles.some(line => line.includes('database-authority.json'))).toBe(false);
            expect(preview.changedFiles.some(line => line.includes(RECORD))).toBe(true);

            await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false, ...options });
            expect(existsSync(authorityPath())).toBe(false);
            expect(await realFs.readFile(joinPath(PATHS.data, RECORD), 'utf8')).toBe('{"value":"snapshot"}');
            expect(createDatabaseAuthority(PATHS.data).assertPool(poolFor(native))).toBeNull();
          }
        });
      });
    }

    it('keeps a newer reverse-cutover authority over an older snapshot\'s, and still refuses the genuinely retired backend', async context => {
      await withRealRsync(context, async () => {
        await seedSnapshot();
        await realFs.writeFile(authorityPath(), NEWER_LOCAL_AUTHORITY);

        await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false });

        expect(await realFs.readFile(authorityPath(), 'utf8')).toBe(NEWER_LOCAL_AUTHORITY);
        const authority = createDatabaseAuthority(PATHS.data);
        expect(authority.assertPool(poolFor(native))).toMatchObject({ operationId: '22222222-2222-4222-8222-222222222222' });
        expect(() => authority.assertPool(poolFor(docker))).toThrow(expect.objectContaining({ code: 'DATABASE_RETIRED_BACKEND' }));
      });
    });

    it('leaves a damaged destination authority byte-identical and still fail-closed', async context => {
      await withRealRsync(context, async () => {
        await seedSnapshot();
        await realFs.writeFile(authorityPath(), '{ not json');

        await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false });

        expect(await realFs.readFile(authorityPath(), 'utf8')).toBe('{ not json');
        expect(() => createDatabaseAuthority(PATHS.data).assertPool(poolFor(native)))
          .toThrow(expect.objectContaining({ code: 'DATABASE_MAINTENANCE' }));
      });
    });

    it('also keeps a mixed-case authority entry from replacing the destination record', async context => {
      await withRealRsync(context, async () => {
        await seedSnapshot();
        await writeSnapshotFile('Database-Authority.json', SNAPSHOT_AUTHORITY);
        await realFs.rm(joinPath(snapshotDataDir, 'database-authority.json'));
        await writeManifest({ [RECORD]: createHash('sha256').update('{"value":"snapshot"}').digest('hex') });
        await realFs.writeFile(authorityPath(), NEWER_LOCAL_AUTHORITY);

        await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: false });

        expect(await realFs.readFile(authorityPath(), 'utf8')).toBe(NEWER_LOCAL_AUTHORITY);
        expect(await realFs.readFile(joinPath(PATHS.data, RECORD), 'utf8')).toBe('{"value":"snapshot"}');
        await realFs.rm(joinPath(PATHS.data, 'Database-Authority.json'), { force: true });
      });
    });

    it('does not fail integrity for an authority file the restore never transfers', async () => {
      await seedSnapshot();
      await realFs.writeFile(joinPath(snapshotDataDir, 'database-authority.json'), 'edited after sealing');
      spawn.mockReturnValueOnce(fakeProc());
      const pending = restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true });
      await flush();
      spawn.mock.results[0].value.emit('close', 0);
      await expect(pending).resolves.toMatchObject({ verification: { status: 'verified', checkedFiles: 1 } });
    });

    for (const subdirFilter of ['database-authority.json', './database-authority.json', 'database-authority.json/', 'Database-Authority.json']) {
      it(`refuses an explicit ${subdirFilter} selection before verification or transfer, for preview and execution alike`, async () => {
        await seedSnapshot();
        for (const dryRun of [true, false]) {
          await expect(restoreSnapshot(tmpRoot, 'snap-1', { dryRun, subdirFilter }))
            .rejects.toMatchObject({ status: 400, code: 'BACKUP_RESTORE_MACHINE_LOCAL', message: expect.stringMatching(/machine-local/) });
        }
        expect(spawn).not.toHaveBeenCalled();
      });
    }
  });

  // #7299: `--checksum` makes rsync digest BOTH copies of every file in scope,
  // and `--itemize-changes`/`--progress` report only TRANSFERRING files. A file
  // that matches emitted nothing, so a preview of a large unchanged tree ran
  // silent for the whole digest, tripped runRsync's idle watchdog, and SIGKILLed
  // a perfectly healthy restore. `-ii` adds one unchanged-entry line per file
  // digested. The assertion is on rsync's own stdout for the exact vector
  // restoreSnapshot builds, paired with the pre-fix baseline (same vector, `-ii`
  // removed) so it discriminates rather than passing on any output at all.
  it('keeps real rsync emitting per file while checksumming an unchanged tree, without inflating the changed count', async context => {
    // Windows CI does not provision MSYS rsync. Unix coverage remains mandatory;
    // installed Windows rsync errors still fail this test rather than being hidden.
    if (process.platform === 'win32' && spawnSync('rsync', ['--version']).error?.code === 'ENOENT') {
      context.skip('Windows runner has no rsync executable; real rsync remains required on Linux/macOS.');
      return;
    }
    const unchangedPath = 'restore-watchdog/unchanged.json';
    const changedPath = 'restore-watchdog/changed.json';
    await writeManifest({
      [unchangedPath]: await writeSnapshotFile(unchangedPath, '{"value":"same"}'),
      [changedPath]: await writeSnapshotFile(changedPath, '{"value":"old"}'),
    });

    // Equal length AND identical mtime on both sides: rsync's quick check sees
    // no difference for either file, so only `--checksum` can tell them apart —
    // the very condition that makes the scan expensive and silent.
    const matchingMtime = new Date('2026-09-12T00:00:00.000Z');
    for (const [relativePath, liveContent] of [[unchangedPath, '{"value":"same"}'], [changedPath, '{"value":"new"}']]) {
      const livePath = joinPath(PATHS.data, relativePath);
      await realFs.mkdir(joinPath(livePath, '..'), { recursive: true });
      await realFs.writeFile(livePath, liveContent);
      await realFs.utimes(joinPath(snapshotDataDir, relativePath), matchingMtime, matchingMtime);
      await realFs.utimes(livePath, matchingMtime, matchingMtime);
    }

    const previousRsync = process.env.PORTOS_RSYNC;
    delete process.env.PORTOS_RSYNC;
    spawn.mockImplementation((...args) => spawnChild(...args));

    try {
      const preview = await restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true });

      // The extra `-ii` lines describe unchanged entries and start with `.`,
      // so runRsync's `>`/`<` collector must be blind to them: the reported
      // count stays exactly the files that really differ.
      expect(preview.changedFiles.some(line => line.includes(changedPath))).toBe(true);
      expect(preview.changedFiles.some(line => line.includes(unchangedPath))).toBe(false);

      const args = spawn.mock.calls[0][1];
      expect(args).toContain('-ii');
      expect(args).toContain('--checksum');

      // Replay the exact vector. `-ii` must be the SHORT form: macOS ships
      // openrsync, where a repeated long `--itemize-changes` does not stack.
      const stdoutFor = vector => spawnSync(resolveRsyncBinary(), vector, { encoding: 'utf8' }).stdout ?? '';
      expect(stdoutFor(args)).toContain(unchangedPath);
      expect(stdoutFor(args.filter(arg => arg !== '-ii'))).not.toContain(unchangedPath);
    } finally {
      if (previousRsync === undefined) delete process.env.PORTOS_RSYNC;
      else process.env.PORTOS_RSYNC = previousRsync;
      spawn.mockReset();
      await realFs.rm(joinPath(PATHS.data, 'restore-watchdog'), { recursive: true, force: true });
    }
  });

  // #7302: `-ii` heartbeats only when rsync finishes deciding about a file, so
  // ONE file whose `--checksum` digest outlasts the 10-minute idle deadline
  // emits nothing the whole time — a healthy restore reads as wedged. The
  // preflight already stats every in-scope file, so restoreSnapshot floors the
  // deadline at 2x the largest file over a worst-case throughput. Fake the
  // size, keep real bytes: hashing must stay instant, and these are the same
  // stats the production walk uses.
  const fakeFileSize = (relativePath, size) => {
    const target = joinPath(snapshotDataDir, relativePath);
    vi.spyOn(fs, 'stat').mockImplementation(async (candidate, ...args) => {
      const info = await realFs.stat(candidate, ...args);
      if (String(candidate) !== target) return info;
      // A spread would drop fs.Stats' prototype — isFile() et al. live there,
      // not on own properties — so clone onto the same prototype and override
      // only the reported size.
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { size });
    });
  };

  it('keeps a silent rsync alive past the default deadline while a huge file digests, then still enforces the scaled floor', async () => {
    // 40 GiB in scope → floor = 2 * 40 GiB / 10 MiB/s = 8192 s ≈ 136.5 min.
    const relativePath = 'restore-watchdog/huge.bin';
    await writeManifest({ [relativePath]: await writeSnapshotFile(relativePath, 'tiny real bytes') });
    fakeFileSize(relativePath, 40 * 1024 ** 3);
    vi.useFakeTimers();
    try {
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true });
      await flush();

      // Silent well past the old deadline: the floor, not the default, governs.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(proc.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120 * 60 * 1000);
      expect(proc.kill).not.toHaveBeenCalled();

      // The floor is still a deadline — a wedged digest terminates, just later.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      proc.emit('close', null, 'SIGTERM');
      await expect(pending).rejects.toMatchObject({
        code: 'BACKUP_PROCESS_TIMEOUT',
        timeoutKind: 'idle',
        message: expect.stringMatching(/minutes without progress/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('still kills a silent rsync at the default deadline when the scope holds only small files', async () => {
    const relativePath = 'restore-watchdog/small.json';
    await writeManifest({ [relativePath]: await writeSnapshotFile(relativePath, '{"a":1}') });
    vi.useFakeTimers();
    try {
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true });
      await flush();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      proc.emit('close', null, 'SIGTERM');
      await expect(pending).rejects.toMatchObject({
        code: 'BACKUP_PROCESS_TIMEOUT',
        timeoutKind: 'idle',
        message: expect.stringMatching(/10 minutes without progress/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the same scaled floor to a manifest-absent legacy snapshot', async () => {
    // No manifest: nothing to hash, but the sizing walk still runs so a huge
    // legacy file gets the same benefit of the doubt as a verified one.
    const relativePath = 'restore-watchdog/legacy-huge.bin';
    await writeSnapshotFile(relativePath, 'tiny real bytes');
    fakeFileSize(relativePath, 40 * 1024 ** 3);
    vi.useFakeTimers();
    try {
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot(tmpRoot, 'snap-1', { dryRun: true });
      await flush();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(proc.kill).not.toHaveBeenCalled();
      proc.emit('close', 0);
      await expect(pending).resolves.toMatchObject({
        verification: { status: 'unverified', reason: 'manifest_absent' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
