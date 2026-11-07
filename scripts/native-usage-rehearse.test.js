import { hosts, capturedAt, acquiredAt, codeCommit, hash, bytes, stage, input } from './lib/nativeUsageRehearsal.testFixture.js';
import { mkdtemp, mkdir, lstat, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNativeUsageStage } from '../server/lib/nativeUsageStaging.js';
import { nativeUsageParticipantKey as key } from '../server/lib/nativeUsageContract.js';
import { buildNativeUsageBackup, NATIVE_USAGE_REHEARSAL_FILES, verifyNativeUsageBackup } from '../server/lib/nativeUsageRehearsal.js';
import { runNativeUsageRehearsalCli } from './native-usage-rehearse.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

const replace = (fixture, role, edit) => {
  const value = JSON.parse(fixture.files[role]);
  edit(value);
  fixture.files[role] = bytes(value);
  fixture.request.files[role] = { sha256: hash(fixture.files[role]), bytes: fixture.files[role].length };
  return fixture;
};
let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'usage-rehearsal-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const run = async args => {
  let stdout = '';
  let stderr = '';
  const code = await runNativeUsageRehearsalCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr, result: stdout ? JSON.parse(stdout) : null };
};
async function prepare(fixture = input(), name = 'source') {
  const source = join(dir, name);
  await mkdir(source, { recursive: true });
  for (const [role, value] of Object.entries(fixture.files)) await writeFile(join(source, NATIVE_USAGE_REHEARSAL_FILES[role]), value);
  const stagePath = join(dir, 'stage.json');
  const requestPath = join(source, 'request.json');
  await writeFile(stagePath, bytes(fixture.stage));
  await writeFile(requestPath, bytes(fixture.request));
  return ['backup', stagePath, requestPath, source, join(dir, 'backups')];
}
async function rehearse(fixture, name) {
  const args = await prepare(fixture, name);
  const saved = (await run(args)).result;
  const backupPath = join(args[4], saved.fileName);
  const restored = (await run(['restore', args[1], backupPath, join(dir, 'restores')])).result;
  return { args, backupPath, restored, restorePath: join(dir, 'restores', restored.directoryName) };
}

describe('offline barrier-store backup and restore rehearsal', () => {
  it('verifies three isolated restores but keeps full backup, runtime and live activation gates closed', async () => {
    const results = [];
    for (const host of hosts) results.push(await rehearse(input(host), host));
    const preflight = await run(['preflight', results[0].args[1], ...results.flatMap(value => [value.backupPath, value.restorePath])]);
    expect(preflight.code).toBe(3);
    expect(preflight.result).toMatchObject({ barrierStoreRehearsalVerified: true, fullRecoveryBackup: false, activationReady: false,
      holdReasons: expect.arrayContaining(['full-store-inventory-not-verified', 'runtime-not-registered', 'fenced-interval-not-verified']) });
    for (const [index, result] of results.entries()) {
      const fixture = input(hosts[index]);
      expect(await readFile(join(result.restorePath, 'usageLedger.json'))).toEqual(fixture.files.usageLedger);
      expect(await readdir(result.restorePath)).toEqual(expect.arrayContaining(['receipt.json', 'peerDigests.json', 'usageLedger.json']));
      expect(await readdir(result.restorePath)).toHaveLength(3);
      expect(result.restored.receipt).toMatchObject({ barrierRestored: false, runtimeValidated: false, activationReady: false });
      const artifact = JSON.parse(await readFile(result.backupPath));
      expect(artifact.manifest).toMatchObject({ sourceReports: fixture.stage.manifest.reports, stageHash: fixture.stage.contentHash, retainedWrites: 1 });
      expect(Buffer.from(artifact.payload.barrierRecord, 'base64')).toEqual(fixture.files.barrierRecord);
      for (const [role, value] of Object.entries(fixture.files)) expect(await readFile(join(result.args[3], NATIVE_USAGE_REHEARSAL_FILES[role]))).toEqual(value);
      expect(preflight.stdout + JSON.stringify(result.restored)).not.toContain('run-a');
      expect(preflight.stdout + JSON.stringify(result.restored)).not.toContain(dir);
      if (process.platform !== 'win32') expect((await stat(result.backupPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('publishes identical retries/concurrent backups once, leaves incomplete files alone, and never reuses a restore directory', async () => {
    const args = await prepare();
    await mkdir(join(args[4], '.native-usage-backup-interrupted'), { recursive: true });
    await writeFile(join(args[4], '.native-usage-backup-interrupted', 'backup.json'), '{');
    const [a, b] = await Promise.all([run(args), run(args)]);
    expect(a.stdout).toBe(b.stdout);
    expect((await run(args)).stdout).toBe(a.stdout);
    const restoreArgs = ['restore', args[1], join(args[4], a.result.fileName), join(dir, 'restores')];
    const first = (await run(restoreArgs)).result;
    const second = (await run(restoreArgs)).result;
    expect(first.directoryName).not.toBe(second.directoryName);
    expect(first.receipt).toEqual(second.receipt);
    expect((await readdir(args[4])).filter(name => name.endsWith('.json'))).toHaveLength(1);
  });

  it('refuses stale/corrupt source bytes and missing stores before publishing any backup', async () => {
    const args = await prepare();
    await writeFile(join(args[3], 'usage.json'), '{}');
    await expect(run(args)).rejects.toThrow('source-fingerprint-mismatch');
    await expect(stat(args[4])).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(args[3], 'peer-usage.json'));
    await expect(run(args)).rejects.toMatchObject({ code: 'ENOENT' });
    const bad = input();
    bad.files.usageLedger = bytes(null);
    bad.request.files.usageLedger = { sha256: hash(bad.files.usageLedger), bytes: bad.files.usageLedger.length };
    expect(() => buildNativeUsageBackup(bad)).toThrow('store-json-invalid');
  });

  it('refuses a pathname replaced during a read even when the old open handle has unchanged bytes', async () => {
    const args = await prepare();
    const replacement = join(dir, 'replacement.json');
    await writeFile(replacement, await readFile(args[1]));
    const actual = await vi.importActual('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...openArgs) => {
      const handle = await actual.open(...openArgs);
      const read = handle.read.bind(handle);
      let replaced = false;
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!replaced) { replaced = true; await rename(replacement, args[1]); }
        return result;
      };
      return handle;
    });
    await expect(run(args)).rejects.toThrow('input-changed');
    await expect(stat(args[4])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses wrong schema, identity, participants, undrained state and mismatched spool/fingerprint evidence', () => {
    const invalidSchema = input(); invalidSchema.request.schemas.barrier = 2;
    const wrongIdentity = input(); wrongIdentity.request.participantKey = key('different-host');
    const cases = [invalidSchema, wrongIdentity,
      replace(input(), 'barrierRecord', value => { value.participants.pop(); }),
      replace(input(), 'barrierStatus', value => { value.participants[0].self = false; }),
      replace(input(), 'barrierStatus', value => { value.outstanding.inFlight.usageLedger = 1; }),
      replace(input(), 'barrierRecord', value => { value.state = 'activated'; }),
      replace(input(), 'barrierStatus', value => { value.outstanding.retainedWrites = 0; }),
      replace(input(), 'barrierRecord', value => { value.fingerprints.usageLedger = 'b'.repeat(64); }),
      replace(input(), 'barrierStatus', value => { value.barrierSchema = 2; }),
    ];
    for (const fixture of cases) expect(() => buildNativeUsageBackup(fixture)).toThrow('Native usage rehearsal refused');
  });

  it('requires all participants exactly once and matching code/epoch, not just a valid receipt from one host', async () => {
    const a = await rehearse(input(), 'a');
    await expect(run(['preflight', a.args[1], a.backupPath, a.restorePath])).rejects.toThrow('participant-set-mismatch');
    await expect(run(['preflight', a.args[1], ...Array(3).fill([a.backupPath, a.restorePath]).flat()])).rejects.toThrow('participant-set-mismatch');
    const b = await rehearse(input(hosts[1]), 'b');
    const fixture = input(hosts[2]); fixture.request.codeCommit = 'b'.repeat(40);
    const c = await rehearse(fixture, 'c');
    await expect(run(['preflight', a.args[1], ...[a, b, c].flatMap(value => [value.backupPath, value.restorePath])])).rejects.toThrow('code-or-epoch-mismatch');
    const d = await rehearse(input(hosts[2], 'another-epoch'), 'd');
    await expect(run(['preflight', a.args[1], ...[a, b, d].flatMap(value => [value.backupPath, value.restorePath])])).rejects.toThrow('code-or-epoch-mismatch');
  });

  it('rereads restored bytes and refuses missing/interrupted receipts, changed files or extra barrier files', async () => {
    const a = await rehearse(input(), 'a');
    const args = ['preflight', a.args[1], a.backupPath, a.restorePath];
    const receipt = await readFile(join(a.restorePath, 'receipt.json'));
    await rm(join(a.restorePath, 'receipt.json'));
    await expect(run(args)).rejects.toThrow('restore-file-set-mismatch');
    await writeFile(join(a.restorePath, 'receipt.json'), receipt);
    await writeFile(join(a.restorePath, 'usage-cutover-barrier.json'), '{}');
    await expect(run(args)).rejects.toThrow('restore-file-set-mismatch');
    await rm(join(a.restorePath, 'usage-cutover-barrier.json'));
    await writeFile(join(a.restorePath, 'usageLedger.json'), '{}');
    await expect(run(args)).rejects.toThrow('restored-store-mismatch');
  });

  it('binds backup contents to the stage and refuses existing corrupted publications without repairing them', async () => {
    const args = await prepare();
    const result = (await run(args)).result;
    const path = join(args[4], result.fileName);
    const artifact = JSON.parse(await readFile(path));
    artifact.manifest.activationReady = true;
    expect(() => verifyNativeUsageBackup(stage(), artifact)).toThrow('backup-mismatch');
    const changed = stage(); changed.inputs.request.selections[0].accountLabel = 'acct-b';
    const changedStage = buildNativeUsageStage(changed.inputs);
    // Compare after reading so the assertion callback stays synchronous.
    const original = JSON.parse(await readFile(path));
    expect(() => verifyNativeUsageBackup(changedStage, original)).toThrow('backup-mismatch');
    await writeFile(path, '{}');
    await expect(run(args)).rejects.toThrow('existing-backup-mismatch');
    expect(await readFile(path, 'utf8')).toBe('{}');
  });

  it('rejects input and restore symlinks and exposes no activation command', async () => {
    const args = await prepare();
    const saved = (await run(args)).result;
    const sourceFile = join(args[3], 'usage.json');
    await rm(sourceFile);
    await symlink(args[1], sourceFile);
    await expect(run(args)).rejects.toThrow('input-not-bounded-regular-file');
    const restored = (await run(['restore', args[1], join(args[4], saved.fileName), join(dir, 'restores')])).result;
    const target = join(dir, 'restores', restored.directoryName);
    await rm(join(target, 'usageLedger.json'));
    await symlink(args[1], join(target, 'usageLedger.json'));
    await expect(run(['preflight', args[1], join(args[4], saved.fileName), target])).rejects.toThrow('input-not-bounded-regular-file');
    expect((await run(['activate'])).code).toBe(2);
  });
});

const dumpTables = ['memories', 'memory_links', 'cos_agents', 'ai_connections', 'ai_harness_bindings', 'ai_route_bindings', 'schema_migrations'];
const dump = tables => '-- PostgreSQL database dump\n'
  + tables.map(name => `CREATE TABLE public.${name} (\n id text\n);\n`).join('')
  + '\n--\n-- PostgreSQL database dump complete\n--\n';

async function standardSnapshot() {
  const fixture = input();
  const saved = await rehearse(fixture, 'bound-stores');
  const root = join(dir, 'standard-snapshot');
  const data = join(root, 'data');
  await mkdir(data, { recursive: true });
  const contents = {
    'usage.json': fixture.files.usageLedger, 'peer-usage.json': fixture.files.peerDigests,
    'usage-cutover-barrier.json': fixture.files.barrierRecord,
    'claude-code-transcript-usage.json': bytes({ history: { 'private-history-key': 17 } }),
    'settings.json': bytes({ backup: { excludePaths: ['private'] } }),
    'providers.json': bytes({ providers: [{ id: 'private-provider' }] }),
    'instances.json': bytes({ self: { instanceId: hosts[0] }, peers: [{ pairSecret: 'synthetic-pair-secret' }] }),
    'private/api-keys.json': bytes({ provider: 'synthetic-api-secret' }),
    'runs/private-run-id/metadata.json': bytes({ source: 'private-attribution' }),
    'runs/private-run-id/output.txt': Buffer.from(''),
    'cos/run-events.jsonl': Buffer.from('{"id":"private-run-id"}\n'),
    'cos/run-events.1.jsonl': Buffer.from('{"id":"archived-private-run"}\n'),
    [`image-render-usage/${'e'.repeat(64)}.json`]: bytes({ id: 'private-receipt' }),
    'migrations.applied.json': bytes(['001-example.js']),
    'migrations/.applied.json': bytes([]),
  };
  for (const [name, value] of Object.entries(contents)) {
    const target = join(data, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, value);
  }
  const sql = dump(dumpTables);
  await writeFile(join(root, 'portos-db.sql'), sql);
  const manifest = { generatedAt: capturedAt, fileCount: Object.keys(contents).length + 1,
    files: { ...Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, hash(value)])), '../portos-db.sql': hash(sql) },
    assetConsistency: { scope: 'global', outstanding: [] } };
  await writeFile(join(root, 'manifest.json'), bytes(manifest));
  const args = ['snapshot-preflight', saved.args[1], saved.backupPath, root];
  return { root, data, manifest, args };
}
const saveManifest = fixture => writeFile(join(fixture.root, 'manifest.json'), bytes(fixture.manifest));
async function replaceSnapshotFile(fixture, name, content) {
  await writeFile(name === '../portos-db.sql' ? join(fixture.root, 'portos-db.sql') : join(fixture.data, name), content);
  fixture.manifest.files[name] = hash(content);
  fixture.manifest.fileCount = Object.keys(fixture.manifest.files).length;
  await saveManifest(fixture);
}

describe('detached standard snapshot preflight', () => {
  it('checks actual bytes and fixed inventory groups without claiming complete sources, matched runtime or restored SQL', async () => {
    const fixture = await standardSnapshot();
    const before = await readFile(join(fixture.root, 'manifest.json'));
    const first = await run(fixture.args);
    expect(first.code).toBe(3);
    expect(first.result).toMatchObject({
      snapshotIntegrityVerified: true, participantIdentityMatched: true, fullStoreInventoryVerified: false, fullRecoveryBackup: false, activationReady: false,
      checkedFiles: fixture.manifest.fileCount, inventoryScope: 'detached-snapshot-only',
      groups: { usageLedger: { status: 'present-in-snapshot', files: 1 },
        runOutput: { status: 'present-in-snapshot', files: 1 },
        legacyInteractiveScan: { status: 'absent-from-snapshot', files: 0 },
        quotaReadings: { status: 'absent-from-snapshot', files: 0 },
        privateConfiguration: { status: 'present-in-snapshot', files: 1 },
        rotatedLifecycleLog: { status: 'present-in-snapshot', files: 1 } },
      code: { commit: codeCommit, evidence: 'barrier-backup-operator-supplied', matchedRuntimeVerified: false },
      fileMigrations: { status: 'present-in-snapshot', selected: 'current', matchedToCode: false, appliedStateVerified: false },
      database: { envelopeVerified: true, requiredTableDefinitionsPresent: true, schemaAndMigrationsMatched: false, restoreVerified: false },
      holdReasons: expect.arrayContaining(['source-inventory-and-exclusions-not-verified', 'native-source-preservation-not-verified', 'database-restore-not-verified']),
    });
    expect((await run(fixture.args)).stdout).toBe(first.stdout);
    expect(await readFile(join(fixture.root, 'manifest.json'))).toEqual(before);
    expect(await readdir(fixture.root)).toEqual(['data', 'manifest.json', 'portos-db.sql']);
    for (const privateValue of [dir, 'private-run-id', 'private-provider', 'synthetic-api-secret', 'synthetic-pair-secret', 'private-history-key']) {
      expect(first.stdout).not.toContain(privateValue);
    }
  });

  it('supports portable manifest separators and ignores only unmanifested regular OS metadata', async () => {
    const fixture = await standardSnapshot();
    const name = 'runs/private-run-id/metadata.json';
    fixture.manifest.files[name.replaceAll('/', '\\')] = fixture.manifest.files[name];
    delete fixture.manifest.files[name];
    await saveManifest(fixture);
    await writeFile(join(fixture.data, '.DS_Store'), 'metadata');
    expect((await run(fixture.args)).result).toMatchObject({ snapshotIntegrityVerified: true, ignoredMetadataFiles: 1 });
  });

  it.each([
    ['path traversal', f => { f.files['../outside.json'] = hash('{}'); }, 'snapshot-manifest-path-invalid'],
    ['drive path', f => { f.files['C:\\outside.json'] = hash('{}'); }, 'snapshot-manifest-path-invalid'],
    ['normalized alias', f => { f.files['private\\api-keys.json'] = f.files['private/api-keys.json']; }, 'snapshot-manifest-path-duplicate'],
    ['hash shape', f => { f.files['settings.json'] = 'broken'; }, 'snapshot-manifest-hash-invalid'],
    ['missing dump entry', f => { delete f.files['../portos-db.sql']; }, 'snapshot-database-dump-missing'],
  ])('refuses a %s before reading payloads', async (_label, edit, reason) => {
    const fixture = await standardSnapshot();
    edit(fixture.manifest);
    fixture.manifest.fileCount = Object.keys(fixture.manifest.files).length;
    await saveManifest(fixture);
    await expect(run(fixture.args)).rejects.toThrow(reason);
  });

  it('requires a readable standard manifest with a matching count and an existing dump', async () => {
    const fixture = await standardSnapshot();
    const path = join(fixture.root, 'manifest.json');
    await rm(path);
    await expect(run(fixture.args)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, '{');
    await expect(run(fixture.args)).rejects.toThrow('snapshot-json-invalid');
    fixture.manifest.fileCount += 1;
    await saveManifest(fixture);
    await expect(run(fixture.args)).rejects.toThrow('snapshot-manifest-count-mismatch');
    fixture.manifest.fileCount -= 1;
    await saveManifest(fixture);
    await rm(join(fixture.root, 'portos-db.sql'));
    await expect(run(fixture.args)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a pre-fence snapshot timestamp and noncanonical timestamp text', async () => {
    const fixture = await standardSnapshot();
    fixture.manifest.generatedAt = '2026-02-28T23:59:59.000Z';
    await saveManifest(fixture);
    await expect(run(fixture.args)).rejects.toThrow('snapshot-capture-precedes-fence');
    fixture.manifest.generatedAt = 'March 2, 2026 (private timestamp comment)';
    await saveManifest(fixture);
    await expect(run(fixture.args)).rejects.toThrow('snapshot-manifest-invalid');
  });

  it('refuses changed payloads even if the manifest is internally valid, including private config', async () => {
    const fixture = await standardSnapshot();
    await writeFile(join(fixture.data, 'private/api-keys.json'), '{"provider":"changed"}');
    await expect(run(fixture.args)).rejects.toThrow('snapshot-file-hash-mismatch');
    await replaceSnapshotFile(fixture, 'private/api-keys.json', '{}');
    await replaceSnapshotFile(fixture, 'usage.json', '{}');
    await expect(run(fixture.args)).rejects.toThrow('snapshot-barrier-backup-mismatch');
  });

  it('refuses missing and extra files, and never treats a failed snapshot as completed', async () => {
    const fixture = await standardSnapshot();
    await writeFile(join(fixture.data, 'extra.json'), '{}');
    await expect(run(fixture.args)).rejects.toThrow('snapshot-inventory-mismatch');
    await rm(join(fixture.data, 'extra.json'));
    await rm(join(fixture.data, 'settings.json'));
    await expect(run(fixture.args)).rejects.toThrow('snapshot-inventory-mismatch');
    await writeFile(join(fixture.root, '.failed'), 'synthetic failure');
    await expect(run(fixture.args)).rejects.toThrow('snapshot-incomplete-or-failed');
    await rm(join(fixture.root, '.failed'));
    await writeFile(join(dir, '.standard-snapshot.in-progress'), 'synthetic writer');
    await expect(run(fixture.args)).rejects.toThrow('snapshot-incomplete-or-failed');
  });

  it('refuses linked directories and dump files without following their targets', async () => {
    const fixture = await standardSnapshot();
    await rename(join(fixture.data, 'private'), join(dir, 'linked-private'));
    await symlink(join(dir, 'linked-private'), join(fixture.data, 'private'), 'dir');
    await expect(run(fixture.args)).rejects.toThrow('snapshot-input-not-bounded-regular-file');
    await rm(join(fixture.data, 'private'));
    await rename(join(dir, 'linked-private'), join(fixture.data, 'private'));
    await rename(join(fixture.root, 'portos-db.sql'), join(dir, 'linked.sql'));
    await symlink(join(dir, 'linked.sql'), join(fixture.root, 'portos-db.sql'));
    await expect(run(fixture.args)).rejects.toThrow('snapshot-input-not-bounded-regular-file');
  });

  it('requires a checked dump hash, complete envelope and real attribution/schema table definitions', async () => {
    const fixture = await standardSnapshot();
    await writeFile(join(fixture.root, 'portos-db.sql'), dump(dumpTables).replace('dump complete', 'incomplete'));
    await expect(run(fixture.args)).rejects.toThrow('snapshot-file-hash-mismatch');
    await replaceSnapshotFile(fixture, '../portos-db.sql', dump(dumpTables).replace('dump complete', 'incomplete'));
    await expect(run(fixture.args)).rejects.toThrow('snapshot-database-envelope-invalid');
    const missing = dump(dumpTables.filter(name => name !== 'cos_agents')).replace('-- PostgreSQL database dump complete',
      '-- CREATE TABLE public.cos_agents (\n-- PostgreSQL database dump complete');
    await replaceSnapshotFile(fixture, '../portos-db.sql', missing);
    await expect(run(fixture.args)).rejects.toThrow('snapshot-database-envelope-invalid');
  });

  it('refuses a different participant identity even when ledger, peer and barrier bytes are identical', async () => {
    const fixture = await standardSnapshot();
    await replaceSnapshotFile(fixture, 'instances.json', bytes({ self: { instanceId: hosts[1] } }));
    await expect(run(fixture.args)).rejects.toThrow('snapshot-participant-identity-mismatch');
    await replaceSnapshotFile(fixture, 'instances.json', bytes({ self: {} }));
    await expect(run(fixture.args)).rejects.toThrow('snapshot-participant-identity-mismatch');
    await rm(join(fixture.data, 'instances.json'));
    delete fixture.manifest.files['instances.json'];
    fixture.manifest.fileCount -= 1;
    await saveManifest(fixture);
    await expect(run(fixture.args)).rejects.toThrow('snapshot-participant-identity-missing');
  });

  it('refuses exhausted aggregate byte and elapsed budgets without a partial integrity verdict', async () => {
    const fixture = await standardSnapshot();
    const actual = await vi.importActual('node:fs/promises');
    const dumpPath = join(fixture.root, 'portos-db.sql');
    open.mockClear();
    lstat.mockImplementation(async path => {
      const info = await actual.lstat(path);
      if (path === dumpPath) info.size = 100 * 1024 ** 3;
      return info;
    });
    try {
      await expect(run(fixture.args)).rejects.toThrow('snapshot-byte-limit-exceeded');
      expect(open.mock.calls.some(([path]) => path === dumpPath)).toBe(false);
    } finally { lstat.mockImplementation(actual.lstat); }
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(15 * 60 * 1000 + 1);
    try { await expect(run(fixture.args)).rejects.toThrow('snapshot-time-limit-exceeded'); }
    finally { clock.mockRestore(); }
  });

  it('bounds a growing dump to the pinned size plus one and refuses the changed input', async () => {
    const fixture = await standardSnapshot();
    const path = join(fixture.root, 'portos-db.sql');
    const size = (await stat(path)).size;
    const actual = await vi.importActual('node:fs/promises');
    let scanned = 0;
    open.mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] !== path) return handle;
      const inspect = handle.stat.bind(handle);
      let changed = false;
      handle.stat = async () => {
        const info = await inspect();
        if (!changed) { changed = true; await writeFile(path, 'x'.repeat(1024 * 1024), { flag: 'a' }); }
        return info;
      };
      const createStream = handle.createReadStream.bind(handle);
      handle.createReadStream = options => {
        expect(options.end).toBe(size);
        const stream = createStream(options);
        stream.on('data', chunk => { scanned += chunk.length; });
        return stream;
      };
      return handle;
    });
    try {
      await expect(run(fixture.args)).rejects.toThrow('snapshot-input-changed');
      expect(scanned).toBe(size + 1);
    } finally { open.mockImplementation(actual.open); }
  });

  it('detects replacement of an already checked payload before the final inventory pass', async () => {
    const fixture = await standardSnapshot();
    const actual = await vi.importActual('node:fs/promises');
    let changed = false;
    open.mockImplementation(async (...args) => {
      if (!changed && args[0] === join(fixture.data, 'providers.json')) {
        changed = true;
        const path = join(fixture.data, 'settings.json');
        const replacement = join(dir, 'replacement.json');
        await writeFile(replacement, await readFile(path));
        await rename(replacement, path);
      }
      return actual.open(...args);
    });
    try { await expect(run(fixture.args)).rejects.toThrow('snapshot-input-changed'); }
    finally { open.mockImplementation(actual.open); }
  });

  it('rechecks the sibling dump after the final data inventory and manifest reread', async () => {
    const fixture = await standardSnapshot();
    const actual = await vi.importActual('node:fs/promises');
    let manifestReads = 0;
    open.mockImplementation(async (...args) => {
      if (args[0] === join(fixture.root, 'manifest.json') && ++manifestReads === 2) {
        const path = join(fixture.root, 'portos-db.sql');
        const replacement = join(dir, 'replacement.sql');
        await writeFile(replacement, await readFile(path));
        await rename(replacement, path);
      }
      return actual.open(...args);
    });
    try { await expect(run(fixture.args)).rejects.toThrow('snapshot-input-changed'); }
    finally { open.mockImplementation(actual.open); }
  });

  it('keeps missing migration state explicit and refuses malformed preserved ledgers', async () => {
    const fixture = await standardSnapshot();
    await replaceSnapshotFile(fixture, 'migrations.applied.json', '{}');
    await expect(run(fixture.args)).rejects.toThrow('snapshot-migration-ledger-invalid');
    for (const name of ['migrations.applied.json', 'migrations/.applied.json']) {
      await rm(join(fixture.data, name));
      delete fixture.manifest.files[name];
    }
    fixture.manifest.fileCount = Object.keys(fixture.manifest.files).length;
    await saveManifest(fixture);
    expect((await run(fixture.args)).result.fileMigrations).toEqual({ status: 'absent-from-snapshot', selected: null,
      sha256: null, matchedToCode: false, appliedStateVerified: false });
  });
});
