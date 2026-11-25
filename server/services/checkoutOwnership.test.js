/**
 * Checkout recovery vs the operator's own interactive session (#16075).
 *
 * The incident: a recovery task ran three times in eight minutes while the
 * operator's Claude Code session had the checkout as its cwd, each run ending in
 * the same permanent block, and each block blamed that session for a commit
 * PortOS's own git service had made. These tests pin the dispatch hold (holds
 * while the session is live and work remains, releases when it exits or the
 * checkout settles) and the PortOS-authored commit classification.
 */
// test-memo: git-fixture — git only ever runs in repositories this suite creates under the temp directory (docs/TEST_MEMO.md#git-fixtures).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('./cos/cosEvents.js', () => ({
  emitLog: vi.fn(),
  cosEvents: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('./agent/agentAppWorkspace.js', () => ({ getAppWorkspace: vi.fn() }));

import { emitLog } from './cos/cosEvents.js';
import { getAppWorkspace } from './agent/agentAppWorkspace.js';
import {
  checkoutOwnerHoldReason, describeCheckoutOwnership, __resetCheckoutOwnerGate,
} from './checkoutOwnership.js';
import { commit } from './git.js';
import { buildCheckoutRecoveryCompletionSection } from './promptSections/completion.js';

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

let root;
let repo;
let sessionsDir;
const recoveryTask = { id: 'task-recover', metadata: { app: 'app-1', analysisType: 'app-checkout-recovery' } };

async function writeSession(pid, fields = {}) {
  await writeFile(join(sessionsDir, `${pid}.json`), JSON.stringify({
    pid, sessionId: `session-${pid}`, cwd: repo, kind: 'interactive', status: 'busy', ...fields,
  }));
}

beforeEach(async () => {
  __resetCheckoutOwnerGate();
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'checkout-owner-'));
  repo = join(root, 'repo');
  sessionsDir = join(root, 'sessions');
  await mkdir(repo);
  await mkdir(sessionsDir);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'initial');
  getAppWorkspace.mockResolvedValue(repo);
});

afterEach(async () => {
  __resetCheckoutOwnerGate();
  await rm(root, { recursive: true, force: true });
});

describe('checkoutOwnerHoldReason', () => {
  const alive = new Set([4242]);
  const opts = () => ({ sessionsDir, pidAlive: pid => alive.has(pid) });

  it('holds a recovery dispatch while a live interactive session owns a dirty checkout, announcing it once', async () => {
    await writeSession(4242);
    await writeFile(join(repo, 'a.txt'), 'operator edit\n');

    const first = await checkoutOwnerHoldReason(recoveryTask, opts());
    const second = await checkoutOwnerHoldReason(recoveryTask, opts());

    expect(first).toMatch(/operator's interactive agent session/);
    expect(first).toContain('pid 4242, status busy');
    expect(second).toBe(first);
    expect(emitLog).toHaveBeenCalledTimes(1);
  });

  it('releases the hold once the session exits', async () => {
    await writeSession(4242);
    await writeFile(join(repo, 'a.txt'), 'operator edit\n');
    expect(await checkoutOwnerHoldReason(recoveryTask, opts())).toBeTruthy();

    expect(await checkoutOwnerHoldReason(recoveryTask, { sessionsDir, pidAlive: () => false })).toBeNull();
  });

  it('does not hold when the checkout is clean on its default branch', async () => {
    await writeSession(4242);
    expect(await checkoutOwnerHoldReason(recoveryTask, opts())).toBeNull();
  });

  it('ignores non-interactive sessions, other checkouts and linked worktrees nested inside', async () => {
    await writeFile(join(repo, 'a.txt'), 'pending\n');
    const nested = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', nested);
    alive.add(5001).add(5002).add(5003);
    await writeSession(5001, { kind: 'sdk' });
    await writeSession(5002, { cwd: root });
    await writeSession(5003, { cwd: nested });

    expect((await describeCheckoutOwnership(repo, opts())).sessions).toEqual([]);
    expect(await checkoutOwnerHoldReason(recoveryTask, opts())).toBeNull();
  });

  it('never holds other task types', async () => {
    await writeSession(4242);
    await writeFile(join(repo, 'a.txt'), 'operator edit\n');
    expect(await checkoutOwnerHoldReason({ id: 't', metadata: { app: 'app-1' } }, opts())).toBeNull();
    expect(getAppWorkspace).not.toHaveBeenCalled();
  });
});

describe('describeCheckoutOwnership', () => {
  it('classifies a commit made through PortOS git service as PortOS-authored, and a direct commit as not', async () => {
    await writeFile(join(repo, 'a.txt'), 'portos change\n');
    await commit(repo, 'PortOS commit', { paths: ['a.txt'] });
    const portos = { hash: git(repo, 'rev-parse', 'HEAD') };
    await writeFile(join(repo, 'a.txt'), 'other change\n');
    git(repo, 'commit', '-q', '-am', 'other writer');
    const other = git(repo, 'rev-parse', 'HEAD');

    const ownership = await describeCheckoutOwnership(repo, { sessionsDir, pidAlive: () => false });

    expect(ownership.portosCommits).toEqual([portos.hash]);
    expect(ownership.portosCommits).not.toContain(other);
    const section = buildCheckoutRecoveryCompletionSection({ sentinelPath: '/tmp/done', ownership });
    expect(section).toContain(portos.hash);
    expect(section).toContain('made by PortOS itself');
  });

  it('names a live session in the recovery prompt as the operator session with its status', () => {
    const section = buildCheckoutRecoveryCompletionSection({ sentinelPath: '/tmp/done',
      ownership: { sessions: [{ pid: 4242, sessionId: 's', status: 'idle' }], portosCommits: [] } });
    expect(section).toContain('pid 4242 (status idle)');
    expect(section).toMatch(/interactive operator session with its status/);
  });
});
