import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownFixtureWork } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-held-preflight-data-'),
}));
const injected = vi.hoisted(() => ({ app: null, outcome: null, ignored: [] }));
vi.mock('./apps.js', () => ({ getAppById: async () => injected.app }));
vi.mock('./taskSchedule.js', () => ({ getBranchReconcileOutcome: async () => injected.outcome }));
vi.mock('../lib/execGit.js', async importOriginal => ({
  ...await importOriginal(),
  execGit: async args => {
    if (JSON.stringify(args) !== JSON.stringify(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])) {
      throw new Error('Unexpected Git work beyond preflight');
    }
    return { exitCode: 0, stdout: Buffer.from(injected.ignored.map(path => `${path}\0`).join('')) };
  },
}));

const { prepareInventoriedCheckoutRetirement, retireInventoriedCheckout, releaseCheckoutWithoutArchive, inspectCheckoutRetirementOwnership } = await import('./heldCheckoutRecovery.js');
const owned = ownFixtureWork();
const it = owned.tests(vitestIt);
let scratch;
beforeEach(() => owned.prepare());
beforeEach(owned.wrap('setup', async () => {
  scratch = await mkdtemp(join(lazyTempDataRoot('portos-held-preflight-'), 'case-'));
  injected.app = { id: 'app-1', repoPath: join(scratch, 'repo') };
  injected.outcome = { remaining: [] };
  injected.ignored = [];
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

  it.each(['bound', 'discovered'])('revalidates persisted resume authority with %s PR identity', async prIdentity => {
    const repoPath = injected.app.repoPath;
    const checkoutPath = join(scratch, 'checkout');
    await mkdir(repoPath); await mkdir(checkoutPath);
    const branch = 'feature/resumed';
    const head = 'a'.repeat(40);
    const prUrl = 'https://github.com/example/repo/pull/42';
    const fact = { dev: '1', ino: '2', birthtimeNs: '3' };
    const incarnation = { pointer: { ...fact }, gitdir: { ...fact } };
    const agents = ['failed', 'cleanup', 'resumed'].map((id, index) => {
      const startedAt = `2026-03-01T0${index}:00:00.000Z`;
      const path = index === 2 ? checkoutPath : join(scratch, id);
      return { id, taskId: 'same-task', status: 'completed', startedAt,
        completedAt: `2026-03-01T0${index}:01:00.000Z`,
        result: index === 0 ? { success: false, executionSuccess: false, validationPassed: null }
          : { success: false, executionSuccess: true, validationPassed: null, cleanupPending: true,
            taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } },
        metadata: { sourceWorkspace: repoPath, workspacePath: path, worktreeBranch: branch,
          prCompletionPolicy: 'review-then-merge', resumedFromAgentId: index ? ['failed', 'cleanup'][index - 1] : null,
          reviewLoopMergeTarget: prIdentity === 'bound' ? { branch, url: prUrl } : null,
          completedCheckouts: [{ version: 1, agentId: id, startedAt, capturedAt: startedAt,
            repoPath, path, branch, head, incarnation: structuredClone(incarnation) }] } };
    });
    const input = { repoPath, release: { path: checkoutPath, branch, head }, registration: false,
      reviewIdentity: { checkoutPath, tip: head, verifiedPrHead: head, prUrl, checkoutIncarnation: incarnation } };
    const inspect = () => inspectCheckoutRetirementOwnership(input, { readAgents: async () => [], readPolicies: async () => agents });
    const original = structuredClone(agents);
    expect(await inspect()).toMatchObject({ ok: true, policy: { policies: [
      { id: 'cleanup', resumedCleanup: { successorAgentId: 'resumed' } },
      { id: 'failed', resumedCleanup: { successorAgentId: 'resumed' } }, { id: 'resumed' },
    ] } });
    // Public admission re-reads these independent persisted authority fields;
    // no checkout bytes or Git reconstruction are needed to reject them.
    for (const [target, key, value] of [[agents[2].metadata, 'resumedFromAgentId', null],
      [agents[0], 'taskId', 'other-task'], [agents[0], 'status', 'running'],
      [agents[0].result, 'validationPassed', false], [agents[0].metadata, 'prCompletionPolicy', 'leave-open'],
      [agents[0].metadata, 'reviewLoopMergeTarget', { branch, url: 'https://github.com/example/repo/pull/99' }],
      [agents[0].metadata.completedCheckouts[0], 'head', 'b'.repeat(40)]]) {
      const prior = target[key]; target[key] = value;
      expect(await inspect(), key).toMatchObject({ ok: false });
      target[key] = prior;
    }
    expect(await inspect()).toMatchObject({ ok: true });
    expect(agents).toEqual(original);
  });
});

// These producer/schema permutations formerly rebuilt a merged repository and
// repeated its proof. Keep their actual filesystem admission through the same
// release boundary; real Git tests retain destructive/ignore/drift coverage.
async function cacheFiles(root, files) {
  for (const [name, bytes] of Object.entries(files)) {
    const relative = `${root}/${name}`;
    await mkdir(join(scratch, root), { recursive: true });
    await writeFile(join(scratch, relative), bytes);
    injected.ignored.push(relative);
  }
}
const releasePayload = () => releaseCheckoutWithoutArchive({ path: scratch }, async () => ({ ready: true }));
const tag = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by Vitest.\n';

describe('test cache admission before checkout removal', () => {
  it.each([
    ['unknown-metadata', { wanted: 'unique user data' }],
    ['wrong-hash-width', { lockfileHash: 'b'.repeat(7) }],
    ['nonhex-hash', { lockfileHash: 'not-hex!' }],
    ['non-string-hash', { lockfileHash: 12345678 }],
    ['newline-hash', { lockfileHash: '12345678\n' }],
    ['extra-metadata', { lockfileHash: '12345678', wanted: 'unique user data' }],
  ])('retains module-cache payload with %s', async (_kind, metadata) => {
    const root = 'server/.cache/vitest/modules';
    const module = 'a'.repeat(40);
    await cacheFiles(root, { 'CACHEDIR.TAG': tag, '_metadata.json': JSON.stringify(metadata), [module]: 'wanted compiled bytes' });
    await expect(releasePayload()).rejects.toThrow('checkout-ignored-payload-unverified');
    expect(await readFile(join(scratch, root, module), 'utf8')).toBe('wanted compiled bytes');
    expect(JSON.parse(await readFile(join(scratch, root, '_metadata.json'), 'utf8'))).toEqual(metadata);
  });

  it.each([40, 64])('accepts the compatible %i-character module-cache lockfile hash', async width => {
    await cacheFiles('server/.cache/vitest/modules', { 'CACHEDIR.TAG': tag,
      '_metadata.json': JSON.stringify({ lockfileHash: 'b'.repeat(width) }), ['a'.repeat(40)]: 'compiled module' });
    expect(await releasePayload()).toEqual({ ready: true });
  });

  it.each(['dependencies-no-setup', 'atomic-untagged', 'bad-setup', 'unknown-field', 'bad-version', 'bad-project', 'bad-index', 'untagged'])(
    'preserves Vitest state-producer admission for %s', async kind => {
      const root = 'server/.cache/vitest/vitest';
      const project = `${root}/${'a'.repeat(40)}`;
      const dependencies = ['dependencies-no-setup', 'bad-setup', 'bad-index'].includes(kind);
      const value = { version: 1, projects: { parallel: dependencies
        ? { modules: ['services/feature.js'], globalSetup: [], files: { 'services/feature.test.js': [kind === 'bad-index' ? 99 : 0] } }
        : { files: { 'services/feature.test.js': { failed: false, duration: 12, lastRun: 12345 } } } } };
      if (kind === 'dependencies-no-setup') delete value.projects.parallel.globalSetup;
      if (kind === 'bad-setup') value.projects.parallel.globalSetup = 'unique user content';
      if (kind === 'unknown-field') value.wanted = 'unique user content';
      if (kind === 'bad-version') value.version = 99;
      if (kind === 'bad-project') value.projects.parallel = { wanted: 'unique user content' };
      if (!['untagged', 'atomic-untagged'].includes(kind)) await cacheFiles(root, {
        'CACHEDIR.TAG': `${tag}# For information about cache directory tags see https://bford.info/cachedir/\n`,
      });
      const name = kind === 'atomic-untagged' ? '.tmp-1700000000000-abc123' : dependencies ? 'dependencies.json' : 'results.json';
      const content = kind === 'atomic-untagged' ? '' : JSON.stringify(value);
      await cacheFiles(project, { [name]: content });
      if (kind === 'dependencies-no-setup') expect(await releasePayload()).toEqual({ ready: true });
      else await expect(releasePayload()).rejects.toThrow('checkout-ignored-payload-unverified');
      expect(await readFile(join(scratch, project, name), 'utf8')).toBe(content);
    });
});
