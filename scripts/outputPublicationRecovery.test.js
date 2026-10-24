import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMaintenanceAdmission } from '../server/lib/maintenanceAdmission.js';
import { runPublicationRecovery } from './reconcile-output-publication.mjs';

let root, data, gate, deps, operationId, hold, spec, specPath, requestPath, statePath;
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const receiptPath = request => join(gate.directory, `publication-${request.operation.id}-${request.operation.uncertaintyStamp}.json`);
const inspect = () => runPublicationRecovery(['inspect', operationId, specPath], deps);
const reconcile = (request, overrides = {}) => {
  fs.writeFileSync(requestPath, JSON.stringify(request));
  return runPublicationRecovery(['reconcile', requestPath, '--confirm-disposition'], { ...deps, ...overrides });
};

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'publication-recovery-'));
  data = join(root, 'data');
  fs.mkdirSync(join(data, 'runs', 'example-run'), { recursive: true });
  fs.writeFileSync(join(data, 'runs/example-run/metadata.json'), JSON.stringify({ id: 'example-run', success: false, transcriptWarning: 'Synthetic missing output warning' }));
  fs.writeFileSync(join(data, 'runs/example-run/failure.txt'), 'Synthetic publication callback failed; retained output completeness is unknown.');
  gate = createMaintenanceAdmission(data);
  const owner = gate.admit('settlement', 'Output publication');
  owner.markUnsettled();
  operationId = owner.id;
  gate.admit('provider', 'unrelated-owner');
  hold = gate.begin({ reason: 'Inspect synthetic publication', owner: 'Operator' }).hold;
  deps = { data, gate, pidDead: () => true };
  spec = { ownerId: 'toolkit-recording-publication',
    binding: 'Synthetic run identity and failure record link this inspected recording to the selected publication.',
    reason: 'Acknowledge this inspected failure while preserving the incomplete transcript warning.',
    files: [
      { path: 'runs/example-run/metadata.json', role: 'record', note: 'Inspected synthetic identity, failed outcome and retained warning.' },
      { path: 'runs/example-run/failure.txt', role: 'failure', note: 'Inspected the synthetic callback failure; saving remains unknown.' },
    ] };
  specPath = join(root, 'spec.json');
  requestPath = join(root, 'request.json');
  statePath = join(gate.directory, 'state.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('diagnoses selected and unrelated reservations through the executable command without writing', () => {
  const before = fs.readFileSync(statePath);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./reconcile-output-publication.mjs', import.meta.url)), 'diagnose', operationId, '--install-root', root],
    { env: { ...process.env, PORTOS_DATA_ROOT: root }, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status, result.stdout).toBe(0);
  const diagnosis = JSON.parse(result.stdout);
  expect(diagnosis.selected).toMatchObject({ id: operationId, unsettled: true, uncertaintyStamp: expect.any(String) });
  expect(diagnosis.operations).toEqual(readState().operations);
  expect(diagnosis.owners).toContainEqual(expect.objectContaining({ id: spec.ownerId }));
  expect(diagnosis.nextStep).toContain('owning workflow');
  expect(fs.readFileSync(statePath)).toEqual(before);
});

it('publishes and fsyncs evidence before retiring only the selected owner, preserving warnings and outcomes', () => {
  const before = fs.readFileSync(statePath);
  const originalRecords = spec.files.map(file => fs.readFileSync(join(data, file.path)));
  const request = inspect();
  expect(fs.readFileSync(statePath)).toEqual(before);
  expect(request.operation).toEqual(readState().operations[0]);
  expect(request.evidence[0]).toMatchObject({ path: spec.files[0].path, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  let directorySynced = false;
  let fileSynced = false;
  let linked = false;
  let inspectedUnderLock = false;
  const io = { ...fs,
    openSync(path, ...args) {
      if (path.endsWith('metadata.json')) {
        expect(fs.existsSync(join(gate.directory, 'transaction'))).toBe(true);
        inspectedUnderLock = true;
      }
      return fs.openSync(path, ...args);
    },
    linkSync(...args) { expect(fileSynced).toBe(true); fs.linkSync(...args); linked = true; },
    fsyncSync(fd) {
      fs.fsyncSync(fd);
      if (fs.fstatSync(fd).isFile()) fileSynced = true;
      if (linked && fs.fstatSync(fd).isDirectory()) directorySynced = true;
    },
    unlinkSync(path) {
      expect(directorySynced).toBe(process.platform !== 'win32');
      expect(readState().operations).toContainEqual(request.operation);
      expect(JSON.parse(fs.readFileSync(receiptPath(request))).request).toEqual(request);
      fs.unlinkSync(path);
    },
  };
  expect(reconcile(request, { io })).toMatchObject({ disposition: 'acknowledged-uncertainty', outputCompleteness: 'unknown', replayed: false });
  expect(inspectedUnderLock).toBe(true);
  expect(gate.status()).toMatchObject({ state: 'draining', hold });
  expect(gate.operations()).toEqual([expect.objectContaining({ resource: 'unrelated-owner' })]);
  expect(spec.files.map(file => fs.readFileSync(join(data, file.path)))).toEqual(originalRecords);
  const receiptBytes = fs.readFileSync(receiptPath(request));
  expect(reconcile(request).replayed).toBe(true);
  expect(fs.readFileSync(receiptPath(request))).toEqual(receiptBytes);
  fs.writeFileSync(statePath, before); // Disposable receipt-first interruption fixture.
  expect(reconcile(request).replayed).toBe(false);
  expect(fs.readFileSync(receiptPath(request))).toEqual(receiptBytes);
});

it.each(['hold', 'operation', 'stamp'])('refuses stale %s identity without publishing a receipt or retiring ownership', field => {
  const request = inspect();
  if (field === 'hold') request.hold.revision++;
  if (field === 'operation') request.operation.startedAt = new Date(0).toISOString();
  if (field === 'stamp') request.operation.uncertaintyStamp = randomUUID();
  expect(() => reconcile(request)).toThrow(field === 'hold' ? 'hold changed' : 'reservation changed');
  expect(gate.operations()).toHaveLength(2);
  expect(gate.status().hold).toEqual(hold);
  expect(fs.existsSync(receiptPath(request))).toBe(false);
});

it.each(['changed', 'missing', 'empty'])('refuses %s evidence and explains the next step', mode => {
  const request = inspect();
  const path = join(data, spec.files[1].path);
  if (mode === 'missing') fs.unlinkSync(path);
  else fs.writeFileSync(path, mode === 'empty' ? '' : 'Changed synthetic failure evidence.');
  expect(() => reconcile(request)).toThrow(/Inspect the owning workflow records/);
  expect(gate.operations()).toHaveLength(2);
  expect(gate.status().state).toBe('draining');
  expect(fs.existsSync(receiptPath(request))).toBe(false);
});

it.skipIf(process.platform === 'win32')('refuses FIFO evidence and receipts without blocking inspection or reconciliation', () => {
  const state = readState();
  state.operations[0].pid = 2147483647; // Synthetic PID outside the supported hosts' process-id range.
  fs.writeFileSync(statePath, JSON.stringify(state));
  const request = inspect();
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const path = join(data, spec.files[1].path);
  const original = fs.readFileSync(path);
  fs.unlinkSync(path);
  expect(spawnSync('mkfifo', [path]).status).toBe(0);
  const script = fileURLToPath(new URL('./reconcile-output-publication.mjs', import.meta.url));
  for (const args of [['inspect', operationId, specPath], ['reconcile', requestPath, '--confirm-disposition']]) {
    const result = spawnSync(process.execPath, [script, ...args, '--install-root', root],
      { env: process.env, encoding: 'utf8', timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Evidence must be regular files');
    expect(gate.status().state).toBe('draining');
    expect(gate.operations()).toEqual(state.operations);
  }
  fs.unlinkSync(path);
  fs.writeFileSync(path, original);
  expect(spawnSync('mkfifo', [receiptPath(request)]).status).toBe(0);
  const result = spawnSync(process.execPath, [script, 'reconcile', requestPath, '--confirm-disposition', '--install-root', root],
    { env: process.env, encoding: 'utf8', timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('No valid matching receipt');
  expect(gate.status().state).toBe('draining');
  expect(gate.operations()).toEqual(state.operations);
});

it.each(['absent', 'duplicate', 'journal', 'unbound'])('rejects insufficient %s evidence before mutation', mode => {
  if (mode === 'absent') spec.files = [];
  if (mode === 'duplicate') spec.files[1].path = spec.files[0].path;
  if (mode === 'journal') spec.files[1].path = 'workflow-maintenance/state.json';
  if (mode === 'unbound') spec.binding = '';
  fs.writeFileSync(specPath, JSON.stringify(spec));
  expect(() => inspect()).toThrow(/Inspect the owning workflow records/);
  expect(gate.operations()).toHaveLength(2);
});

it('requires confirmation and refuses a live admitting process', () => {
  const request = inspect();
  fs.writeFileSync(requestPath, JSON.stringify(request));
  expect(() => runPublicationRecovery(['reconcile', requestPath], deps)).toThrow('Usage:');
  const liveDeps = { data, gate };
  expect(() => runPublicationRecovery(['reconcile', requestPath, '--confirm-disposition'], liveDeps)).toThrow('admitting process is live');
  expect(gate.operations()).toHaveLength(2);
});

it('never creates a receipt for missing ownership or spends an old receipt on a replacement', () => {
  const request = inspect();
  const state = readState();
  state.operations[0].id = randomUUID();
  fs.writeFileSync(statePath, JSON.stringify(state));
  expect(() => reconcile(request)).toThrow('missing owner cannot create a receipt');
  expect(gate.operations()).toEqual(state.operations);
});

it('refuses a malformed existing receipt without overwriting it or stranding the journal', () => {
  const request = inspect();
  fs.writeFileSync(receiptPath(request), '{');
  expect(() => reconcile(request)).toThrow('No valid matching receipt');
  expect(fs.readFileSync(receiptPath(request), 'utf8')).toBe('{');
  expect(gate.status().state).toBe('draining');
  expect(gate.operations()).toHaveLength(2);
});

it('rejects changed receipt bindings on replay and retains any replacement owner', () => {
  const request = inspect();
  reconcile(request);
  const replacement = gate.recoverOwned('settlement', 'Output publication');
  replacement.markUnsettled();
  expect(reconcile(request).replayed).toBe(true);
  expect(gate.operations()).toContainEqual(expect.objectContaining({ id: replacement.id, unsettled: true }));
  request.reason = 'A different disposition must not reuse the original receipt.';
  expect(() => reconcile(request)).toThrow('receipt binds different');
  expect(gate.operations()).toHaveLength(2);
});

it('refuses recovery when an exclusive coordinator owns the hold', () => {
  const request = inspect();
  const state = readState();
  fs.writeFileSync(statePath, JSON.stringify({ ...state, operations: [] }));
  const exclusive = gate.claimReady({ id: hold.id, revision: hold.revision, operation: {
    operationId: randomUUID(), requestId: randomUUID(), peerInstanceId: randomUUID(), hostInstanceId: randomUUID(),
    grantId: randomUUID(), grantGeneration: 1, scope: 'execution-v1', pairBinding: 'a'.repeat(64),
    intent: { action: 'portos.update' }, receiverVersion: '1.2.3', evidenceDigest: 'b'.repeat(64),
  } }, gate.observeIdle());
  fs.writeFileSync(statePath, JSON.stringify({ ...readState(), operations: state.operations }));
  expect(() => reconcile(request)).toThrow('hold changed');
  expect(gate.getExclusive()).toEqual(exclusive);
  expect(gate.operations()).toEqual(state.operations);
  expect(fs.existsSync(receiptPath(request))).toBe(false);
});

it.each(['write', 'file-sync', 'link', ...(process.platform === 'win32' ? [] : ['directory-sync'])])('preserves ownership after failed receipt %s and recovers receipt-first interruptions', stage => {
  const request = inspect();
  let linked = false;
  const failure = () => { throw Object.assign(new Error('Synthetic receipt persistence failure'), { code: 'EIO' }); };
  const io = { ...fs,
    writeFileSync(...args) { if (stage === 'write') failure(); return fs.writeFileSync(...args); },
    linkSync(...args) { if (stage === 'link') failure(); fs.linkSync(...args); linked = true; },
    fsyncSync(fd) { if (stage === 'file-sync' || (stage === 'directory-sync' && linked)) failure(); return fs.fsyncSync(fd); },
  };
  expect(() => reconcile(request, { io })).toThrow('needs recovery');
  expect(readState().operations).toContainEqual(request.operation);
  expect(gate.status().state).toBe('unavailable');
  expect(() => runPublicationRecovery(['diagnose'], deps)).toThrow('Recover its interrupted transaction');
  // Simulate completed journal recovery ONLY in the disposable fixture.
  fs.rmdirSync(join(gate.directory, 'transaction'));
  gate = createMaintenanceAdmission(data);
  deps.gate = gate;
  expect(reconcile(request).outputCompleteness).toBe('unknown');
  expect(gate.operations()).toEqual([expect.objectContaining({ resource: 'unrelated-owner' })]);
});
