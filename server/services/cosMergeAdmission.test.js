import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

// The outside-agent lease (POST /api/cos/merge-admission/external) over the real
// admission transaction and a synthetic runtime store. The target proof reaches
// the forge and Git, so only that is doubled; the HTTP boundary is covered by
// routes/cosExternalMergeAdmission.test.js.
const fixture = vi.hoisted(() => ({ state: null, disk: null, trusted: true, failSave: false }));
vi.mock('./cosState.js', () => ({
  withStateLock: createFileWriteQueue(),
  loadState: async () => fixture.state,
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: fixture.trusted, ...structuredClone(fixture.disk) }),
  saveState: async (state) => { if (fixture.failSave) throw new Error('write failed'); fixture.disk = structuredClone(state); fixture.state = state; },
}));
vi.mock('./externalMergeTarget.js', async () => {
  const { parsePullRequestUrl } = await import('../lib/gitForge.js');
  const proof = (input) => {
    const pr = parsePullRequestUrl(input.prUrl);
    return { repository: `${pr.host}/${pr.owner}/${pr.repo}`, target: { appId: pr.repo, repoPath: `/repos/${pr.repo}`,
      worktreePath: `/worktrees/${pr.repo}`, gitDir: '/git/dir', commonDir: '/git/common', checkoutIdentity: 'identity',
      branch: 'feature', prUrl: input.prUrl, baseBranch: input.baseBranch, headSha: input.headSha, baseSha: input.baseSha } };
  };
  return { inspectExternalMergeTarget: async input => proof(input), inspectExternalMergeCheckout: async target => proof(target) };
});
import { AGENT_LEASE_MAX_HOLD_MS, MERGE_PREPARATION_MAX_HOLD_MS, externalMergeAdmission } from './cosMergeAdmission.js';

const [alice, bob] = ['a'.repeat(64), 'b'.repeat(64)];
const target = (name = 'repo') => ({ appId: name, worktreePath: `/worktrees/${name}`, baseBranch: 'main',
  prUrl: `https://github.com/example/${name}/pull/7`, headSha: 'c'.repeat(40), baseSha: 'd'.repeat(40) });
const as = (owner, body) => externalMergeAdmission(body, async () => owner);
const acquire = (owner, name) => as(owner, { action: 'acquire', ...target(name) });
const prepare = (owner, name) => as(owner, { action: 'prepare', ...target(name) });
const check = (owner, token) => as(owner, { action: 'check', token });
const release = (owner, token, outcome = 'merged') => as(owner, { action: 'release', token, outcome });
const yieldTurn = (owner, token) => as(owner, { action: 'yield', token });
const persist = () => { fixture.disk = structuredClone(fixture.state); };
const REPO = 'github.com/example/repo';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fixture.trusted = true;
  fixture.failSave = false;
  fixture.state = { agents: {}, mergeAdmissions: {} };
  persist();
});

afterEach(() => vi.restoreAllMocks());

describe('outside-agent merge lease', () => {
  it('serializes sessions on one repository, not across repositories, and the owner re-enters its own lease', async () => {
    const a = await acquire(alice);
    expect(a.admitted).toBe(true);
    expect(await acquire(bob)).toMatchObject({ admitted: false, reason: 'owner-active-or-unverified', retryAfterMs: 5000 });
    expect((await acquire(bob, 'other')).admitted).toBe(true);
    expect((await acquire(alice)).token).toBe(a.token);
    expect(await check(alice, a.token)).toMatchObject({ admitted: true });
    expect(await release(alice, a.token)).toMatchObject({ released: true });
    expect((await acquire(bob)).admitted).toBe(true);
  });

  it('lets another session reclaim a holder past the hold deadline and voids the stale token', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z') });
    try {
      const stale = await acquire(alice);
      vi.advanceTimersByTime(AGENT_LEASE_MAX_HOLD_MS - 1);
      expect((await acquire(bob)).admitted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(await check(alice, stale.token)).toMatchObject({ admitted: false, reason: 'lease-expired' });
      const reclaimed = await acquire(bob);
      expect(reclaimed.admitted).toBe(true);
      expect(await check(alice, stale.token)).toMatchObject({ admitted: false, reason: 'lease-owner-mismatch' });
      expect((await release(alice, stale.token)).released).not.toBe(true);
      // A holder re-acquiring its own expired lease gets a fresh token.
      vi.advanceTimersByTime(AGENT_LEASE_MAX_HOLD_MS);
      const renewed = await acquire(bob);
      expect(renewed.token).not.toBe(reclaimed.token);
      expect(await check(bob, renewed.token)).toMatchObject({ admitted: true });
    } finally { vi.useRealTimers(); }
  });

  it.each(['unreadable', 'stale', 'malformed-lease'])('fails closed on %s without granting', async (mode) => {
    const a = await acquire(alice);
    if (mode === 'unreadable') fixture.trusted = false;
    if (mode === 'stale') fixture.disk.mergeAdmissions = {};
    if (mode === 'malformed-lease') { fixture.state.mergeAdmissions[REPO] = null; persist(); }
    expect((await acquire(bob)).admitted).toBe(false);
    fixture.trusted = true;
    if (mode !== 'malformed-lease') expect(await check(alice, a.token)).toMatchObject({ admitted: mode !== 'stale' });
  });

  it('refuses foreign or stale tokens and an unknown release outcome', async () => {
    const a = await acquire(alice);
    expect((await release(bob, a.token)).released).not.toBe(true);
    expect((await release(alice, 'f'.repeat(8) + a.token.slice(8))).released).not.toBe(true);
    expect(await release(alice, a.token, 'abandoned')).toMatchObject({ admitted: false, reason: 'outcome-required' });
    expect(fixture.state.mergeAdmissions[REPO].token).toBe(a.token);
    expect(await release(alice, a.token, 'leave-open')).toMatchObject({ released: true });
    expect((await release(alice, a.token)).released).not.toBe(true);
  });

  it('drops agent and sweep leases written before #14319 instead of refusing on them', async () => {
    fixture.state.mergeAdmissions[REPO] = { kind: 'agent', agentId: 'old-parent', startedAt: '2026-01-01', taskId: 'old-task',
      repository: REPO, token: 'old-agent-token', acquiredAt: new Date().toISOString() };
    fixture.state.mergeAdmissions['github.com/example/other'] = { kind: 'sweep', serverOwner: 'old-server', pid: 1,
      repository: 'github.com/example/other', token: 'old-sweep-token', acquiredAt: new Date().toISOString() };
    persist();
    expect((await acquire(alice)).admitted).toBe(true);
    expect(Object.keys(fixture.disk.mergeAdmissions)).toEqual([REPO]);
    expect(fixture.disk.mergeAdmissions[REPO].kind).toBe('external');
  });

  it('never remembers a grant whose persistence failed', async () => {
    fixture.failSave = true;
    await expect(acquire(alice)).rejects.toThrow('write failed');
    expect(fixture.state.mergeAdmissions).toEqual({});
    fixture.failSave = false;
    expect((await acquire(bob)).admitted).toBe(true);
  });
});

describe('ready merge preparation ordering', () => {
  it('orders preparation before admission and lets other repositories progress', async () => {
    const a = await prepare(alice);
    expect(a.prepared).toBe(true);
    expect(fixture.state.mergeAdmissions).toEqual({});
    expect(await prepare(bob)).toMatchObject({ prepared: false, reason: 'preparation-waiting' });
    expect(await acquire(bob)).toMatchObject({ admitted: false, reason: 'preparation-waiting' });
    expect((await prepare(alice)).preparationToken).toBe(a.preparationToken);
    expect((await acquire(bob, 'other')).admitted).toBe(true);
    expect(await yieldTurn(alice, a.preparationToken)).toEqual({ yielded: true });
    expect((await acquire(bob)).admitted).toBe(true);
  });

  it('retains a nonrenewable position through repeated base refreshes and yields for substantive work', async () => {
    const a = await prepare(alice);
    await prepare(bob);
    for (let base = 0; base < 4; base++) {
      const lease = await acquire(alice);
      expect(lease.admitted).toBe(true);
      await release(alice, lease.token, 'resync');
      expect(await prepare(alice)).toEqual(a);
      expect(fixture.state.mergeAdmissions).toEqual({});
      expect((await prepare(bob)).prepared).toBe(false);
    }
    await yieldTurn(alice, a.preparationToken);
    expect((await prepare(bob)).prepared).toBe(true);
    expect((await prepare(alice)).prepared).toBe(false);
  });

  it('moves an expired holder behind live waiters without renewing its turn', async () => {
    vi.useFakeTimers();
    try {
      const a = await prepare(alice);
      await prepare(bob);
      for (let elapsed = 60_000; elapsed < MERGE_PREPARATION_MAX_HOLD_MS; elapsed += 60_000) {
        vi.advanceTimersByTime(60_000);
        expect((await prepare(bob)).prepared).toBe(false);
      }
      vi.advanceTimersByTime(59_999);
      expect(await prepare(alice)).toEqual(a);
      vi.advanceTimersByTime(1);
      expect((await prepare(alice)).prepared).toBe(false);
      const b = await prepare(bob);
      expect(b.prepared).toBe(true);
      await yieldTurn(bob, b.preparationToken);
      expect((await prepare(alice)).preparationToken).not.toBe(a.preparationToken);
    } finally { vi.useRealTimers(); }
  });

  it('ages out a granted turn an agent or pending-merge owner held before #14319', async () => {
    const now = Date.now();
    fixture.state.mergePreparations = { [REPO]: [{ owner: 'agent:old-parent:2026-01-01:old-task', target: null, token: 'legacy-turn',
      requestedAt: now, seenAt: now, grantedAt: now - MERGE_PREPARATION_MAX_HOLD_MS - 1 }] };
    persist();
    expect((await prepare(alice)).prepared).toBe(true);
  });

  it('refuses malformed or unpersisted scheduling', async () => {
    fixture.state.mergePreparations = null; persist();
    expect(await prepare(bob)).toMatchObject({ admitted: false, reason: 'ownership-unreadable' });
    fixture.state.mergePreparations = {}; persist();
    fixture.failSave = true;
    await expect(prepare(bob)).rejects.toThrow('write failed');
    expect(fixture.state.mergePreparations).toEqual({});
  });
});
