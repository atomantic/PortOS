import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordImporterFrame,
  getImporterProgressFrames,
  emitImporterProgress,
  importerEvents,
} from './importerEvents.js';

// Reset the module-level snapshot before each test by recording a terminal
// frame for whatever run might be live (a `done` with a matching runId clears
// it). The cleanest reset that doesn't depend on internals: record a fresh
// start then a done.
beforeEach(() => {
  recordImporterFrame({ type: 'start', runId: '__reset__', stages: [] });
  recordImporterFrame({ type: 'done', runId: '__reset__' });
});

describe('importerEvents snapshot', () => {
  it('returns no frames when no run is active', () => {
    expect(getImporterProgressFrames()).toEqual([]);
  });

  it('replays the start frame (labels + ordering) for a fresh subscriber', () => {
    const stages = [{ id: 'canon', label: 'Canon' }, { id: 'arc', label: 'Arc' }];
    recordImporterFrame({ type: 'start', runId: 'r1', stages });
    expect(getImporterProgressFrames()).toEqual([
      { type: 'start', runId: 'r1', stages },
    ]);
  });

  it('replays start + one stage frame per status update seen so far', () => {
    const stages = [{ id: 'canon', label: 'Canon' }, { id: 'arc', label: 'Arc' }, { id: 'issues', label: 'Issues' }];
    recordImporterFrame({ type: 'start', runId: 'r1', stages });
    recordImporterFrame({ type: 'stage', runId: 'r1', id: 'canon', status: 'running' });
    recordImporterFrame({ type: 'stage', runId: 'r1', id: 'arc', status: 'running' });
    recordImporterFrame({ type: 'stage', runId: 'r1', id: 'canon', status: 'done' });
    expect(getImporterProgressFrames()).toEqual([
      { type: 'start', runId: 'r1', stages },
      // canon collapses to its latest status (done), arc stays running.
      { type: 'stage', runId: 'r1', id: 'canon', status: 'done' },
      { type: 'stage', runId: 'r1', id: 'arc', status: 'running' },
    ]);
  });

  it('ignores stage frames from a run other than the active one', () => {
    recordImporterFrame({ type: 'start', runId: 'r2', stages: [{ id: 'canon', label: 'Canon' }] });
    recordImporterFrame({ type: 'stage', runId: 'r1', id: 'canon', status: 'done' });
    expect(getImporterProgressFrames()).toEqual([
      { type: 'start', runId: 'r2', stages: [{ id: 'canon', label: 'Canon' }] },
    ]);
  });

  it('a new start frame replaces the prior run snapshot', () => {
    recordImporterFrame({ type: 'start', runId: 'r1', stages: [{ id: 'canon', label: 'Canon' }] });
    recordImporterFrame({ type: 'stage', runId: 'r1', id: 'canon', status: 'done' });
    recordImporterFrame({ type: 'start', runId: 'r2', stages: [{ id: 'arc', label: 'Arc' }] });
    expect(getImporterProgressFrames()).toEqual([
      { type: 'start', runId: 'r2', stages: [{ id: 'arc', label: 'Arc' }] },
    ]);
  });

  it('a terminal done frame clears the snapshot (no replay to later tabs)', () => {
    recordImporterFrame({ type: 'start', runId: 'r1', stages: [{ id: 'canon', label: 'Canon' }] });
    recordImporterFrame({ type: 'stage', runId: 'r1', id: 'canon', status: 'done' });
    recordImporterFrame({ type: 'done', runId: 'r1' });
    expect(getImporterProgressFrames()).toEqual([]);
  });

  it('ignores malformed frames', () => {
    expect(() => recordImporterFrame(null)).not.toThrow();
    expect(() => recordImporterFrame('nope')).not.toThrow();
    expect(getImporterProgressFrames()).toEqual([]);
  });

  it('emitImporterProgress both records the snapshot and broadcasts the frame', () => {
    const seen = [];
    const listener = (f) => seen.push(f);
    importerEvents.on('progress', listener);
    const startFrame = { type: 'start', runId: 'r1', stages: [{ id: 'canon', label: 'Canon' }] };
    emitImporterProgress(startFrame);
    importerEvents.off('progress', listener);
    // Broadcast happened…
    expect(seen).toEqual([startFrame]);
    // …and the snapshot was updated in the same call.
    expect(getImporterProgressFrames()).toEqual([startFrame]);
  });
});
