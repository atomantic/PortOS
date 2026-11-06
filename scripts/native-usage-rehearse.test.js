import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNativeUsageReport, nativeUsageParticipantKey as key } from '../server/lib/nativeUsageContract.js';
import { buildNativeUsageStage } from '../server/lib/nativeUsageStaging.js';
import { buildNativeUsageBackup, NATIVE_USAGE_REHEARSAL_FILES, verifyNativeUsageBackup } from '../server/lib/nativeUsageRehearsal.js';
import { runNativeUsageRehearsalCli } from './native-usage-rehearse.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, open: vi.fn(actual.open) };
});

const hosts = ['host-a', 'host-b', 'host-c'];
const capturedAt = '2026-03-02T00:00:00.000Z';
const acquiredAt = '2026-03-01T00:00:00.000Z';
const codeCommit = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const missingSource = {
  status: 'unavailable', summary: null,
  coverage: {
    files: 0, records: 0, measuredRecords: 0, missingUsageRecords: 0, missingIdentityRecords: 0, duplicateRecords: 0, conflictingRecords: 0,
    invalidLines: 0, undatedRecords: 0, unreadableFiles: 0, skippedLinks: 0, missingSource: true, capped: false, stoppedEarly: false,
    oversizedLines: 0, streamingSupersededRecords: 0, unfinalizedRecords: 0, fieldInconsistentRecords: 0, runtimeVersions: [], steps: null,
    cacheOverlap: null, costTickRecords: null, firstObservedAt: null, lastObservedAt: null,
  },
};
const stage = () => buildNativeUsageStage({
  request: { version: 1, participants: hosts.map(key), selections: [{ family: 'codex', accountLabel: 'acct-a', members: hosts.map(key), authoritativeParticipant: key(hosts[0]) }] },
  reports: hosts.map(instanceId => buildNativeUsageReport({ instanceId, capturedAt, transcripts: { agy: missingSource, claude: missingSource, grok: missingSource },
    scanLimits: { bytes: 10000, lineBytes: 1000, entries: 100, records: 100, milliseconds: 1000, depth: 8 },
    codexEvidence: { runtimeVersion: '0.166.0', accountBefore: { status: 'read', account: { authMethod: 'chatgpt', planType: 'plus' } },
      accountAfter: { status: 'read', account: { authMethod: 'chatgpt', planType: 'plus' } },
      usage: { summary: { lifetimeTokens: 100 }, dailyUsageBuckets: [{ startDate: '2026-03-01', tokens: 40 }] } },
  })),
});
const input = (host = hosts[0], epoch = 'native-rehearsal') => {
  const usageLedger = bytes({ totalTokens: { input: 10, output: 5 }, reconciledRuns: { 'run-a': { codexHighWater: 15 } },
    interactiveScan: { watermarks: { codex: 15 } }, unknownLegacyField: 'preserve without normalization' });
  const peerDigests = bytes({ instances: {}, tombstones: [{ instanceId: 'old-peer', deletedAt: acquiredAt }], selfVersion: { version: 3 } });
  const fingerprints = { usageLedger: hash(usageLedger), peerDigests: hash(peerDigests) };
  const barrierRecord = bytes({ version: 1, state: 'fenced', migrationEpoch: epoch, participants: hosts,
    fingerprints, acquiredAt, fencedAt: acquiredAt, spool: [{ seq: 1, at: acquiredAt, op: 'recordTokens', args: ['provider-a', 5] }],
    deferredRetirements: [], retiredEpochs: ['previous-epoch'], nextSeq: 2 });
  const barrierStatus = bytes({ barrierSchema: 1, state: 'fenced', migrationEpoch: epoch, writersHeld: true,
    participants: hosts.map(instanceId => ({ instanceId, self: instanceId === host, ack: null })),
    fingerprints, acquiredAt, fencedAt: acquiredAt,
    outstanding: { inFlight: { usageLedger: 0, peerDigests: 0 }, retainedWrites: 1, retainedFrom: acquiredAt, retainedTo: acquiredAt, deferredRetirements: 0 } });
  const files = { usageLedger, peerDigests, barrierRecord, barrierStatus };
  const request = { version: 1, participantKey: key(host), capturedAt, codeCommit,
    schemas: { report: 4, stage: 1, barrier: 1, rehearsal: 1 },
    files: Object.fromEntries(Object.entries(files).map(([role, value]) => [role, { sha256: hash(value), bytes: value.length }])) };
  return { stage: stage(), files, request };
};
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
