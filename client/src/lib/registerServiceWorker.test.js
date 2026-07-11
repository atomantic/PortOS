import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerServiceWorker, unregisterServiceWorkers } from './registerServiceWorker.js';

// These tests run in the node env in CI (no jsdom) AND in the client's own
// jsdom vitest, so `navigator`/`window`/`document` are stubbed per-case.
// `registerServiceWorker()` picks its branch from `import.meta.hot` (dev server
// → tear down; production build → register), whose ambient value differs
// between those two runners — so the register-path assertions below are
// deliberately branch-agnostic. The production register path is proved
// end-to-end by the headless-Chrome verification, not here.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unregisterServiceWorkers', () => {
  it('no-ops when service workers are unsupported', async () => {
    vi.stubGlobal('navigator', {});
    await expect(unregisterServiceWorkers()).resolves.toBeUndefined();
  });

  it('unregisters every existing registration', async () => {
    const unregA = vi.fn().mockResolvedValue(true);
    const unregB = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([{ unregister: unregA }, { unregister: unregB }]),
      },
    });
    await unregisterServiceWorkers();
    expect(unregA).toHaveBeenCalledOnce();
    expect(unregB).toHaveBeenCalledOnce();
  });

  it('swallows a failing getRegistrations', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockRejectedValue(new Error('nope')) },
    });
    await expect(unregisterServiceWorkers()).resolves.toBeUndefined();
  });
});

describe('registerServiceWorker', () => {
  it('no-ops without service worker support', () => {
    vi.stubGlobal('navigator', {});
    expect(() => registerServiceWorker()).not.toThrow();
  });

  it('takes exactly one lifecycle path (register OR tear down) without throwing', async () => {
    const register = vi.fn().mockResolvedValue({ scope: '/' });
    const getRegistrations = vi.fn().mockResolvedValue([]);
    vi.stubGlobal('navigator', { serviceWorker: { register, getRegistrations } });
    // readyState 'complete' → register fires synchronously (no window 'load'
    // deferral), keeping the assertion deterministic across both test runners.
    vi.stubGlobal('document', { readyState: 'complete' });
    vi.stubGlobal('window', { addEventListener: vi.fn() });

    expect(() => registerServiceWorker()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    const registered = register.mock.calls.length > 0;
    const toreDown = getRegistrations.mock.calls.length > 0;
    // Exactly one branch runs.
    expect(registered).not.toBe(toreDown);
    // If it registered, it must target the root-scoped worker.
    if (registered) expect(register).toHaveBeenCalledWith('/sw.js');
  });
});
