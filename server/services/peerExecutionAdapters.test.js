import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { _createPeerExecutionAdapters, peerExecutionEvidenceDigest, _verifyPeerExecutionCompletion } from './peerExecutionAdapters.js';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const intent = { action: 'portos.update' };
const update = () => ({ headSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), originDigest: 'c'.repeat(64),
  branch: 'main', tag: 'v1.2.3', isFork: false, forkSyncFresh: false });
const expected = claim => ({ id: claim.id, revision: claim.revision, fingerprint: claim.fingerprint });
function owner(evidence) {
  const root = mkdtempSync(join(tmpdir(), 'peer-adapters-'));
  roots.push(root);
  const coordinator = createMaintenanceAdmission(root);
  const hold = coordinator.begin({ reason: 'Fixture drain', owner: 'Fixture operator' }).hold;
  const claim = coordinator.claimReady({ id: hold.id, revision: hold.revision, operation: {
    operationId: randomUUID(), requestId: randomUUID(), peerInstanceId: randomUUID(), hostInstanceId: randomUUID(),
    grantId: randomUUID(), grantGeneration: 1, scope: 'execution-v1', pairBinding: 'd'.repeat(64),
    intent: evidence.intent, receiverVersion: '1.2.3', evidenceDigest: peerExecutionEvidenceDigest(evidence),
  } }, coordinator.observeIdle());
  const started = coordinator.transitionExclusive(expected(claim), 'in-flight', coordinator.observeIdle());
  return { coordinator, root, started, capability: coordinator.issueExecutionCapability(started) };
}

describe('fixed peer actions under exclusive receiver ownership', () => {
  it('allows exactly one launch bound to immutable evidence and refuses forged, copied and recovered capabilities', async () => {
    const launchUpdate = vi.fn(async () => ({ state: 'awaiting-reconnect' }));
    const adapters = _createPeerExecutionAdapters({ probeUpdate: async () => update(), launchUpdate });
    const evidence = await adapters.prepare(intent);
    expect(Object.isFrozen(evidence.target)).toBe(true);
    const { capability, coordinator, started, root } = owner(evidence);
    await expect(adapters.run(intent, evidence, { capability: {} })).rejects.toMatchObject({ code: 'PEER_EXECUTION_CAPABILITY_REQUIRED' });
    expect(() => coordinator.issueExecutionCapability(structuredClone(started))).toThrow();
    expect(() => coordinator.issueExecutionCapability(started)).toThrow();
    const recovered = createMaintenanceAdmission(root);
    expect(() => recovered.issueExecutionCapability(recovered.getExclusive())).toThrow();
    await expect(adapters.run(intent, evidence, { capability })).resolves.toEqual({ state: 'awaiting-reconnect' });
    await expect(adapters.run(intent, evidence, { capability })).rejects.toMatchObject({ code: 'PEER_EXECUTION_CAPABILITY_CONSUMED' });
    expect(launchUpdate).toHaveBeenCalledTimes(1);
    expect(coordinator.held()).toBe(true);
    await expect(adapters.reconcile({})).resolves.toMatchObject({ state: 'uncertain' });
  });

  it('rechecks the exact origin target and never launches stale or fork-unreviewed work', async () => {
    let target = update();
    const launchUpdate = vi.fn();
    const adapters = _createPeerExecutionAdapters({ probeUpdate: async () => target, launchUpdate });
    const evidence = await adapters.prepare(intent);
    const { capability } = owner(evidence);
    target = { ...target, targetSha: 'e'.repeat(40) };
    await expect(adapters.run(intent, evidence, { capability })).rejects.toMatchObject({ code: 'PEER_EXECUTION_EVIDENCE_CHANGED' });
    target = { ...target, isFork: true };
    await expect(adapters.prepare(intent)).rejects.toMatchObject({ code: 'PEER_EXECUTION_FORK_REVIEW_REQUIRED' });
    expect(launchUpdate).not.toHaveBeenCalled();
  });

  it('revoking current exclusive ownership invalidates an already-issued capability', async () => {
    const launchUpdate = vi.fn();
    const adapters = _createPeerExecutionAdapters({ probeUpdate: async () => update(), launchUpdate });
    const evidence = await adapters.prepare(intent);
    const { capability, coordinator, started } = owner(evidence);
    coordinator.transitionExclusive(expected(started), 'uncertain');
    await expect(adapters.run(intent, evidence, { capability })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(launchUpdate).not.toHaveBeenCalled();
  });

  it('rejects arbitrary commands and unrelated PM2 targets before taking launch authority', async () => {
    const adapters = _createPeerExecutionAdapters({ probeRestart: async () => ({ processes: [{ name: 'unrelated-app', pid: 1, scriptDigest: 'a'.repeat(64) }] }) });
    await expect(adapters.prepare({ action: 'portos.restart', command: 'arbitrary' })).rejects.toThrow();
    await expect(adapters.prepare({ action: 'portos.restart' })).rejects.toThrow();
  });

  it('requires reviewed exact artifacts and actual destination/runtime capacity, rechecking capacity before install', async () => {
    const installIntent = { action: 'catalog.install', backend: 'ollama', catalogKey: 'fixture' };
    const unreviewed = _createPeerExecutionAdapters({ probeCatalog: async () => null });
    await expect(unreviewed.prepare(installIntent)).rejects.toMatchObject({ code: 'PEER_EXECUTION_CATALOG_UNREVIEWED' });
    const review = { ...installIntent, modelId: 'fixture:1', fileName: 'fixture.gguf', artifactDigest: 'a'.repeat(64), sourceRevision: 'revision',
      license: 'reviewed-license', reviewRevision: 'b'.repeat(64), destinationDigest: 'c'.repeat(64),
      downloadBytes: 100, scratchBytes: 100, runtimeMemoryBytes: 400, runtime: 'fixture-runtime' };
    delete review.action;
    let resources = { destinationFreeBytes: 250, availableMemoryBytes: 500, runtime: review.runtime, destinationDigest: review.destinationDigest };
    const installCatalog = vi.fn();
    const adapters = _createPeerExecutionAdapters({ probeCatalog: async () => ({ review, resources }), installCatalog });
    const evidence = await adapters.prepare(installIntent);
    const { capability } = owner(evidence);
    resources = { ...resources, destinationFreeBytes: 199 };
    await expect(adapters.run(installIntent, evidence, { capability })).rejects.toMatchObject({ code: 'PEER_EXECUTION_RESOURCES_INSUFFICIENT' });
    expect(installCatalog).not.toHaveBeenCalled();
  });
});


describe('post-restart completion proof', () => {
  it('requires the matching durable launch, successful exit and every intended process to have restarted', () => {
    const evidence = { version: 1, intent: { action: 'portos.restart' }, target: { processes: [
      { name: 'portos-server', pid: 100, scriptDigest: 'a'.repeat(64) },
      { name: 'portos-cos', pid: 101, scriptDigest: 'b'.repeat(64) },
    ] } };
    const operation = { operationId: randomUUID(), binding: { intent: evidence.intent, evidenceDigest: peerExecutionEvidenceDigest(evidence) } };
    const launch = { operationId: operation.operationId, evidenceDigest: operation.binding.evidenceDigest, evidence };
    const facts = { exit: '0', restart: { processes: evidence.target.processes.map(row => ({ ...row, pid: row.pid + 10 })) } };
    expect(_verifyPeerExecutionCompletion(operation, launch, facts)).toMatchObject({ state: 'succeeded' });
    expect(_verifyPeerExecutionCompletion(operation, { ...launch, operationId: randomUUID() }, facts)).toBeNull();
    expect(_verifyPeerExecutionCompletion(operation, launch, { ...facts, exit: '1' })).toBeNull();
    expect(_verifyPeerExecutionCompletion(operation, launch, { exit: '0', restart: evidence.target })).toBeNull();
    expect(_verifyPeerExecutionCompletion(operation, launch, { exit: '0', restart: { processes: facts.restart.processes.slice(0, 1) } })).toBeNull();
  });

  it('does not call an update complete from a version, health, or exit code without exact boot/build/install evidence', () => {
    const evidence = { version: 1, intent, target: update() };
    const operation = { operationId: randomUUID(), binding: { intent, evidenceDigest: peerExecutionEvidenceDigest(evidence) } };
    const launch = { operationId: operation.operationId, evidenceDigest: operation.binding.evidenceDigest, evidence };
    const facts = { exit: '0', verified: true, install: { bootCommit: evidence.target.targetSha,
      currentCommit: evidence.target.targetSha, outOfSync: false, staleBuild: false, staleDeps: { stale: false },
      submodules: { stale: false }, pendingMigrations: { count: 0 } } };
    expect(_verifyPeerExecutionCompletion(operation, launch, facts)).toMatchObject({ state: 'succeeded' });
    expect(_verifyPeerExecutionCompletion(operation, launch, { exit: '0', verified: true })).toBeNull();
    expect(_verifyPeerExecutionCompletion(operation, launch, { ...facts, install: { ...facts.install, bootCommit: evidence.target.headSha } })).toBeNull();
    expect(_verifyPeerExecutionCompletion(operation, launch, { ...facts, install: { ...facts.install, staleBuild: null } })).toBeNull();
  });
});
