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
