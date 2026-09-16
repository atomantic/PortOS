import { describe, expect, it } from 'vitest';
import { describeActivityBlockers, summarizeSystemActivity } from './systemIdle.js';

const snapshot = (overrides = {}) => ({
  jobs: [],
  extras: { imageTo3d: [] },
  agents: { active: 0, queued: 0 },
  mind: { trusted: true, thinking: false, queued: 0, status: 'idle' },
  appOperations: [],
  update: { inProgress: false },
  ...overrides,
});

describe('system idle verdict', () => {
  it('reports idle only when nothing is running or queued anywhere', () => {
    expect(summarizeSystemActivity(snapshot())).toMatchObject({ idle: true, activeCount: 0, queuedCount: 0, blockers: [] });
  });

  // The whole point of the module: a render waiting at position 3 has a user
  // waiting on it, so restarting the install mid-queue is the same disruption
  // as killing the running one.
  it('treats queued work as activity, not as an idle window', () => {
    const verdict = summarizeSystemActivity(snapshot({
      jobs: [{ id: 'v1', kind: 'video', status: 'queued' }],
    }));
    expect(verdict.idle).toBe(false);
    expect(verdict.queuedCount).toBe(1);
    expect(verdict.blockers).toEqual([{ kind: 'media-queued:video', label: '1 video render queued', count: 1 }]);
  });

  it('names each busy lane separately so the reason is actionable', () => {
    const verdict = summarizeSystemActivity(snapshot({
      jobs: [
        { id: 'i1', kind: 'image', status: 'running' },
        { id: 'i2', kind: 'image', status: 'running' },
        { id: 'a1', kind: 'audio', status: 'queued' },
      ],
      extras: { imageTo3d: [{ id: 'mesh-1' }] },
      agents: { active: 1, queued: 2 },
      mind: { trusted: true, thinking: true, queued: 3 },
      appOperations: [{ appId: 'example', appName: 'Example App', type: 'update' }],
    }));
    expect(verdict.idle).toBe(false);
    expect(verdict.blockers.map(b => b.label)).toEqual([
      '2 image renders running',
      '1 audio render queued',
      '1 image-to-3D build running',
      '1 CoS agent running',
      '2 CoS tasks queued',
      'Persistent Mind is thinking',
      '3 Persistent Mind messages queued',
      '1 app operation running',
    ]);
    expect(verdict.activeCount).toBe(2 + 1 + 1 + 1 + 1);
    expect(verdict.queuedCount).toBe(1 + 2 + 3);
  });

  // An unreadable Persistent Mind state is exactly what the update path itself
  // refuses on (PERSISTENT_MIND_STATE_UNTRUSTED). Reading it as "nothing
  // queued" would march the updater up to a refusal it could have foreseen.
  it('refuses to read an unreadable Persistent Mind state as an idle one', () => {
    const verdict = summarizeSystemActivity(snapshot({ mind: { trusted: false } }));
    expect(verdict.idle).toBe(false);
    expect(verdict.blockers).toEqual([{ kind: 'mind-unreadable', label: 'Persistent Mind state unreadable', count: 1 }]);
  });

  it('counts an update already in flight as activity', () => {
    expect(summarizeSystemActivity(snapshot({ update: { inProgress: true } })).idle).toBe(false);
  });

  // A degraded snapshot (a slice that failed to load) must still produce a
  // usable verdict rather than throwing inside the scheduler's tick.
  it('reads missing slices as absent rather than throwing', () => {
    expect(summarizeSystemActivity({}).idle).toBe(true);
    expect(summarizeSystemActivity(undefined).idle).toBe(true);
  });

  it('describes a blocker list as one line', () => {
    expect(describeActivityBlockers([])).toBe('system idle');
    expect(describeActivityBlockers([{ label: 'a' }, { label: 'b' }])).toBe('a, b');
  });
});
