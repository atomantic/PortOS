import { describe, expect, it, vi } from 'vitest';
import { encodePcm16Wav } from './lyricAlignCore.js';
import { verifyLyricSheet, verifyPrerequisites } from './lyricVerify.js';

function vocal() {
  const wav = encodePcm16Wav(16000 * 9);
  for (const [start, end] of [[1, 2], [3, 4], [5, 6], [7, 7.3]]) {
    for (let i = start * 16000; i < end * 16000; i++) wav.writeInt16LE(8000, 44 + i * 2);
  }
  return wav;
}
const project = { vocalStemMasterFilename: 'song.wav', lyricCues: [
  { id: 'a', text: 'first', words: [{ w: 'first', startSec: 1, endSec: 2 }] },
  { id: 'b', text: 'second', words: [{ w: 'second', startSec: 3, endSec: 4 }] },
  { id: 'c', text: 'unsung', words: [{ w: 'unsung', startSec: 8, endSec: 8.5 }] },
] };

describe('lyric sheet verification', () => {
  it('requires a current stem and timed words before starting', async () => {
    const deps = { resolveStem: () => '/music/stem.wav', resolveMaster: async () => '/music/song.wav' };
    await expect(verifyPrerequisites({ ...project, vocalStemMasterFilename: 'old.wav', vocalStemFilename: 'stem.wav' }, deps)).rejects.toMatchObject({ code: 'LYRIC_VERIFY_NEEDS_STEM' });
    await expect(verifyPrerequisites({ ...project, vocalStemFilename: 'stem.wav', lyricCues: [] }, deps)).rejects.toMatchObject({ code: 'LYRIC_VERIFY_NEEDS_TIMING' });
    await expect(verifyPrerequisites({ ...project, vocalStemFilename: 'stem.wav' }, deps)).resolves.toBe('/music/stem.wav');
  });
  it('transcribes only uncovered vocal phrases without sheet bias and finds silent lines', async () => {
    const transcribe = vi.fn(async () => [{ text: 'extra', startSec: 5, endSec: 6 }]);
    const release = vi.fn();
    const result = await verifyLyricSheet(project, 'stem', { deps: { decode: async () => vocal(), resolveTranscriber: async () => ({ transcribe, release }) } });
    expect(result.extraPhrases).toHaveLength(1);
    expect(result.extraPhrases[0]).toMatchObject({ text: 'extra' });
    expect(result.extraPhrases[0].startSec).toBeCloseTo(5, 1);
    expect(result.unsungCues).toEqual([{ cueId: 'c', text: 'unsung' }]);
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe.mock.calls[0][1]).toMatchObject({ prompt: '', startSec: expect.closeTo(4.8, 1), endSec: expect.closeTo(6.2, 1) });
    expect(release).toHaveBeenCalledOnce();
  });
  it('releases the transcriber after cancellation during transcription', async () => {
    let canceled = false;
    const release = vi.fn();
    await expect(verifyLyricSheet(project, 'stem', { isCancelled: () => canceled, deps: { decode: async () => vocal(), resolveTranscriber: async () => ({ transcribe: async () => { canceled = true; return []; }, release }) } })).rejects.toMatchObject({ canceled: true });
    expect(release).toHaveBeenCalledOnce();
  });
});
