import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useYoutubeTrackImport from './useYoutubeTrackImport.js';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';
import toast from '../components/ui/Toast';

vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('../services/apiTracks.js', () => ({
  importTrackFromYoutube: vi.fn(async () => ({ jobId: 'yt-1' })),
  importTrackFromSuno: vi.fn(async () => ({ jobId: 'suno-1' })),
  cancelTrackImport: vi.fn(),
  trackImportEventsUrl: (id) => `/events/${id}`,
}));

const ID = '11111111-2222-4333-8444-555555555555';
const track = { id: 'track-kept', title: 'Airplane Mode' };

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function finish(frame) {
  const onComplete = vi.fn();
  const { result } = renderHook(() => useYoutubeTrackImport({ onComplete }));
  await act(async () => { result.current.start(`https://suno.com/song/${ID}`); });
  await act(async () => { lastEventSource().emit(frame); });
  return onComplete;
}

describe('useYoutubeTrackImport Suno reuse', () => {
  it('says the song is already in the library and still hands the track over', async () => {
    const onComplete = await finish({ type: 'complete', track, source: 'suno', reused: true });
    expect(onComplete).toHaveBeenCalledWith(track, `https://suno.com/song/${ID}`);
    expect(toast.success).toHaveBeenCalledWith('Already in your library');
  });

  it('keeps the imported toast when the song is new', async () => {
    await finish({ type: 'complete', track, source: 'suno' });
    expect(toast.success).toHaveBeenCalledWith('Imported "Airplane Mode" from Suno');
  });
});
