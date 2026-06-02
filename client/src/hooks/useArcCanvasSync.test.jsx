import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState } from 'react';

const updatePipelineSeries = vi.fn();
vi.mock('../services/api', () => ({
  updatePipelineSeries: (...args) => updatePipelineSeries(...args),
}));

import { useArcCanvasSync } from './useArcCanvasSync.js';

// Drive the hook with real useState setters so the lastSavedRef effect and the
// server-confirmed setter interact the way they do in the host pages.
function useHarness(initialSeries, initialIssues, opts) {
  const [series, setSeries] = useState(initialSeries);
  const [issues, setIssues] = useState(initialIssues);
  const sync = useArcCanvasSync({ series, setSeries, setIssues, ...opts });
  return { series, issues, setSeries, ...sync };
}

const FLUSH_FIELDS = ['name', 'logline', 'premise', 'styleNotes', 'issueCountTarget', 'universeId'];

beforeEach(() => {
  updatePipelineSeries.mockReset();
});

describe('useArcCanvasSync', () => {
  it('flushPending is a no-op when nothing diverged from the server snapshot', async () => {
    const series = { id: 's1', name: 'A', logline: 'L', llm: { provider: 'p', model: 'm' } };
    const { result } = renderHook(() => useHarness(series, [], { flushFields: FLUSH_FIELDS }));

    let did;
    await act(async () => { did = await result.current.flushPending(); });
    expect(did).toBe(false);
    expect(updatePipelineSeries).not.toHaveBeenCalled();
  });

  it('flushPending PATCHes when a tracked field diverged, then advances the baseline', async () => {
    const server = { id: 's1', name: 'A', logline: 'L', llm: null };
    updatePipelineSeries.mockResolvedValue({ ...server, name: 'B' });
    const { result } = renderHook(() => useHarness(server, [], { flushFields: FLUSH_FIELDS, silent: true }));

    // Diverge the local draft (un-persisted edit ArcCanvas would flush).
    act(() => { result.current.setSeries((s) => ({ ...s, name: 'B' })); });

    let did;
    await act(async () => { did = await result.current.flushPending(); });
    expect(did).toBe(true);
    expect(updatePipelineSeries).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'B' }), { silent: true });

    // Baseline advanced → a second flush with no new edits is a no-op.
    updatePipelineSeries.mockClear();
    await act(async () => { did = await result.current.flushPending(); });
    expect(did).toBe(false);
    expect(updatePipelineSeries).not.toHaveBeenCalled();
  });

  it('applies payloadDefaults for empty optional fields', async () => {
    const server = { id: 's1', name: 'A', titleLogo: '', author: '' };
    updatePipelineSeries.mockResolvedValue({ ...server });
    const { result } = renderHook(() => useHarness(server, [], {
      flushFields: ['name', 'titleLogo', 'author'],
      payloadDefaults: { titleLogo: '', author: '' },
      silent: true,
    }));

    act(() => { result.current.setSeries((s) => ({ ...s, name: 'B', titleLogo: undefined })); });
    await act(async () => { await result.current.flushPending(); });

    const patch = updatePipelineSeries.mock.calls[0][1];
    expect(patch.titleLogo).toBe('');
    expect(patch.author).toBe('');
    expect(patch.name).toBe('B');
  });

  it('calls onFlushError and returns false when the PATCH rejects', async () => {
    const server = { id: 's1', name: 'A' };
    updatePipelineSeries.mockRejectedValue(new Error('boom'));
    const onFlushError = vi.fn();
    const { result } = renderHook(() => useHarness(server, [], {
      flushFields: FLUSH_FIELDS, silent: true, onFlushError,
    }));

    act(() => { result.current.setSeries((s) => ({ ...s, name: 'B' })); });
    let did;
    await act(async () => { did = await result.current.flushPending(); });
    expect(did).toBe(false);
    expect(onFlushError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('handleIssuesUpdate accepts both functional and array updates', () => {
    const { result } = renderHook(() => useHarness({ id: 's1' }, [{ id: 'i1' }], { flushFields: FLUSH_FIELDS }));

    act(() => { result.current.handleIssuesUpdate((prev) => [...prev, { id: 'i2' }]); });
    expect(result.current.issues.map((i) => i.id)).toEqual(['i1', 'i2']);

    act(() => { result.current.handleIssuesUpdate([{ id: 'i3' }]); });
    expect(result.current.issues.map((i) => i.id)).toEqual(['i3']);

    // Non-array / non-function update is ignored.
    act(() => { result.current.handleIssuesUpdate('nope'); });
    expect(result.current.issues.map((i) => i.id)).toEqual(['i3']);
  });

  it('updateSeriesFromServer keeps the baseline aligned so a follow-up flush is a no-op', async () => {
    const server = { id: 's1', name: 'A' };
    const { result } = renderHook(() => useHarness(server, [], { flushFields: FLUSH_FIELDS }));

    act(() => { result.current.updateSeriesFromServer({ id: 's1', name: 'Z' }); });
    let did;
    await act(async () => { did = await result.current.flushPending(); });
    expect(did).toBe(false);
    expect(updatePipelineSeries).not.toHaveBeenCalled();
  });
});
