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
