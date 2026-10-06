import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _createPeerCatalogInstaller, peerCatalogReviewSchema } from './peerCatalogInstaller.js';
import { _createPeerExecutionAdapters, peerExecutionEvidenceDigest } from './peerExecutionAdapters.js';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const intent = { action: 'catalog.install', backend: 'lmstudio', catalogKey: 'fixture' };
const payload = Buffer.alloc(32, 1);
payload.write('GGUF'); payload.writeUInt32LE(3, 4);
const digest = value => createHash('sha256').update(value).digest('hex');
const reviewInput = () => ({ backend: 'lmstudio', catalogKey: 'fixture', sourceRevision: 'a'.repeat(40),
  fileName: 'fixture-Q4_K_M.gguf', artifactDigest: digest(payload), downloadBytes: payload.length,
  license: 'fixture-license', runtimeMemoryBytes: 1024, runtime: 'fixture-runtime',
  sourceLicenseReviewed: true, runtimeCompatibilityReviewed: true });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'peer-catalog-')); roots.push(root);
  let rows = [];
  let runtime = { modelsRoot: root, runtime: 'fixture-runtime', destinationFreeBytes: 1024 ** 3, availableMemoryBytes: 4096 };
  const fetchImpl = vi.fn(async () => new Response(payload));
  const service = _createPeerCatalogInstaller({ catalog: [{ key: 'fixture', name: 'Fixture', lmstudio: 'fixture/model-GGUF' }],
    readReviews: async () => rows, writeReviews: async next => { rows = next; }, inspectRuntime: async () => runtime, fetchImpl });
  const adapters = _createPeerExecutionAdapters({ probeCatalog: service.probe, installCatalog: service.install });
  const authorize = evidence => {
    const coordinator = createMaintenanceAdmission(join(root, 'data'));
    const hold = coordinator.begin({ reason: 'Fixture drain', owner: 'Fixture operator' }).hold;
    const operation = { operationId: randomUUID(), requestId: randomUUID(), peerInstanceId: randomUUID(), hostInstanceId: randomUUID(),
      grantId: randomUUID(), grantGeneration: 1, scope: 'execution-v1', pairBinding: 'a'.repeat(64),
      intent, receiverVersion: '1.2.3', evidenceDigest: peerExecutionEvidenceDigest(evidence) };
    const claim = coordinator.claimReady({ id: hold.id, revision: hold.revision, operation }, coordinator.observeIdle());
    const started = coordinator.transitionExclusive({ id: claim.id, revision: claim.revision, fingerprint: claim.fingerprint }, 'in-flight', coordinator.observeIdle());
    return { capability: coordinator.issueExecutionCapability(started), operation };
  };
  return { root, service, adapters, fetchImpl, authorize, setRuntime: value => { runtime = { ...runtime, ...value }; },
    destination: join(root, 'fixture/model-GGUF', reviewInput().fileName) };
}

describe('receiver-reviewed pinned GGUF installation', () => {
  it('installs only the reviewed bytes into the actual model tree and reconciles them after restart', async () => {
    const f = await fixture();
    expect(await f.service.describe({ backend: 'lmstudio', catalogKey: 'fixture' })).toMatchObject({ sourceRepo: 'fixture/model-GGUF', runtime: 'fixture-runtime' });
    await f.service.save(reviewInput(), 'operator-session');
    const evidence = await f.adapters.prepare(intent);
    const { capability, operation } = f.authorize(evidence);
    const launched = await f.adapters.run(intent, evidence, { capability });
    expect(launched.completion).toBeInstanceOf(Promise);
    await expect(launched.completion).resolves.toMatchObject({ state: 'succeeded' });
    expect(await fs.readFile(f.destination)).toEqual(payload);
    expect(f.fetchImpl.mock.calls[0][0]).toBe(`https://huggingface.co/fixture/model-GGUF/resolve/${'a'.repeat(40)}/fixture-Q4_K_M.gguf`);
    expect(await fs.readdir(join(f.root, 'fixture/model-GGUF'))).toEqual([reviewInput().fileName]);
    // A receiver may review the next version while this operation is in flight.
    await f.service.save({ ...reviewInput(), sourceRevision: 'b'.repeat(40), fileName: 'next.gguf' }, 'operator-session');
    const recovered = { operationId: operation.operationId, binding: { intent, evidenceDigest: operation.evidenceDigest } };
    await expect(f.service.reconcile(recovered, evidence)).resolves.toMatchObject({ state: 'succeeded' });
    await fs.writeFile(f.destination, Buffer.alloc(32));
    await expect(f.service.reconcile(recovered, evidence)).resolves.toBeNull();
  });

  it('never publishes a wrong hash, oversized stream or non-GGUF, and proves staging cleanup on failure', async () => {
    for (const [body, artifactDigest] of [[Buffer.alloc(32), digest(payload)], [Buffer.alloc(33), digest(payload)],
      [Buffer.alloc(31), digest(payload)], [Buffer.alloc(32), digest(Buffer.alloc(32))]]) {
      const f = await fixture();
      await f.service.save({ ...reviewInput(), artifactDigest }, 'local-operator');
      f.fetchImpl.mockImplementation(async () => new Response(body));
      const evidence = await f.adapters.prepare(intent);
      const { capability } = f.authorize(evidence);
      const launched = await f.adapters.run(intent, evidence, { capability });
      await expect(launched.completion).resolves.toMatchObject({ state: 'failed', code: 'PEER_EXECUTION_ARTIFACT_MISMATCH' });
      expect(await fs.readdir(join(f.root, 'fixture/model-GGUF'))).toEqual([]);
    }
  });

  it('refuses changed runtime, insufficient destination capacity and an existing file before downloading', async () => {
    const f = await fixture();
    await expect(f.adapters.prepare(intent)).rejects.toMatchObject({ code: 'PEER_EXECUTION_CATALOG_UNREVIEWED' });
    await f.service.save(reviewInput(), 'operator-session');
    f.setRuntime({ runtime: 'changed-runtime' });
    await expect(f.adapters.prepare(intent)).rejects.toMatchObject({ code: 'PEER_EXECUTION_CATALOG_CHANGED' });
    f.setRuntime({ runtime: 'fixture-runtime', destinationFreeBytes: 20 });
    await expect(f.adapters.prepare(intent)).rejects.toMatchObject({ code: 'PEER_EXECUTION_RESOURCES_INSUFFICIENT' });
    f.setRuntime({ destinationFreeBytes: 1024 ** 3 });
    await fs.mkdir(join(f.root, 'fixture/model-GGUF'), { recursive: true });
    await fs.writeFile(f.destination, 'preserve');
    await expect(f.adapters.prepare(intent)).rejects.toMatchObject({ code: 'PEER_EXECUTION_MODEL_EXISTS' });
    expect(await fs.readFile(f.destination, 'utf8')).toBe('preserve');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses peer recipes, shards, incomplete local review and destination symlinks', async () => {
    const f = await fixture();
    expect(peerCatalogReviewSchema.safeParse({ ...reviewInput(), url: 'https://arbitrary.invalid' }).success).toBe(false);
    expect(peerCatalogReviewSchema.safeParse({ ...reviewInput(), fileName: '../model.gguf' }).success).toBe(false);
    expect(peerCatalogReviewSchema.safeParse({ ...reviewInput(), fileName: 'model-00001-of-00002.gguf' }).success).toBe(false);
    expect(peerCatalogReviewSchema.safeParse({ ...reviewInput(), sourceLicenseReviewed: false }).success).toBe(false);
    await f.service.save(reviewInput(), 'operator-session');
    const outside = await fs.mkdtemp(join(tmpdir(), 'peer-catalog-outside-')); roots.push(outside);
    await fs.symlink(outside, join(f.root, 'fixture'), 'dir');
    await expect(f.adapters.prepare(intent)).rejects.toMatchObject({ code: 'PEER_EXECUTION_DESTINATION_CHANGED' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
