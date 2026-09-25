import { describe, it, expect, vi } from 'vitest';

// In-memory backend whose reads and writes yield, so two appends interleave
// exactly the way two renders finishing together would.
const store = vi.hoisted(() => ({ track: null }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
vi.mock('./file.js', () => ({
  getTrack: async () => { await tick(); return store.track && structuredClone(store.track); },
  updateTrack: async (id, patch) => { await tick(); store.track = { ...store.track, ...patch }; return structuredClone(store.track); },
}));
vi.mock('../sharing/recordEvents.js', () => ({
  emitRecordUpdated: () => {},
  autoSubscribeRecordToAllPeers: async () => {},
}));

const { appendActiveTake } = await import('./index.js');

describe('appendActiveTake', () => {
  it('keeps both takes when two renders of one track finish together', async () => {
    store.track = { id: 'track-1', renders: [] };
    await Promise.all([
      appendActiveTake('track-1', { audioFilename: 'a.wav', engine: 'waveform', prompt: 'a', durationSec: 2 }),
      appendActiveTake('track-1', { audioFilename: 'b.wav', engine: 'chiptune', prompt: 'b', durationSec: 3 }),
    ]);
    expect(store.track.renders.map((r) => r.audioFilename)).toEqual(['a.wav', 'b.wav']);
    expect(store.track).toMatchObject({ audioFilename: 'b.wav', engine: 'chiptune', modelId: '', durationSec: 3 });
  });

  it('resolves null for a missing track', async () => {
    store.track = null;
    await expect(appendActiveTake('gone', { audioFilename: 'a.wav', engine: 'waveform', durationSec: 1 })).resolves.toBeNull();
  });
});
