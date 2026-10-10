import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map();
vi.mock('./projects.js', () => ({ getProject: vi.fn(async (id) => store.get(id) || null) }));

const { autoPrepareSong } = await import('./songAutoPrepare.js');

const words = [{ text: 'hi', startSec: 1, endSec: 1.4 }];
let analyze;
let align;
const put = (project) => store.set(project.id, { id: 'p', trackId: 't', lyricCues: [{ id: 'c', text: 'hi' }], ...project });

beforeEach(() => {
  store.clear();
  analyze = vi.fn(async (id) => ({ ...store.get(id), audioAnalysis: { durationSec: 30 } }));
  align = vi.fn(async () => ({ jobId: 'job-1' }));
});

describe('automatic song preparation', () => {
  it('analyzes a new song, then aligns its never-aligned lyrics on the isolated vocal', async () => {
    put({ id: 'p' });
    const result = await autoPrepareSong('p', { analyze, align });
    expect(analyze).toHaveBeenCalledWith('p');
    expect(align).toHaveBeenCalledWith('p', { separateVocals: true });
    expect(result).toMatchObject({ analyzed: true, alignJobId: 'job-1', project: { audioAnalysis: { durationSec: 30 } } });
  });

  it('only aligns when the song is already analyzed, and leaves aligned words alone', async () => {
    put({ id: 'p', audioAnalysis: { durationSec: 30 } });
    expect(await autoPrepareSong('p', { analyze, align })).toMatchObject({ analyzed: false, alignJobId: 'job-1' });
    expect(analyze).not.toHaveBeenCalled();
    put({ id: 'p', audioAnalysis: { durationSec: 30 }, lyricCues: [{ id: 'c', text: 'hi', words }, { id: 'd', text: 'added later' }] });
    expect(await autoPrepareSong('p', { analyze, align })).toMatchObject({ alignJobId: null });
    expect(align).toHaveBeenCalledTimes(1);
  });

  it('does nothing without audio, for an instrumental, or while an autonomous run drives the project', async () => {
    put({ id: 'p', trackId: null });
    expect(await autoPrepareSong('p', { analyze, align })).toMatchObject({ analyzed: false, alignJobId: null });
    put({ id: 'p', productionReview: { draft: { lyricsMode: 'instrumental' } } });
    expect(await autoPrepareSong('p', { analyze, align })).toMatchObject({ analyzed: true, alignJobId: null });
    put({ id: 'p', autonomousRun: { status: 'running' } });
    expect(await autoPrepareSong('p', { analyze, align })).toMatchObject({ analyzed: false, alignJobId: null });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(align).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing project', async () => {
    await expect(autoPrepareSong('nope', { analyze, align })).rejects.toMatchObject({ status: 404 });
  });
});
