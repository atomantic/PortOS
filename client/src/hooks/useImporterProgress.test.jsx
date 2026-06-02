import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { CheckCircle2, AlertTriangle, Loader2, Circle } from 'lucide-react';

// Mock the socket module so the test can drive the `importer:progress` handler
// the hook registers with `on()` and observe the `emit()` replay requests.
const handlers = new Map();
const emitted = [];
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: (event, ...args) => { emitted.push([event, ...args]); },
  },
}));

import { useImporterProgress, stageStatusIcon } from './useImporterProgress.js';

const fire = (payload) => act(() => { handlers.get('importer:progress')?.(payload); });
// Simulate a socket (re)connect — the hook re-requests a snapshot replay.
const fireConnect = () => act(() => { handlers.get('connect')?.(); });

describe('useImporterProgress', () => {
  beforeEach(() => { handlers.clear(); emitted.length = 0; });
  afterEach(cleanup);

  it('starts with null stages', () => {
    const { result } = renderHook(() => useImporterProgress());
    expect(result.current.stages).toBeNull();
  });

  it('seeds the checklist from a start frame as all-pending', () => {
    const { result } = renderHook(() => useImporterProgress());
    fire({ type: 'start', runId: 'r1', stages: [{ id: 'canon', label: 'Canon' }, { id: 'arc', label: 'Arc' }] });
    expect(result.current.stages).toEqual([
      { id: 'canon', label: 'Canon', status: 'pending' },
      { id: 'arc', label: 'Arc', status: 'pending' },
    ]);
  });

  it('applies a matching-runId stage frame to the named stage only', () => {
    const { result } = renderHook(() => useImporterProgress());
    fire({ type: 'start', runId: 'r1', stages: [{ id: 'canon', label: 'Canon' }, { id: 'arc', label: 'Arc' }] });
    fire({ type: 'stage', runId: 'r1', id: 'canon', status: 'running' });
    expect(result.current.stages).toEqual([
      { id: 'canon', label: 'Canon', status: 'running' },
      { id: 'arc', label: 'Arc', status: 'pending' },
    ]);
  });

  it('ignores stage frames from a stale run', () => {
    const { result } = renderHook(() => useImporterProgress());
    fire({ type: 'start', runId: 'r2', stages: [{ id: 'canon', label: 'Canon' }] });
    fire({ type: 'stage', runId: 'r1', id: 'canon', status: 'done' });
    expect(result.current.stages).toEqual([{ id: 'canon', label: 'Canon', status: 'pending' }]);
  });

  it('reset() clears the checklist and the active run, so a stale stage frame is ignored after', () => {
    const { result } = renderHook(() => useImporterProgress());
    fire({ type: 'start', runId: 'r1', stages: [{ id: 'canon', label: 'Canon' }] });
    act(() => result.current.reset());
    expect(result.current.stages).toBeNull();
    // A straggler `stage` from the reset run no longer matches any active run.
    fire({ type: 'stage', runId: 'r1', id: 'canon', status: 'done' });
    expect(result.current.stages).toBeNull();
  });

  it('rebuilds the checklist from a replayed snapshot (mid-analyze reconnect)', () => {
    // A socket that (re)connects mid-analyze gets the server's snapshot
    // replayed as a `start` frame followed by the stage statuses seen so far
    // (see importerEvents.getImporterProgressFrames + socket.js). The hook
    // seeds runId from the replayed `start`, so the trailing `stage` frames now
    // match and the checklist is fully restored — labels + per-stage status —
    // instead of staying stuck on "Starting…".
    const { result } = renderHook(() => useImporterProgress());
    const stages = [
      { id: 'canon', label: 'Canon' },
      { id: 'arc', label: 'Arc' },
      { id: 'issues', label: 'Issues' },
    ];
    fire({ type: 'start', runId: 'r9', stages });
    fire({ type: 'stage', runId: 'r9', id: 'canon', status: 'done' });
    fire({ type: 'stage', runId: 'r9', id: 'arc', status: 'running' });
    expect(result.current.stages).toEqual([
      { id: 'canon', label: 'Canon', status: 'done' },
      { id: 'arc', label: 'Arc', status: 'running' },
      { id: 'issues', label: 'Issues', status: 'pending' },
    ]);
  });

  it('requests a snapshot replay on mount and on every reconnect', () => {
    // The replay must be hook-driven: the socket auto-connects at app load,
    // before this lazily-mounted hook registers its listener, so the hook asks
    // the server to replay AFTER `on()` — and again on each `connect` so a
    // reconnect mid-analyze re-fetches the snapshot.
    renderHook(() => useImporterProgress());
    expect(emitted).toEqual([['importer:progress:replay']]);
    fireConnect();
    expect(emitted).toEqual([['importer:progress:replay'], ['importer:progress:replay']]);
  });

  it('ignores malformed frames', () => {
    const { result } = renderHook(() => useImporterProgress());
    fire(null);
    fire('nope');
    expect(result.current.stages).toBeNull();
  });
});

describe('stageStatusIcon', () => {
  it('maps each known status to its icon', () => {
    expect(stageStatusIcon('done').Icon).toBe(CheckCircle2);
    expect(stageStatusIcon('error').Icon).toBe(AlertTriangle);
    expect(stageStatusIcon('running').Icon).toBe(Loader2);
    expect(stageStatusIcon('pending').Icon).toBe(Circle);
  });

  it('falls back to the pending row for an unknown status', () => {
    expect(stageStatusIcon('whatever')).toBe(stageStatusIcon('pending'));
  });
});
