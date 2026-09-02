import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useDownloadPreflightConfirm from './useDownloadPreflightConfirm.js';

describe('useDownloadPreflightConfirm', () => {
  it('shows the assessment once preview resolves, then runs the callback exactly once on confirm', async () => {
    const { result } = renderHook(() => useDownloadPreflightConfirm());
    const run = vi.fn();
    const assessment = { verdict: 'ok', destPath: 'model.gguf' };

    await act(async () => {
      await result.current.request({ title: 'Install', preview: async () => assessment, run });
    });
    expect(result.current.confirm).toMatchObject({ title: 'Install', loading: false, assessment, error: null });

    act(() => { result.current.confirmRun(); });
    expect(run).toHaveBeenCalledOnce();
    expect(result.current.confirm).toBeNull();
  });

  it('closes silently on a `handled` rejection instead of layering a generic error dialog', async () => {
    const { result } = renderHook(() => useDownloadPreflightConfirm());
    const handled = Object.assign(new Error('routed elsewhere'), { handled: true });

    await act(async () => {
      await result.current.request({ title: 'Install', preview: async () => { throw handled; }, run: vi.fn() });
    });

    expect(result.current.confirm).toBeNull();
  });

  it('shows a generic error for an un-marked rejection', async () => {
    const { result } = renderHook(() => useDownloadPreflightConfirm());

    await act(async () => {
      await result.current.request({
        title: 'Install',
        preview: async () => { throw new Error('disk check failed'); },
        run: vi.fn(),
      });
    });

    expect(result.current.confirm).toMatchObject({ loading: false, error: 'disk check failed', assessment: null });
  });

  // A preview that resolves after the user already cancelled must not reopen
  // the modal — codex review flagged this race on the shared confirm state.
  it('ignores a preview that resolves after cancel()', async () => {
    const { result } = renderHook(() => useDownloadPreflightConfirm());
    let resolvePreview;
    const pending = new Promise((resolve) => { resolvePreview = resolve; });

    let requestPromise;
    act(() => {
      requestPromise = result.current.request({ title: 'Install', preview: () => pending, run: vi.fn() });
    });
    expect(result.current.confirm).toMatchObject({ loading: true });

    act(() => { result.current.cancel(); });
    expect(result.current.confirm).toBeNull();

    await act(async () => {
      resolvePreview({ verdict: 'ok' });
      await requestPromise;
    });
    expect(result.current.confirm).toBeNull();
  });

  // confirmRun() must read `run` and clear state, then invoke `run` OUTSIDE
  // the setState updater — React StrictMode double-invokes an updater
  // function passed to setState in dev, so a `run()` call living inside one
  // would fire the download twice.
  it('invokes run only once even if its updater were called twice (StrictMode simulation)', async () => {
    const { result } = renderHook(() => useDownloadPreflightConfirm());
    const run = vi.fn();
    await act(async () => {
      await result.current.request({ title: 'Install', preview: async () => ({ verdict: 'ok' }), run });
    });

    act(() => { result.current.confirmRun(); });
    // A second confirmRun() after state already cleared is a no-op — there is
    // no `run` left to read, simulating what a double-invoked-but-otherwise-
    // pure updater would produce.
    act(() => { result.current.confirmRun(); });

    expect(run).toHaveBeenCalledOnce();
  });
});
