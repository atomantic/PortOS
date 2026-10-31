import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { markLegacyRetirements, applyLegacyRetirementResolutions } from '../lib/legacyRetirementTransition.js';
import { _planLegacyRetirementReconciliation } from './legacyRetirementReconciliation.js';
import migration from '../../scripts/migrations/443-legacy-retirement-record-transition.js';

let root, repo;
const git = async (...args) => (await execGit(args, repo)).stdout.trim();
const save = async (path, value) => writeFile(path, `${JSON.stringify(value)}\n`);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'portos-legacy-retirement-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'fixture@example.test');
  await git('config', 'user.name', 'Fixture');
  await writeFile(join(repo, 'initial.txt'), 'base\n');
  await git('add', '.'); await git('commit', '-m', 'base');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function historicalRow() {
  const head = await git('rev-parse', 'HEAD');
  return { row: { path: join(root, 'old-checkout'), branch: 'feature/absent', head,
    reason: 'retirement-provenance-unverified', createdAt: '2026-01-02T00:00:00.000Z' }, mainHead: head };
}

describe('legacy retirement transition at the persisted reconciliation boundary', () => {
  it.each(['absent-history', 'active-owner', 'human-handoff', 'foreign-owner', 'live-checkout', 'unknown-ref', 'new-incident'])(
    'reconciles local absence without asserting delivery or removal: %s', async scenario => {
      const { row, mainHead } = await historicalRow();
      const outcome = { status: 'incomplete', retirementObligations: [row], remaining: [row], retired: [] };
      if (scenario !== 'new-incident') markLegacyRetirements(outcome);
      const owners = scenario === 'active-owner' ? [{ id: 'current-owner', status: 'running', metadata: { claimBranches: [row.branch] } }] : [];
      if (scenario === 'human-handoff') owners.push({ id: 'human-owner', status: 'completed', metadata: {
        branchCompletionPolicy: { branch: row.branch, completion: 'leave-open' },
      } });
      if (scenario === 'foreign-owner') {
        const other = join(root, 'independent-clone');
        await mkdir(other); await execGit(['init'], other);
        owners.push({ id: 'foreign-owner', status: 'running', metadata: { sourceWorkspace: other, claimBranches: [row.branch] } });
      }
      if (scenario === 'unknown-ref') row.branch = '../invalid-ref';
      if (scenario === 'live-checkout') { await mkdir(row.path); await writeFile(join(row.path, 'unfinished.txt'), 'new owner work\n'); }
      const input = { repoPath: repo, outcome, agents: owners, trees: [] };
      const plans = await _planLegacyRetirementReconciliation(input);
      const expected = ['absent-history', 'foreign-owner'].includes(scenario);
      expect(plans).toHaveLength(expected ? 1 : 0);
      if (!expected) return;
      expect(plans[0].removalVerified).toBe(false);
      expect(plans[0].evidence).toEqual({ kind: 'current-local-absence', deliveryVerified: false, preservationVerified: false });
      const path = join(root, 'outcome.json');
      await save(path, applyLegacyRetirementResolutions(outcome, plans, '2026-01-03T00:00:00.000Z'));
      const restarted = JSON.parse(await readFile(path, 'utf8'));
      expect(restarted.retirementObligations).toEqual([]);
      expect(restarted.remaining).toEqual([]);
      expect(restarted.retired).toEqual([]); // No manufactured service receipt.
      expect(restarted.legacyRetirementTransition.resolutions[0].observation).toEqual(row);
      expect(await _planLegacyRetirementReconciliation({ ...input, outcome: restarted })).toEqual([]);
      expect(await git('rev-parse', 'main')).toBe(mainHead);
    });

  it('uses a unique real receipt to identify a malformed late row, retaining audit history', async () => {
    const { row } = await historicalRow();
    const malformed = { branch: row.branch, head: row.branch, reason: row.reason, createdAt: row.createdAt };
    const receipt = { ...row, checkoutIdentity: 'a'.repeat(64), branchDeleted: true, archiveDir: null, retiredAt: '2026-01-01T00:00:00.000Z' };
    const outcome = { retirementObligations: [malformed], remaining: [malformed], retired: [receipt] };
    markLegacyRetirements(outcome);
    const plans = await _planLegacyRetirementReconciliation({ repoPath: repo, outcome, agents: [], trees: [] });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ removalVerified: false, evidence: { kind: 'current-local-absence', preservationVerified: false } });
    // A newer reviewed head retired the same physical checkout after this
    // observation. Old intermediate heads are not separate lost checkouts.
    const intermediate = { ...row, head: 'c'.repeat(40), checkoutIdentity: receipt.checkoutIdentity,
      createdAt: '2025-12-31T00:00:00.000Z' };
    const progressed = { retirementObligations: [intermediate], remaining: [intermediate], retired: [receipt] };
    markLegacyRetirements(progressed);
    expect(await _planLegacyRetirementReconciliation({ repoPath: repo, outcome: progressed, agents: [], trees: [] }))
      .toMatchObject([{ removalVerified: false, observation: intermediate }]);
    const changed = { ...malformed, checkoutIdentity: 'b'.repeat(64) };
    const different = { retirementObligations: [changed], remaining: [changed], retired: [receipt] };
    markLegacyRetirements(different);
    expect(await _planLegacyRetirementReconciliation({ repoPath: repo, outcome: different, agents: [], trees: [] }))
      .toMatchObject([{ removalVerified: false, evidence: { kind: 'current-local-absence', preservationVerified: false } }]);
  });

  it('settles an absent ref after the migration but preserves recreated refs and unique checkout files', async () => {
    const branch = 'feature/released';
    const row = { branch, reason: 'retirement-provenance-unverified', createdAt: '2026-01-03T00:00:00.000Z' };
    const outcome = { remaining: [row], retirementObligations: [row],
      legacyRetirementTransition: { version: 1, observations: [], resolutions: [] } };
    const input = { repoPath: repo, outcome, agents: [], trees: [] };
    const plan = await _planLegacyRetirementReconciliation(input);
    const saved = applyLegacyRetirementResolutions(outcome, plan, '2026-01-04T00:00:00.000Z');
    expect(saved.remaining).toEqual([]);
    expect(saved.retirementObligations).toEqual([]);
    expect(saved.retired).toBeUndefined();
    expect(saved.legacyRetirementTransition.resolutions).toMatchObject([
      { observation: row, removalVerified: false, evidence: { deliveryVerified: false, preservationVerified: false } },
    ]);
    expect(await _planLegacyRetirementReconciliation({ ...input, outcome: JSON.parse(JSON.stringify(saved)) })).toEqual([]);
    await git('branch', branch);
    expect(await _planLegacyRetirementReconciliation(input)).toEqual([]);
    await git('branch', '-d', branch);
    const path = join(root, 'unique-work');
    await mkdir(path); await writeFile(join(path, 'unique.txt'), 'keep me');
    const held = { ...row, path };
    expect(await _planLegacyRetirementReconciliation({ ...input, outcome: { ...outcome, remaining: [held], retirementObligations: [held] } })).toEqual([]);
    expect(await readFile(join(path, 'unique.txt'), 'utf8')).toBe('keep me');
  });

  describe('absent checkouts whose head is preserved', () => {
    const transition = () => ({ version: 1, observations: [], resolutions: [] });
    const plan = (row, extra = {}) => {
      const outcome = { remaining: [row], retirementObligations: [row], legacyRetirementTransition: transition(), ...extra };
      return _planLegacyRetirementReconciliation({ repoPath: repo, outcome, agents: [], trees: [] });
    };

    it('settles an unlocked receipt-unverified row whose head is on the default branch', async () => {
      const head = await git('rev-parse', 'HEAD');
      const row = { path: join(root, 'gone'), branch: 'claim/issue-1', head, reason: 'retirement-receipt-unverified',
        createdAt: '2026-01-02T00:00:00.000Z' };
      expect(await plan(row)).toMatchObject([{ disposition: 'absent-head-preserved', removalVerified: false,
        evidence: { kind: 'absent-head-preserved', preservationVerified: true } }]);
    });

    it('settles a locked absent row only when a retained-source ref preserves its head', async () => {
      await git('checkout', '-b', 'abandoned');
      await writeFile(join(repo, 'abandoned.txt'), 'x\n');
      await git('add', '.'); await git('commit', '-m', 'abandoned work');
      const head = await git('rev-parse', 'HEAD');
      await git('checkout', 'main');
      await git('branch', '-D', 'abandoned');
      const row = { path: join(root, 'gone'), branch: 'codex/release-agent', head, locked: true,
        reason: 'retirement-provenance-unverified', createdAt: '2026-01-02T00:00:00.000Z' };
      expect(await plan(row)).toEqual([]);
      await git('update-ref', `refs/portos/retained-checkout-source/${head}`, head);
      expect(await plan(row)).toMatchObject([{ disposition: 'absent-head-preserved' }]);
      const saved = applyLegacyRetirementResolutions({ remaining: [row], retirementObligations: [row],
        legacyRetirementTransition: transition() }, await plan(row), '2026-01-04T00:00:00.000Z');
      expect(saved.remaining).toEqual([]);
      expect(saved.retirementObligations).toEqual([]);
    });

    it('holds a row whose checkout, local ref or remote-tracking ref still exists', async () => {
      const head = await git('rev-parse', 'HEAD');
      const row = { path: join(root, 'gone'), branch: 'claim/issue-2', head, locked: true,
        reason: 'retirement-receipt-unverified', createdAt: '2026-01-02T00:00:00.000Z' };
      await mkdir(row.path);
      expect(await plan(row)).toEqual([]);
      await rm(row.path, { recursive: true });
      await git('update-ref', 'refs/remotes/origin/claim/issue-2', head);
      expect(await plan(row)).toEqual([]);
      await git('update-ref', '-d', 'refs/remotes/origin/claim/issue-2');
      await git('branch', row.branch);
      expect(await plan(row)).toEqual([]);
    });
  });

  it('migration freezes only existing records, survives replay, and changes no task policy or worktree', async () => {
    const { row } = await historicalRow();
    const path = join(root, 'data/cos/task-schedule.json');
    await mkdir(join(root, 'data/cos'), { recursive: true });
    const schedule = { tasks: { 'claim-issue': { enabled: true, failureCount: 3 } }, executions: {
      'task:branch-reconcile': { perApp: { example: { branchReconcileOutcome: { retirementObligations: [row], remaining: [row] } } } },
    } };
    await save(path, schedule);
    expect(await migration.up({ rootDir: root })).toEqual({ marked: 1 });
    const first = await readFile(path, 'utf8');
    expect(await migration.up({ rootDir: root })).toEqual({ marked: 0 });
    expect(await readFile(path, 'utf8')).toBe(first);
    const current = JSON.parse(first);
    expect(current.tasks).toEqual(schedule.tasks);
    expect(current.executions['task:branch-reconcile'].perApp.example.branchReconcileOutcome.remaining).toEqual([row]);
    expect(await git('status', '--porcelain')).toBe('');
  });
});
