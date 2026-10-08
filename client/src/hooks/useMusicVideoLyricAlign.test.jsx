import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useMusicVideoLyricAlign, { lyricAlignStageLabel } from './useMusicVideoLyricAlign.js';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';
import { alignMusicVideoLyrics } from '../services/apiMusicVideo.js';

vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('../services/apiMusicVideo.js', () => ({
  alignMusicVideoLyrics: vi.fn(async () => ({ jobId: 'job-1' })),
  musicVideoLyricAlignEventsUrl: (id) => `/events/${id}`,
  cancelMusicVideoLyricAlign: vi.fn(async () => ({ ok: true })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('useMusicVideoLyricAlign', () => {
  it('shows stage progress and resolves run() with the project on completion', async () => {
    const onAligned = vi.fn();
    const { result } = renderHook(() => useMusicVideoLyricAlign({ onAligned }));
    let outcome;
    await act(async () => { outcome = result.current.run('p-1'); });
    expect(alignMusicVideoLyrics).toHaveBeenCalledWith('p-1', {}, { silent: true });
    expect(result.current.context).toEqual({ projectId: 'p-1', cueId: null });
    act(() => { lastEventSource().emit({ type: 'progress', stage: 'transcribing', current: 2, total: 5, percent: 20 }); });
    expect(result.current.stageLabel).toBe('Transcribing phrase 2 of 5…');
    expect(result.current.percent).toBe(20);
    act(() => { lastEventSource().emit({ type: 'complete', project: { id: 'p-1', lyricCues: [] } }); });
    await expect(outcome).resolves.toEqual({ id: 'p-1', lyricCues: [] });
    expect(onAligned).toHaveBeenCalledWith('p-1', { id: 'p-1', lyricCues: [] });
  });

  it('rejects run() with the server message so the panel can show it', async () => {
    const { result } = renderHook(() => useMusicVideoLyricAlign());
    let outcome;
    await act(async () => { outcome = result.current.run('p-1', 'lc-1', { separateVocals: true }); });
    expect(alignMusicVideoLyrics).toHaveBeenCalledWith('p-1', { cueId: 'lc-1', separateVocals: true }, { silent: true });
    const failed = expect(outcome).rejects.toThrow('whisper missing');
    act(() => { lastEventSource().emit({ type: 'error', error: 'whisper missing' }); });
    await failed;
  });

  it('attach adopts a job a reload left running', async () => {
    const { result } = renderHook(() => useMusicVideoLyricAlign());
    act(() => { expect(result.current.attach('job-9', 'p-1')).toBe(true); });
    expect(lastEventSource().url).toBe('/events/job-9');
    expect(result.current.active).toBe(true);
  });

  it('labels the first-run model download', () => {
    expect(lyricAlignStageLabel({ stage: 'downloading-model', percent: 40 })).toMatch(/Downloading the speech model/);
  });
});
