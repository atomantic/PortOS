import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-retirement-run-evidence-') });
});
import { cleanupTempDataRoots, lazyTempDataRoot } from '../lib/mockPathsDataRoot.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
import { readCompletionData } from './agentCompletionData.js';
import { captureRunValidationArtifacts, retainRunValidationArtifacts } from './retirementRunValidation.js';
let root, release, agent, content;
const bytes = Buffer.from('Synthetic retained validation output.');
const compiled = Buffer.from([0, 1, 2, 255]);
const compiledPath = 'scripts/__pycache__/validation.cpython-311.pyc';
const digest = value => createHash('sha256').update(value).digest('hex');
beforeAll(async () => {
  root = lazyTempDataRoot('portos-run-retirement-');
  await mkdir(join(root, 'checkout', '.cache'), { recursive: true });
  await writeFile(join(root, 'checkout', '.git'), 'gitdir: synthetic');
  await writeFile(join(root, 'checkout', '.cache', 'verification.log'), bytes);
  await mkdir(join(root, 'checkout', 'scripts', '__pycache__'), { recursive: true });
  await writeFile(join(root, 'checkout', compiledPath), compiled);
  release = { path: join(root, 'checkout'), branch: 'claim/issue-example', head: 'a'.repeat(40), checkoutIdentity: await readRetirementCheckoutIdentity(join(root, 'checkout')) };
  const pointer = await lstat(join(release.path, '.git'), { bigint: true });
  agent = { id: 'agent-run-validation', startedAt: '2026-10-01T10:00:00.000Z', completedAt: '2026-10-01T11:00:00.000Z', status: 'completed', metadata: { completedCheckouts: [{
    version: 1, agentId: 'agent-run-validation', startedAt: '2026-10-01T10:00:00.000Z', capturedAt: '2026-10-01T10:59:00.000Z',
    repoPath: root, path: release.path, branch: release.branch, head: release.head,
    incarnation: { pointer: Object.fromEntries(['dev', 'ino', 'birthtimeNs'].map(key => [key, String(pointer[key])])) },
  }] } };
  content = { files: [{ path: '.cache/verification.log', bytes: bytes.length, sha256: digest(bytes) }, { path: compiledPath, bytes: compiled.length, sha256: digest(compiled) }, { path: 'scripts/__pycache__/private-user-file.bin', bytes: 8, sha256: 'b'.repeat(64) }] };
});
afterAll(cleanupTempDataRoots);
const capture = policies => captureRunValidationArtifacts(root, release, content, { readPolicies: async () => policies });
const review = captured => ({ release, comparison: { disposition: 'integrated' }, forge: { prHead: release.head, mergeCommit: 'b'.repeat(40), prUrl: 'https://example.test/pull/1' }, validationArtifacts: captured });
describe('completed-run evidence retention before checkout retirement', () => {
  it('durably retains exact reviewed diagnostic bytes in the captured run and reuses the same proof on replay', async () => {
    const captured = await capture([agent]);
    expect(captured.files.map(file => file.path)).toEqual(['.cache/verification.log', compiledPath]);
    const retained = await retainRunValidationArtifacts(review(captured), file => readFile(join(release.path, file.path)));
    await expect(retained.verify()).resolves.toBeUndefined();
    const stored = await readCompletionData(captured.owner, retained.evidence.reference);
    expect(Buffer.from(stored.files[0].data, 'base64')).toEqual(bytes);
    expect(stored.release).toEqual(release);
    expect(Buffer.from(stored.files[1].data, 'base64')).toEqual(compiled);
    const replay = await retainRunValidationArtifacts(review(captured), file => readFile(join(release.path, file.path)));
    expect(replay.evidence).toEqual(retained.evidence);
    await expect(readCompletionData({ ...captured.owner, startedAt: '2026-10-02T10:00:00.000Z' }, retained.evidence.reference)).rejects.toThrow();
  });
  it('retains originals when run ownership, repository or captured physical generation is absent, active or ambiguous', async () => {
    expect(await capture([])).toMatchObject({ scope: 'checkout', files: expect.any(Array) });
    expect(await capture([{ ...agent, status: 'running' }])).toBeNull();
    const changed = structuredClone(agent); changed.metadata.completedCheckouts[0].incarnation.pointer.ino = '1';
    expect(await capture([changed])).toBeNull();
    changed.metadata.completedCheckouts[0].incarnation = agent.metadata.completedCheckouts[0].incarnation;
    changed.metadata.completedCheckouts[0].repoPath = release.path;
    expect(await capture([changed])).toBeNull();
    const second = structuredClone(agent); second.id = 'agent-other'; second.metadata.completedCheckouts[0].agentId = second.id;
    expect(await capture([agent, second])).toBeNull();
  });
  const continuation = () => {
    const parent = structuredClone(agent);
    parent.metadata.instanceId = 'fixture-local';
    const child = structuredClone(parent);
    Object.assign(child, { id: 'agent-run-validation-resumed', startedAt: '2026-10-01T11:30:00.000Z', completedAt: '2026-10-01T12:30:00.000Z' });
    child.metadata.resumedFromAgentId = parent.id;
    Object.assign(child.metadata.completedCheckouts[0], { agentId: child.id, startedAt: child.startedAt, capturedAt: '2026-10-01T12:29:00.000Z' });
    return { parent, child };
  };
  it('binds shared-generation evidence to the exact terminal continuation instead of treating a resumed run as an unrelated owner', async () => {
    const { parent, child } = continuation();
    const captured = await capture([parent, child]);
    expect(captured.owner).toEqual({ id: child.id, startedAt: child.startedAt });
    const retained = await retainRunValidationArtifacts(review(captured), file => readFile(join(release.path, file.path)));
    const stored = await readCompletionData(captured.owner, retained.evidence.reference);
    expect(stored.lineage.map(row => row.id)).toEqual([parent.id, child.id]);
    expect(Buffer.from(stored.files[0].data, 'base64')).toEqual(bytes);
  });
  it.each(['overlap', 'cycle', 'foreign-instance', 'invalid-instance', 'fork'])('keeps an ambiguous shared generation when its continuation has %s', async failure => {
    const { parent, child } = continuation();
    const policies = [parent, child];
    if (failure === 'overlap') {
      child.startedAt = '2026-10-01T10:30:00.000Z';
      child.metadata.completedCheckouts[0].startedAt = child.startedAt;
    }
    if (failure === 'cycle') parent.metadata.resumedFromAgentId = child.id;
    if (failure === 'foreign-instance') child.metadata.instanceId = 'other-install';
    if (failure === 'invalid-instance') { parent.metadata.instanceId = 1; child.metadata.instanceId = 1; }
    if (failure === 'fork') {
      const sibling = structuredClone(child); sibling.id = 'agent-fork'; sibling.metadata.completedCheckouts[0].agentId = sibling.id; policies.push(sibling);
    }
    expect(await capture(policies)).toBeNull();
  });

  it('refuses changed source bytes, unintegrated delivery, failed durability and an oversized existing-store envelope', async () => {
    const captured = await capture([agent]);
    await expect(retainRunValidationArtifacts(review(captured), async () => Buffer.from('changed'))).rejects.toThrow('retirement-validation-preservation-unavailable');
    await expect(retainRunValidationArtifacts({ ...review(captured), comparison: { disposition: 'review-supersession' } }, async () => bytes)).rejects.toThrow();
    await expect(retainRunValidationArtifacts(review(captured), async file => file.path === compiledPath ? compiled : bytes, { store: async () => ({}), read: async () => ({}) })).rejects.toThrow('retirement-validation-preservation-unavailable');
    await expect(captureRunValidationArtifacts(root, release, { files: [{ ...content.files[0], bytes: 64 * 1024 * 1024 }] }, { readPolicies: async () => [agent] })).rejects.toThrow('retirement-validation-preservation-unavailable');
  });
});
