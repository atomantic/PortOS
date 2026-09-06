import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

// Capture the socket handler the hook registers so tests can drive the
// `cos:schedule:on-demand-empty` event, and record toast calls.
const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
  },
}));

const toastSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({ default: (...a) => toastSpy(...a) }));

const { useOnDemandTaskToast } = await import('./useOnDemandTaskToast.js');
const fire = (payload) => handlers.get('cos:schedule:on-demand-empty')?.(payload);

describe('useOnDemandTaskToast — idle outcome', () => {
  beforeEach(() => { handlers.clear(); toastSpy.mockClear(); });
  afterEach(cleanup);

  it('toasts a generic "nothing to do" for a plain idle result', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({ taskType: 'pr-watcher', appName: 'App One', outcome: 'idle' });
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][0]).toMatch(/nothing to do right now/);
  });

  it('surfaces the actionable LI reason (api-only provider) instead of "nothing to do"', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({ taskType: 'layered-intelligence', appName: 'App One', outcome: 'idle', reason: 'provider-not-agent-capable' });
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const [msg, opts] = toastSpy.mock.calls[0];
    expect(msg).toMatch(/API-only model with no coding harness — pick a CLI\/TUI provider/i);
    expect(msg).not.toMatch(/nothing to do/);
    // Warned, not the calm 💤 idle tone.
    expect(opts.icon).toBe('⚠️');
  });

  it('falls back to the generic idle toast for an LI idle result with no reason', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({ taskType: 'layered-intelligence', appName: 'App One', outcome: 'idle', reason: null });
    expect(toastSpy.mock.calls[0][0]).toMatch(/nothing to do right now/);
  });

  it('surfaces the pr-reviewer skip reason (security guard not ready) instead of "nothing to do"', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({ taskType: 'pr-reviewer', appName: 'PortOS', outcome: 'idle', reason: 'security-guard-not-ready' });
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const [msg, opts] = toastSpy.mock.calls[0];
    expect(msg).toMatch(/model-abuse classifier.*isn't ready/i);
    expect(msg).not.toMatch(/nothing to do/);
    expect(opts.icon).toBe('⚠️');
  });

  it('falls back to the raw reason string for an unglossed pr-reviewer code', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({ taskType: 'pr-reviewer', appName: 'PortOS', outcome: 'idle', reason: 'some-future-code' });
    expect(toastSpy.mock.calls[0][0]).toMatch(/some-future-code/);
  });

  it('falls back to the generic idle toast for a pr-reviewer idle result with no reason', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({ taskType: 'pr-reviewer', appName: 'PortOS', outcome: 'idle', reason: null });
    expect(toastSpy.mock.calls[0][0]).toMatch(/nothing to do right now/);
  });
});

describe('useOnDemandTaskToast — transient outcome', () => {
  beforeEach(() => { handlers.clear(); toastSpy.mockClear(); });
  afterEach(cleanup);

  it('keeps the generic "try again shortly" copy when the forge health is unknown', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({ taskType: 'claim-issue', appName: 'App One', outcome: 'transient' });
    const [msg, opts] = toastSpy.mock.calls[0];
    expect(msg).toMatch(/transient forge\/network issue/);
    expect(opts.icon).toBe('⚠️');
  });

  it('names the real fault + remedy when the forge CLI is broken in a way that will not self-clear', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({
      taskType: 'claim-issue', appName: 'App One', outcome: 'transient',
      forge: {
        cli: 'gh',
        remedy: 'gh cannot open an outbound connection. If an outbound firewall (e.g. Little Snitch) is installed, allow the gh binary to reach api.github.com — a denied connect surfaces as "bad file descriptor".'
      }
    });
    const [msg, opts] = toastSpy.mock.calls[0];
    // Names the CLI that actually failed, so a glab fault never reads as a gh one.
    expect(msg).toMatch(/the gh check couldn't run/);
    expect(msg).toMatch(/allow the gh binary to reach api\.github\.com/);
    // "try again shortly" is a dead end for a permanent fault — it must be gone.
    expect(msg).not.toMatch(/try again shortly/);
    expect(opts.duration).toBeGreaterThan(7000);
  });
});

describe('useOnDemandTaskToast — parked outcome', () => {
  beforeEach(() => { handlers.clear(); toastSpy.mockClear(); });
  afterEach(cleanup);

  it('renders a bare "no open issues" when the repo is genuinely empty', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({
      taskType: 'claim-issue', appName: 'App One', outcome: 'parked',
      parkReason: 'no-open-issues', counts: { open: 0, inFlight: 0, filtered: 0 },
      parkedUntil: new Date(Date.now() + 23 * 3600 * 1000).toISOString()
    });
    const [msg] = toastSpy.mock.calls[0];
    expect(msg).toMatch(/no open issues/);
    // open === 0 ⇒ no "(0 of N open)" breakdown.
    expect(msg).not.toMatch(/0 of/);
  });

  // branch-reconcile's park used to report 'no-in-flight-branches' while merged
  // branches sat behind a protected worktree — "nothing to do" for a task the
  // user could see had work queued, which reads as the task not running at all.
  it('names the merged branches held back rather than claiming nothing is in flight', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({
      taskType: 'branch-reconcile', appName: 'App One', outcome: 'parked',
      parkReason: 'merged-branches-held-back', counts: { heldBackMerged: 4 },
      parkedUntil: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString()
    });
    const [msg] = toastSpy.mock.calls[0];
    expect(msg).toMatch(/already merged and waiting on a protected worktree/);
    expect(msg).toMatch(/4 merged branch\(es\) held back/);
    expect(msg).not.toMatch(/no branches in flight/);
  });

  it('still reads as a genuinely empty repo when nothing is held back', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({
      taskType: 'branch-reconcile', appName: 'App One', outcome: 'parked',
      parkReason: 'no-in-flight-branches', counts: null,
      parkedUntil: new Date(Date.now() + 23 * 3600 * 1000).toISOString()
    });
    const [msg] = toastSpy.mock.calls[0];
    expect(msg).toMatch(/no branches in flight/);
    expect(msg).not.toMatch(/held back/);
  });

  it('explains the author-filter trap (not "no open issues") when open issues exist but none match the filter', () => {
    renderHook(() => useOnDemandTaskToast());
    // The detector reports filtered: 0 on this path (the issues were excluded by
    // the author filter, not the skip-list), so the toast reads a clean
    // "0 of N open" with no redundant "N filtered".
    fire({
      taskType: 'claim-issue', appName: 'App One', outcome: 'parked',
      parkReason: 'no-authored-issues', counts: { open: 10, inFlight: 0, filtered: 0 },
      parkedUntil: new Date(Date.now() + 23 * 3600 * 1000).toISOString()
    });
    const [msg] = toastSpy.mock.calls[0];
    // The actionable reason + the real open count — NOT the misleading "no open issues".
    expect(msg).toMatch(/none match the author filter/);
    expect(msg).toMatch(/set it to "any"/);
    expect(msg).toMatch(/0 of 10 open/);
    expect(msg).not.toMatch(/filtered/);
    expect(msg).not.toMatch(/re-checked now — no open issues/);
  });

  it('explains the owner-filter org trap distinctly (owner matches an org, cannot author issues)', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({
      taskType: 'claim-issue', appName: 'App One', outcome: 'parked',
      parkReason: 'owner-is-org', counts: { open: 10, inFlight: 0, filtered: 0 },
      parkedUntil: new Date(Date.now() + 23 * 3600 * 1000).toISOString()
    });
    const [msg] = toastSpy.mock.calls[0];
    // Steers the user to a working filter without implying a username mismatch.
    expect(msg).toMatch(/matches an org/);
    expect(msg).toMatch(/set it to "self" or "any"/);
    expect(msg).toMatch(/0 of 10 open/);
    expect(msg).not.toMatch(/re-checked now — no open issues/);
  });

  it('uses group-flavored copy for the GitLab owner-filter trap (a group is not an "org")', () => {
    renderHook(() => useOnDemandTaskToast());
    fire({
      taskType: 'claim-issue-gitlab', appName: 'App One', outcome: 'parked',
      parkReason: 'owner-is-group', counts: { open: 10, inFlight: 0, filtered: 0 },
      parkedUntil: new Date(Date.now() + 23 * 3600 * 1000).toISOString()
    });
    const [msg] = toastSpy.mock.calls[0];
    // GitLab-appropriate wording — "group", never "org".
    expect(msg).toMatch(/matches a group/);
    expect(msg).not.toMatch(/matches an org/);
    expect(msg).toMatch(/set it to "self" or "any"/);
    expect(msg).toMatch(/0 of 10 open/);
  });
});
