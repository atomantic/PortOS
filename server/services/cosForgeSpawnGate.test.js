/**
 * The forge-reachability dispatch gate (issue #5110).
 *
 * The incident: a user task targeting a repo on an enterprise GitHub host ran
 * three times and failed all three with `forge-unreachable`, because the VPN was
 * down and the host did not resolve. The agent had done the work correctly on run
 * one — the branch already held every commit — and only `git push` failed. Because
 * `forge-unreachable` is (correctly) non-actionable, each failure bought a retry,
 * so 101 + 50 + 23 minutes of Opus went into re-learning one DNS failure before the
 * task reached `blocked`.
 *
 * These tests pin the two halves that make the fix safe: it holds for the
 * transient network status and ONLY that one, and every "we could not tell" path
 * declines to hold rather than guessing — because a hold that fires wrongly stalls
 * the queue with no status write to show for it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn(),
  cosEvents: { emit: vi.fn() },
}));
vi.mock('./github.js', () => ({ checkGhHealth: vi.fn() }));
// `isClaimFlowTask` is a plain seam here: this suite asserts the gate CONSULTS it
// and honors its answer, not what it decides (that lives in agentPromptBuilder's
// own tests, and re-deriving it here is how two copies drift).
vi.mock('./agentPromptBuilder.js', () => ({
  getAppWorkspace: vi.fn(),
  isClaimFlowTask: vi.fn().mockReturnValue(false),
}));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));

import { taskNeedsForge, forgeSpawnHoldReason, __resetForgeSpawnGate } from './cosForgeSpawnGate.js';
import { emitLog, cosEvents } from './cosEvents.js';
import { checkGhHealth } from './github.js';
import { getAppWorkspace, isClaimFlowTask } from './agentPromptBuilder.js';
import { execGit } from '../lib/execGit.js';

const remote = (url) => execGit.mockResolvedValue({ stdout: `${url}\n`, stderr: '', exitCode: 0 });
const probe = (status, detail = null) => checkGhHealth.mockResolvedValue({ status, ok: status === 'ok', detail });

const prTask = (overrides = {}) => ({ id: 'task-1', metadata: { openPR: true, ...overrides } });

describe('taskNeedsForge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isClaimFlowTask.mockReturnValue(false);
  });

  it('is true for a task that promised a change request', () => {
    expect(taskNeedsForge({ metadata: { openPR: true } })).toBe(true);
  });

  // Task metadata round-trips through markdown, so booleans come back as strings.
  it('accepts the string form openPR survives persistence as', () => {
    expect(taskNeedsForge({ metadata: { openPR: 'true' } })).toBe(true);
  });

  it('is true for a claim-flow task, which cannot even pick an issue with the forge down', () => {
    isClaimFlowTask.mockReturnValue(true);

    expect(taskNeedsForge({ metadata: {} })).toBe(true);
  });

  it('is false for a task that can finish with the forge down', () => {
    expect(taskNeedsForge({ metadata: { openPR: false } })).toBe(false);
    expect(taskNeedsForge({ metadata: {} })).toBe(false);
    expect(taskNeedsForge(null)).toBe(false);
  });
});

describe('forgeSpawnHoldReason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForgeSpawnGate();
    isClaimFlowTask.mockReturnValue(false);
    getAppWorkspace.mockResolvedValue('/repos/app');
    remote('git@forge.example.com:acme/app.git');
    probe('ok');
  });

  it('holds a PR-shaped task when its forge is unreachable', async () => {
    probe('unreachable', 'error connecting to forge.example.com');

    expect(await forgeSpawnHoldReason(prTask())).toBe('forge.example.com is unreachable');
  });

  it('does not probe at all for a task that does not need the forge', async () => {
    probe('unreachable');

    expect(await forgeSpawnHoldReason({ id: 'task-2', metadata: {} })).toBeNull();
    expect(checkGhHealth).not.toHaveBeenCalled();
  });

  it('probes the host in the repo\'s own origin, not gh\'s default host', async () => {
    // A bare probe hits github.com. Gating an enterprise repo on github.com's
    // health is exactly the wrong-forge verdict `checkGhHealth`'s host-keyed cache
    // exists to prevent — and in this incident github.com was perfectly healthy
    // while the host the push needed was not.
    remote('https://ghes.example.com/acme/app.git');
    probe('unreachable');

    await forgeSpawnHoldReason(prTask());

    expect(checkGhHealth).toHaveBeenCalledWith({ hostname: 'ghes.example.com' });
  });

  it('resolves the repo through the app registry when the task carries an app', async () => {
    getAppWorkspace.mockResolvedValue('/repos/managed-app');

    await forgeSpawnHoldReason(prTask({ app: 'app-id' }));

    expect(getAppWorkspace).toHaveBeenCalledWith('app-id');
    expect(execGit).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/repos/managed-app', expect.anything());
  });

  describe('holds only for the status that clears on its own', () => {
    // The chokepoint's contract is "a condition that clears on its own". A missing
    // binary or a missing credential never will, so holding on those would stall
    // every forge-dependent task silently and forever — strictly worse than
    // today's three failures and a Blocked card naming the problem.
    it.each(['ok', 'not-installed', 'not-authenticated', 'error'])('dispatches on %s', async (status) => {
      probe(status, 'some detail');

      expect(await forgeSpawnHoldReason(prTask())).toBeNull();
    });

    it('dispatches when the probe itself blows up', async () => {
      checkGhHealth.mockRejectedValue(new Error('probe exploded'));

      expect(await forgeSpawnHoldReason(prTask())).toBeNull();
    });
  });

  describe('declines to hold whenever it cannot name a reachable-or-not host', () => {
    it('never probes a GitLab remote, which gh cannot answer for', async () => {
      // `checkGhHealth` shells out to `gh`. Pointed at a GitLab host it answers
      // nothing useful, so probing one would report every gitlab.* repo
      // unreachable and hold it forever.
      remote('git@gitlab.example.com:group/app.git');
      probe('unreachable');

      expect(await forgeSpawnHoldReason(prTask())).toBeNull();
      expect(checkGhHealth).not.toHaveBeenCalled();
    });

    it('dispatches when the directory has no origin remote', async () => {
      execGit.mockResolvedValue({ stdout: '', stderr: 'no such remote', exitCode: 2 });
      probe('unreachable');

      expect(await forgeSpawnHoldReason(prTask())).toBeNull();
      expect(checkGhHealth).not.toHaveBeenCalled();
    });

    it('dispatches when the origin URL does not parse into a host', async () => {
      remote('/srv/local/bare-repo.git');
      probe('unreachable');

      expect(await forgeSpawnHoldReason(prTask())).toBeNull();
    });

    it('dispatches when git itself fails', async () => {
      execGit.mockRejectedValue(new Error('not a git repository'));

      expect(await forgeSpawnHoldReason(prTask())).toBeNull();
    });

    // agentWorkspacePrep already blocks an unresolvable app with a message naming
    // it. An indefinite silent hold would replace that answer with nothing.
    it('dispatches when the task\'s app resolves to no workspace', async () => {
      getAppWorkspace.mockResolvedValue(null);
      probe('unreachable');

      expect(await forgeSpawnHoldReason(prTask({ app: 'ghost-app' }))).toBeNull();
      expect(execGit).not.toHaveBeenCalled();
    });
  });

  describe('the way out', () => {
    it('asks for another dequeue so a held task spawns when the network returns', async () => {
      vi.useFakeTimers();
      probe('unreachable');

      await forgeSpawnHoldReason(prTask());
      expect(cosEvents.emit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(70_000);

      expect(cosEvents.emit).toHaveBeenCalledWith('cos:dequeue-requested');
      vi.useRealTimers();
    });

    it('arms one re-check for a whole queue of held tasks, not one each', async () => {
      vi.useFakeTimers();
      probe('unreachable');

      await forgeSpawnHoldReason(prTask({ }));
      await forgeSpawnHoldReason({ id: 'task-2', metadata: { openPR: true } });
      await forgeSpawnHoldReason({ id: 'task-3', metadata: { openPR: true } });
      await vi.advanceTimersByTimeAsync(70_000);

      const dequeues = cosEvents.emit.mock.calls.filter(([event]) => event === 'cos:dequeue-requested');
      expect(dequeues).toHaveLength(1);
      vi.useRealTimers();
    });

    // A permanently-broken remote is not "a condition that clears on its own", and
    // a task sitting `pending` in silence tells the user less than the Blocked card
    // the pre-gate behavior produced.
    it('stops holding a host that has been unreachable for over an hour', async () => {
      probe('unreachable');
      const start = 1_000_000;

      expect(await forgeSpawnHoldReason(prTask(), { now: start })).toBe('forge.example.com is unreachable');
      expect(await forgeSpawnHoldReason(prTask(), { now: start + 59 * 60_000 })).toBe('forge.example.com is unreachable');
      expect(await forgeSpawnHoldReason(prTask(), { now: start + 61 * 60_000 })).toBeNull();
    });

    it('gives a recovered host a fresh budget, so the next outage holds again', async () => {
      const start = 1_000_000;
      probe('unreachable');
      await forgeSpawnHoldReason(prTask(), { now: start });

      probe('ok');
      await forgeSpawnHoldReason(prTask(), { now: start + 10 * 60_000 });

      // Without clearing the ledger on recovery, the second outage would inherit
      // the first one's elapsed clock and stop holding early — or never hold.
      probe('unreachable');
      expect(await forgeSpawnHoldReason(prTask(), { now: start + 61 * 60_000 })).toBe('forge.example.com is unreachable');
    });
  });

  describe('logging', () => {
    it('warns once per outage naming the host, not once per held task', async () => {
      probe('unreachable', 'error connecting to forge.example.com');

      await forgeSpawnHoldReason(prTask());
      await forgeSpawnHoldReason({ id: 'task-2', metadata: { openPR: true } });
      await forgeSpawnHoldReason({ id: 'task-3', metadata: { openPR: true } });

      const warnings = emitLog.mock.calls.filter(([level]) => level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain('forge.example.com is unreachable');
    });

    it('warns once when it gives up on a host, so the expiry is not silent', async () => {
      probe('unreachable');
      const start = 1_000_000;
      await forgeSpawnHoldReason(prTask(), { now: start });
      emitLog.mockClear();

      await forgeSpawnHoldReason(prTask(), { now: start + 61 * 60_000 });
      await forgeSpawnHoldReason(prTask(), { now: start + 62 * 60_000 });

      const warnings = emitLog.mock.calls.filter(([level]) => level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain('over an hour');
    });
  });
});
