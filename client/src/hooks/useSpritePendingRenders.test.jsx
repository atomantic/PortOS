import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Regression coverage for the record-scoping the hook gained when it was
// lifted to the Sprites page (#2931). Before the lift the hook lived inside a
// per-record workflow and was destroyed on a record switch; now one instance
// serves every record, so it MUST drop the previous record's in-flight map on
// switch — otherwise character B inherits character A's "Rendering…" entries.

const listMediaJobs = vi.fn();
const getMediaJob = vi.fn();
vi.mock('../services/apiMediaJobs.js', () => ({
  listMediaJobs: (...args) => listMediaJobs(...args),
  getMediaJob: (...args) => getMediaJob(...args),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import { useSpritePendingRenders } from './useSpritePendingRenders.js';

const opts = (recordId) => ({
  recordId, kind: 'video', tagKey: 'spriteWalk', tagField: 'direction', onChanged: vi.fn(),
});

beforeEach(() => {
  listMediaJobs.mockReset().mockResolvedValue([]);
  getMediaJob.mockReset();
});

describe('useSpritePendingRenders record scoping', () => {
  it('reserves a key immediately and reports it as pending', () => {
    const { result } = renderHook(() => useSpritePendingRenders(opts('char-a')));
    act(() => result.current.beginSubmit('east'));
    expect(result.current.pendingJobs.east).toBe('submitting');
  });

  it('clears the in-flight map when the record switches', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useSpritePendingRenders(opts(id)),
      { initialProps: { id: 'char-a' } },
    );
    act(() => { result.current.beginSubmit('east'); result.current.resolveSubmit('east', 'job-1'); });
    expect(result.current.pendingJobs.east).toBe('job-1');

    // Switching to character B must not carry A's "east is rendering" entry.
    rerender({ id: 'char-b' });
    await waitFor(() => expect(result.current.pendingJobs.east).toBeUndefined());
    expect(result.current.pendingJobs).toEqual({});
  });

  it('exposes stable setter identities so consumers can memoize on them', () => {
    const { result, rerender } = renderHook(() => useSpritePendingRenders(opts('char-a')));
    const first = result.current;
    act(() => rerender());
    expect(result.current.beginSubmit).toBe(first.beginSubmit);
    expect(result.current.resolveSubmit).toBe(first.resolveSubmit);
    expect(result.current.cancelSubmit).toBe(first.cancelSubmit);
  });

  it('cancelSubmit only clears its own in-flight sentinel', () => {
    const { result } = renderHook(() => useSpritePendingRenders(opts('char-a')));
    act(() => { result.current.beginSubmit('east'); result.current.resolveSubmit('west', 'job-9'); });
    act(() => result.current.cancelSubmit('east'));
    expect(result.current.pendingJobs.east).toBeUndefined();
    expect(result.current.pendingJobs.west).toBe('job-9'); // a resolved sibling job is untouched
  });
});
