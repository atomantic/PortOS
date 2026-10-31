import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownFixtureWork } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-held-preflight-data-'),
}));
const injected = vi.hoisted(() => ({ app: null, outcome: null }));
vi.mock('./apps.js', () => ({ getAppById: async () => injected.app }));
vi.mock('./branchReconcileOutcome.js', () => ({ getBranchReconcileOutcome: async () => injected.outcome }));
vi.mock('../lib/execGit.js', async importOriginal => ({
  ...await importOriginal(),
  execGit: async () => { throw new Error('Unexpected Git work beyond preflight'); },
}));

const { prepareInventoriedCheckoutRetirement, retireInventoriedCheckout, inspectCheckoutRetirementOwnership } = await import('./heldCheckoutRecovery.js');
const owned = ownFixtureWork();
const it = owned.tests(vitestIt);
let scratch;
beforeEach(() => owned.prepare());
beforeEach(owned.wrap('setup', async () => {
  scratch = await mkdtemp(join(lazyTempDataRoot('portos-held-preflight-'), 'case-'));
  injected.app = { id: 'app-1', repoPath: join(scratch, 'repo') };
  injected.outcome = { remaining: [] };
}));
afterEach(() => owned.cleanup(async () => {
  await owned.drain();
  await owned.run('scratch-removal', () => rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
}));
afterAll(() => owned.finish(cleanupTempDataRoots));

describe('held checkout retirement preflight', () => {
  // Each field is part of the operator's authority, before any physical Git work.
  it.each([
    ['path', 'other-checkout'], ['branch', 'feature/other'], ['head', 'b'.repeat(40)],
    ['locked', false], ['lockReason', 'older lock text'], ['checkoutIdentity', 'b'.repeat(64)],
    ['absent inventory', null],
  ])('rejects a persisted inventory mismatch in %s at both service entry points', async (field, value) => {
    const release = { path: join(scratch, 'checkout'), branch: 'feature/held', head: 'a'.repeat(40),
      locked: true, lockReason: 'synthetic owner', checkoutIdentity: 'a'.repeat(64) };
    injected.outcome.remaining = field === 'absent inventory' ? []
      : [{ ...release, [field]: field === 'path' ? join(scratch, value) : value }];
    const before = structuredClone(injected.outcome);
    const input = { appId: 'app-1', release, prUrl: 'https://github.com/example/repo/pull/42',
      review: { prUrl: 'https://github.com/example/repo/pull/42', digest: 'c'.repeat(64), acceptSuperseded: false } };
    const opts = { readForge: async () => { throw new Error('Forge must not grant an uninventoried release'); } };
    for (const boundary of [prepareInventoriedCheckoutRetirement, retireInventoriedCheckout]) {
      expect(await boundary(input, opts)).toEqual({ ok: false, reason: 'release-not-in-inventory' });
    }
    expect(injected.outcome).toEqual(before);
  });

  it('refuses freshly unreadable completion policies after admitting a legacy completed owner', async () => {
    const repoPath = injected.app.repoPath;
    const branch = 'feature/legacy';
    let policies = [{ id: 'completed', status: 'completed', result: { success: true },
      metadata: { sourceWorkspace: repoPath, claimBranches: [branch], prCompletionPolicy: 'review-then-merge' } }];
    const inspect = () => inspectCheckoutRetirementOwnership({ repoPath, registration: false,
      release: { path: join(scratch, 'checkout'), branch, head: 'a'.repeat(40) } },
    { readAgents: async () => [], readPolicies: async () => policies });
    expect(await inspect()).toMatchObject({ ok: true });
    policies = null;
    expect(await inspect()).toEqual({ ok: false, reason: 'pr-completion-policy-unavailable' });
  });
});
