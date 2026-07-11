import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}));

import toast from '../components/ui/Toast';
import { useTwinEvaluationSuite } from './useTwinEvaluationSuite';

// Extracted from the three Digital Twin evaluation-suite panels (#2372). These
// tests pin the behaviors the three panels used to duplicate: silenced loads,
// parallel provider runs, reactive history prepend that preserves the suite's
// pass-count field, and the stale-persona / partial-failure toast fan-out.

const baseCfg = (overrides = {}) => ({
  selectedProviders: [{ providerId: 'p1', model: 'm1' }],
  personaId: '',
  countField: 'aligned',
  successToast: 'done',
  getTests: vi.fn().mockResolvedValue([{ testId: 1, testName: 'T1' }]),
  getHistory: vi.fn().mockResolvedValue([]),
  runTests: vi.fn().mockResolvedValue({
    runId: 'r1', score: 0.9, aligned: 9, total: 10, timestamp: 1, model: 'm1', personaName: null
  }),
  ...overrides
});

describe('useTwinEvaluationSuite', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads items + history with silent options and clears loading', async () => {
    const cfg = baseCfg();
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(cfg.getTests).toHaveBeenCalledWith({ silent: true });
    expect(cfg.getHistory).toHaveBeenCalledWith(5, { silent: true });
    expect(result.current.items).toHaveLength(1);
  });

  it('falls back to empty arrays when a load rejects (no crash, no toast)', async () => {
    const cfg = baseCfg({
      getTests: vi.fn().mockRejectedValue(new Error('boom')),
      getHistory: vi.fn().mockRejectedValue(new Error('boom'))
    });
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([]);
    expect(result.current.history).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('runs every selected provider in parallel and silences each call', async () => {
    const cfg = baseCfg({
      selectedProviders: [
        { providerId: 'p1', model: 'm1' },
        { providerId: 'p2', model: 'm2' }
      ]
    });
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.run(); });

    expect(cfg.runTests).toHaveBeenCalledTimes(2);
    expect(cfg.runTests).toHaveBeenCalledWith('p1', 'm1', null, null, { silent: true });
    expect(result.current.results).toHaveLength(2);
    expect(toast.success).toHaveBeenCalledWith('done');
  });

  it('passes personaId through when set (null when empty)', async () => {
    const cfg = baseCfg({ personaId: 'persona-7' });
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.run(); });
    expect(cfg.runTests).toHaveBeenCalledWith('p1', 'm1', null, 'persona-7', { silent: true });
  });

  it('prepends a fresh run to history preserving the suite count field', async () => {
    const cfg = baseCfg({ countField: 'held', getHistory: vi.fn().mockResolvedValue([]) });
    cfg.runTests = vi.fn().mockResolvedValue({
      runId: 'r9', score: 0.7, held: 7, total: 10, timestamp: 42, model: 'm1', personaName: 'Alt'
    });
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.run(); });

    expect(result.current.history[0]).toMatchObject({
      runId: 'r9', score: 0.7, held: 7, total: 10, personaName: 'Alt'
    });
  });

  it('caps prepended history at 5 entries', async () => {
    const existing = Array.from({ length: 5 }, (_, i) => ({ runId: `old-${i}`, score: 0.5, aligned: 1, total: 2 }));
    const cfg = baseCfg({ getHistory: vi.fn().mockResolvedValue(existing) });
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.run(); });

    expect(result.current.history).toHaveLength(5);
    expect(result.current.history[0].runId).toBe('r1');
  });

  it('errors and does not run when no providers are selected', async () => {
    const cfg = baseCfg({ selectedProviders: [] });
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.run(); });

    expect(cfg.runTests).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Select at least one provider/model above');
  });

  it('calls onPersonaNotFound + persona toast when a run reports NOT_FOUND', async () => {
    const onPersonaNotFound = vi.fn();
    const cfg = baseCfg({
      onPersonaNotFound,
      runTests: vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { code: 'NOT_FOUND' }))
    });
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.run(); });

    expect(onPersonaNotFound).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      'That persona no longer exists — switched to the base twin. Try again.'
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows a partial-failure toast (not success) when some runs error without NOT_FOUND', async () => {
    const cfg = baseCfg({
      selectedProviders: [
        { providerId: 'p1', model: 'm1' },
        { providerId: 'p2', model: 'm2' }
      ]
    });
    cfg.runTests = vi.fn()
      .mockResolvedValueOnce({ runId: 'r1', score: 0.9, aligned: 9, total: 10, timestamp: 1, model: 'm1' })
      .mockRejectedValueOnce(new Error('provider down'));
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.run(); });

    expect(toast.error).toHaveBeenCalledWith('Some runs failed — check provider availability');
    expect(toast.success).not.toHaveBeenCalled();
    // The one good run still lands in history; the failed one is filtered out.
    expect(result.current.history).toHaveLength(1);
  });

  it('fires onRefresh after every completed run', async () => {
    const onRefresh = vi.fn();
    const cfg = baseCfg({ onRefresh });
    const { result } = renderHook(() => useTwinEvaluationSuite(cfg));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.run(); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
