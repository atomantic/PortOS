/**
 * Unit tests for the superseded-branch verdict ledger (#3842).
 *
 * The pure parts (isVerdictFresh / partitionSuperseded / formatSupersededForPrompt)
 * carry the safety property that matters: a verdict may only suppress analysis
 * while every piece of evidence it was based on still holds. Everything else
 * fails OPEN — back to full analysis, never to a silently hidden branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posixPath } from '../lib/testHelper.js';
import { join as joinPath } from 'path';

const files = new Map();
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { cos: '/repo/data/cos' },
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
  tryReadFile: async (p) => (files.has(p) ? files.get(p) : null),
  atomicWrite: async (p, data) => { files.set(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); }
}));

import {
  ledgerPath, readVerdictLedger, writeVerdictLedger, recordVerdict,
  isVerdictFresh, partitionSuperseded, formatSupersededForPrompt, recordVerdictInstruction
} from './supersededLedger.js';

// join(), not a literal: the service composes this with path.join.
const PATH = joinPath('/repo/data/cos', 'branch-reconcile-verdicts.json');

const entry = (over = {}) => ({
  branch: 'cos/task-x/agent-dead',
  repoPath: '/repo',
  verdict: 'SUPERSEDED',
  tip: 'aaa111',
  dirtyPaths: ['a.js', 'b.js'],
  collisionPaths: ['a.js'],
  replacedBy: ['fff999'],
  ...over
});

const branch = (over = {}) => ({
  branch: 'cos/task-x/agent-dead',
  tip: 'aaa111',
  dirtyPaths: ['b.js', 'a.js'], // order must not matter
  collisionPaths: ['a.js'],
  state: 'ABANDONED_WIP',
  worktreePath: '/repo/data/cos/worktrees/agent-dead',
  ...over
});

beforeEach(() => files.clear());

describe('ledgerPath', () => {
  it('lands in the install\'s cos data dir', () => {
    expect(ledgerPath()).toBe(PATH);
    expect(posixPath(ledgerPath('/other/cos'))).toBe('/other/cos/branch-reconcile-verdicts.json');
  });
});

describe('readVerdictLedger', () => {
  it('is empty when the file does not exist', async () => {
    expect(await readVerdictLedger()).toEqual([]);
  });

  it('is empty (not partial) on malformed JSON — fail open to re-analysis', async () => {
    files.set(PATH, '{ "entries": [');
    expect(await readVerdictLedger()).toEqual([]);
  });

  it('reads the wrapped { version, entries } shape', async () => {
    files.set(PATH, JSON.stringify({ version: 1, entries: [entry()] }));
    expect((await readVerdictLedger()).map((e) => e.branch)).toEqual(['cos/task-x/agent-dead']);
  });

  it('also accepts a bare array', async () => {
    files.set(PATH, JSON.stringify([entry()]));
    expect(await readVerdictLedger()).toHaveLength(1);
  });

  it('drops entries with no branch name rather than trusting them', async () => {
    files.set(PATH, JSON.stringify({ entries: [entry(), { verdict: 'SUPERSEDED' }, null] }));
    expect(await readVerdictLedger()).toHaveLength(1);
  });
});

describe('writeVerdictLedger / recordVerdict', () => {
  it('round-trips through the versioned wrapper', async () => {
    await writeVerdictLedger([entry()]);
    expect(JSON.parse(files.get(PATH)).version).toBe(1);
    expect(await readVerdictLedger()).toHaveLength(1);
  });

  it('replaces the entry for a (repo, branch) pair instead of appending a duplicate', async () => {
    await recordVerdict(entry());
    await recordVerdict(entry({ tip: 'bbb222' }));
    const all = await readVerdictLedger();
    expect(all).toHaveLength(1);
    expect(all[0].tip).toBe('bbb222');
  });

  it('stamps decidedAt when the caller did not', async () => {
    await recordVerdict(entry());
    expect((await readVerdictLedger())[0].decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps other branches\' verdicts', async () => {
    await recordVerdict(entry());
    await recordVerdict(entry({ branch: 'cos/task-y/agent-other' }));
    expect((await readVerdictLedger()).map((e) => e.branch).sort())
      .toEqual(['cos/task-x/agent-dead', 'cos/task-y/agent-other']);
  });

  it('keeps a same-named branch in a different repo as its own entry', async () => {
    await recordVerdict(entry());
    await recordVerdict(entry({ repoPath: '/other-app', tip: 'ccc333' }));
    const all = await readVerdictLedger();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.repoPath).sort()).toEqual(['/other-app', '/repo']);
  });
});

describe('isVerdictFresh', () => {
  const REPO = { repoPath: '/repo' };
  const fresh = (e, b, ctx = {}) => isVerdictFresh(e, b, { ...REPO, ...ctx });

  it('is fresh when tip, dirty set and collision set all still match', () => {
    expect(fresh(entry(), branch())).toBe(true);
  });

  it('ignores ordering within the recorded path lists', () => {
    expect(fresh(entry({ collisionPaths: ['a.js', 'z.js'] }), branch({ collisionPaths: ['z.js', 'a.js'] })))
      .toBe(true);
  });

  it('is stale when the branch tip moved', () => {
    expect(fresh(entry(), branch({ tip: 'ccc333' }))).toBe(false);
  });

  it('is stale when the tip is unreadable — an unknown tip can never match', () => {
    expect(fresh(entry(), branch({ tip: null }))).toBe(false);
    expect(fresh(entry({ tip: null }), branch({ tip: null }))).toBe(false);
  });

  it('is stale when the uncommitted change set moved', () => {
    expect(fresh(entry(), branch({ dirtyPaths: ['a.js'] }))).toBe(false);
  });

  it('is stale when the collision set grew', () => {
    expect(fresh(entry(), branch({ collisionPaths: ['a.js', 'new.js'] }))).toBe(false);
  });

  it('is stale when the replacing commits are no longer reachable (a revert)', () => {
    expect(fresh(entry(), branch(), { replacedByPresent: false })).toBe(false);
  });

  it('refuses a verdict that names no replacing commit — the evidence IS the cache key', () => {
    expect(fresh(entry({ replacedBy: [] }), branch())).toBe(false);
    expect(fresh(entry({ replacedBy: undefined }), branch())).toBe(false);
  });

  it('only ever suppresses a SUPERSEDED verdict', () => {
    expect(fresh(entry({ verdict: 'INCOMPLETE' }), branch())).toBe(false);
    expect(fresh(null, branch())).toBe(false);
  });

  it('will not let one branch\'s verdict speak for another', () => {
    expect(fresh(entry(), branch({ branch: 'cos/task-y/agent-other' }))).toBe(false);
  });

  // One ledger serves every managed app, and `feature/x` in two apps is two
  // different branches — a verdict must never cross that boundary.
  it('will not let one repo\'s verdict speak for a same-named branch in another repo', () => {
    expect(isVerdictFresh(entry(), branch(), { repoPath: '/other-app' })).toBe(false);
  });

  it('refuses an entry that does not name the repo it was decided in', () => {
    expect(fresh(entry({ repoPath: undefined }), branch())).toBe(false);
  });
});

describe('partitionSuperseded', () => {
  const REPO = { repoPath: '/repo' };
  const split = (inFlight, entries, pred = () => true) => partitionSuperseded(inFlight, entries, pred, REPO);

  it('splits cached-superseded out of the actionable set and annotates the verdict', () => {
    const other = branch({ branch: 'feature/live', tip: 'zzz', dirtyPaths: [], collisionPaths: [] });
    const { actionable, superseded } = split([branch(), other], [entry()]);
    expect(actionable.map((b) => b.branch)).toEqual(['feature/live']);
    expect(superseded).toHaveLength(1);
    expect(superseded[0].verdict.replacedBy).toEqual(['fff999']);
  });

  it('leaves everything actionable when the ledger is empty', () => {
    const { actionable, superseded } = split([branch()], []);
    expect(actionable).toHaveLength(1);
    expect(superseded).toEqual([]);
  });

  it('consults the reachability predicate per entry', () => {
    expect(split([branch()], [entry()], () => false).actionable).toHaveLength(1);
  });

  it('ignores verdicts recorded against a different repo', () => {
    const { actionable, superseded } = split([branch()], [entry({ repoPath: '/other-app' })]);
    expect(actionable).toHaveLength(1);
    expect(superseded).toEqual([]);
  });

  it('preserves the incoming priority order of the actionable set', () => {
    const a = branch({ branch: 'claim/one' });
    const b = branch({ branch: 'feature/two' });
    const c = branch({ branch: 'scratch' });
    const { actionable } = split([a, b, c], [entry()]);
    expect(actionable.map((x) => x.branch)).toEqual(['claim/one', 'feature/two', 'scratch']);
  });

  it('tolerates a null in-flight set', () => {
    expect(split(null, [entry()])).toEqual({ actionable: [], superseded: [] });
  });
});

describe('formatSupersededForPrompt', () => {
  it('is empty when nothing is cached — no dead section in the prompt', () => {
    expect(formatSupersededForPrompt([])).toBe('');
    expect(formatSupersededForPrompt(undefined)).toBe('');
  });

  it('names the branch, the replacing commits, the backup and the worktree still on disk', () => {
    const out = formatSupersededForPrompt([{
      ...branch(),
      verdict: entry({
        was: 'honor the video backend pin',
        replacedByNote: 'backendPin.js now exports resolveVideoBackendPin()',
        backupPatch: 'data/cos/abandoned-worktree-backups/agent-dead.patch',
        decidedAt: '2026-08-12T00:00:00.000Z'
      })
    }]);
    expect(out).toContain('DO NOT ANALYZE');
    expect(out).toContain('cos/task-x/agent-dead');
    expect(out).toContain('honor the video backend pin');
    expect(out).toContain('fff999');
    expect(out).toContain('agent-dead.patch');
    expect(out).toContain('/repo/data/cos/worktrees/agent-dead');
  });

  // The reap is PortOS's own deterministic step now (reapSupersededBranches), so
  // a branch reaching this block is one the reap could not take. Handing the
  // coordinator a copy-pasteable `worktree remove` would race that step and skip
  // the backup it is gated on.
  it('never hands the agent removal commands to run', () => {
    const out = formatSupersededForPrompt([{ ...branch(), verdict: entry() }]);
    expect(out).not.toMatch(/git worktree remove/);
    expect(out).not.toMatch(/git branch -D/);
    expect(out).toMatch(/PortOS reaps/i);
  });
});

describe('recordVerdictInstruction', () => {
  it('names the ledger file and makes repoPath + replacedBy mandatory', () => {
    const text = recordVerdictInstruction();
    expect(text).toContain('data/cos/branch-reconcile-verdicts.json');
    expect(text).toContain('"verdict": "SUPERSEDED"');
    expect(text).toContain('"repoPath"');
    expect(text).toMatch(/`repoPath` and `replacedBy` are both mandatory/);
  });
});
