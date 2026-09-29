import { describe, it, expect, vi } from 'vitest';
import { ServerError } from '../../lib/errorHandler.js';
import { alignProjectLyrics } from './lyricAlign.js';
import {
  alignDirectorWords,
  encodePcm16Wav,
  explainSttFailure,
  lyricAlignChunkSec,
  lyricAlignFfmpegArgs,
  mergeChunkWords,
  pickAlignmentPath,
  planAudioChunks,
  sliceWav,
  wavDurationSec,
} from './lyricAlignCore.js';
import { STT_TIMEOUT_MS } from '../voice/stt.js';

const round3 = (n) => Math.round(n * 1000) / 1000;

function groundWords(count, origin = 0.2) {
  return Array.from({ length: count }, (_, i) => {
    const startSec = round3(origin + i * 0.5);
    return { w: `w${i}`, startSec, endSec: round3(startSec + 0.4) };
  });
}

function within80(word, truth) {
  return Math.abs(word.startSec - truth.startSec) <= 0.08 && Math.abs(word.endSec - truth.endSec) <= 0.08;
}

describe('alignDirectorWords', () => {
  it('places at least 90% of a synthetic phrase within 80ms and flags the interpolated word', () => {
    const ground = groundWords(20);
    const duration = 12;
    const dropped = 'w7';
    const chunks = planAudioChunks(duration, { chunkSec: 8, overlapSec: 2 });
    expect(chunks.length).toBeGreaterThan(1);
    const recognized = mergeChunkWords(chunks.map((chunk) => ({
      ...chunk,
      words: ground
        .filter((word) => word.w !== dropped)
        .filter((word) => {
          const mid = (word.startSec + word.endSec) / 2;
          return mid >= chunk.startSec && mid < chunk.endSec;
        })
        .map((word) => ({
          text: word.w,
          startSec: word.startSec - chunk.startSec,
          endSec: word.endSec - chunk.startSec,
        })),
    })));
    const [aligned] = alignDirectorWords(
      [{ id: 'lc-1', text: ground.map((word) => word.w).join(' '), startSec: null, endSec: null }],
      recognized,
    );
    const hits = aligned.words.filter((word, index) => within80(word, ground[index]));
    expect(hits.length / aligned.words.length).toBeGreaterThanOrEqual(0.9);
    expect(aligned.words).toHaveLength(ground.length);
    expect(aligned.words.find((word) => word.w === dropped).conf).toBe('interpolated');
    expect(aligned.words.filter((word) => word.w !== dropped).every((word) => word.conf === 'matched')).toBe(true);
    // The line had no director times, so the cue takes its first and last word.
    expect(aligned.startSec).toBe(aligned.words[0].startSec);
    expect(aligned.endSec).toBe(aligned.words.at(-1).endSec);
  });

  it('keeps a skipped line inside its window and leaves the sung lines on the vocal', () => {
    const cues = [
      { id: 'a', text: 'walking home', startSec: 0.4, endSec: 1.6 },
      { id: 'b', text: 'not sung here', startSec: 3, endSec: 4 },
      { id: 'c', text: 'under neon', startSec: 5, endSec: 6.2 },
    ];
    const aligned = alignDirectorWords(cues, [
      { text: 'walking', startSec: 0.5, endSec: 1 },
      { text: 'home', startSec: 1, endSec: 1.5 },
      { text: 'under', startSec: 5.1, endSec: 5.4 },
      { text: 'neon', startSec: 5.4, endSec: 5.9 },
    ]);
    expect(aligned[1].words.every((word) => word.conf === 'interpolated')).toBe(true);
    expect(aligned[1].words.every((word) => word.startSec >= 3 && word.endSec <= 4)).toBe(true);
    expect(aligned[0].words.map((word) => [word.startSec, word.conf])).toEqual([
      [0.5, 'matched'],
      [1, 'matched'],
    ]);
    expect(aligned[2].words[0]).toMatchObject({ w: 'under', startSec: 5.1, conf: 'matched' });
    // Director-set line times stay put.
    expect(aligned[0].startSec).toBe(0.4);
    expect(aligned[2].endSec).toBe(6.2);
  });

  it('matches a repeated chorus to its own occurrence', () => {
    const aligned = alignDirectorWords([
      { id: 'a', text: 'we go', startSec: null, endSec: null },
      { id: 'b', text: 'we go', startSec: null, endSec: null },
    ], [
      { text: 'we', startSec: 1, endSec: 1.2 },
      { text: 'go', startSec: 1.2, endSec: 1.5 },
      { text: 'we', startSec: 8, endSec: 8.2 },
      { text: 'go', startSec: 8.2, endSec: 8.6 },
    ]);
    expect(aligned[0].words.map((word) => word.startSec)).toEqual([1, 1.2]);
    expect(aligned[1].words.map((word) => word.startSec)).toEqual([8, 8.2]);
  });

  it('divides an unmatched run between its matched neighbours by character count', () => {
    const [aligned] = alignDirectorWords(
      [{ id: 'a', text: 'hi ab abcd yo', startSec: null, endSec: null }],
      [
        { text: 'hi', startSec: 0, endSec: 1 },
        { text: 'yo', startSec: 7, endSec: 8 },
      ],
    );
    expect(aligned.words[1]).toMatchObject({ w: 'ab', startSec: 1, endSec: 3, conf: 'interpolated' });
    expect(aligned.words[2]).toMatchObject({ w: 'abcd', startSec: 3, endSec: 7, conf: 'interpolated' });
    expect(aligned.words[0].startSec).toBe(0);
    expect(aligned.words[3].startSec).toBe(7);
  });

  it('fills only the cue times the director left empty', () => {
    const [aligned] = alignDirectorWords(
      [{ id: 'a', text: 'walking home', startSec: 1, endSec: null }],
      [
        { text: 'walking', startSec: 1.2, endSec: 1.5 },
        { text: 'home', startSec: 1.5, endSec: 1.9 },
      ],
    );
    expect(aligned.startSec).toBe(1);
    expect(aligned.endSec).toBe(1.9);
  });
});

describe('lyric alignment audio', () => {
  it('decodes to 16 kHz mono PCM and slices a window without shifting the clock', () => {
    expect(lyricAlignFfmpegArgs('/songs/mix.wav', '/tmp/vocal.wav')).toEqual([
      '-v', 'error', '-i', '/songs/mix.wav', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', '/tmp/vocal.wav',
    ]);
    expect(lyricAlignChunkSec(STT_TIMEOUT_MS)).toBeLessThanOrEqual(STT_TIMEOUT_MS / 1000 - 8);
    const wav = encodePcm16Wav(16000 * 4);
    expect(wavDurationSec(wav)).toBeCloseTo(4, 3);
    expect(wavDurationSec(sliceWav(wav, 1, 2.5))).toBeCloseTo(1.5, 3);
    const truncated = encodePcm16Wav(16000);
    truncated.writeUInt32LE(999999, 40);
    expect(wavDurationSec(sliceWav(truncated, 0, 2))).toBeCloseTo(1, 3);
    const stereo = encodePcm16Wav(100);
    stereo.writeUInt16LE(4, 32);
    expect(() => sliceWav(stereo, 0, 0.01)).toThrow(/16-bit mono/);
  });

  it('uses the vocal stem when one is attached, and does not fall back when that file is missing', async () => {
    const resolveMaster = vi.fn(async () => '/library/mix.wav');
    await expect(pickAlignmentPath({ vocalStemFilename: 'v.wav' }, {
      resolveStem: () => '/library/v.wav',
      resolveMaster,
    })).resolves.toEqual({ path: '/library/v.wav', source: 'vocal-stem' });
    expect(resolveMaster).not.toHaveBeenCalled();

    await expect(pickAlignmentPath({}, {
      resolveStem: () => null,
      resolveMaster,
    })).resolves.toEqual({ path: '/library/mix.wav', source: 'master' });

    const missing = new ServerError('missing', { status: 404, code: 'MUSIC_VIDEO_VOCAL_STEM_MISSING' });
    await expect(pickAlignmentPath({ vocalStemFilename: 'gone.wav' }, {
      resolveStem: () => { throw missing; },
      resolveMaster,
    })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_VOCAL_STEM_MISSING' });
  });
});

describe('alignProjectLyrics', () => {
  const project = {
    id: 'mv-1',
    trackId: 't1',
    lyricCues: [
      { id: 'lc-1', text: 'walking home', startSec: 1, endSec: null },
      { id: 'lc-2', text: 'not sung here', startSec: 2, endSec: 2.8 },
    ],
  };

  function harness(transcribe, record = project) {
    const updateProject = vi.fn(async (id, patch) => ({ id, ...record, ...patch }));
    const decodeAudio = vi.fn(async () => encodePcm16Wav(16000 * 3));
    const getProject = vi.fn(async () => record);
    return {
      updateProject,
      decodeAudio,
      transcribe,
      run: (opts = {}) => alignProjectLyrics(record.id, {
        ...opts,
        deps: {
          getProject,
          updateProject,
          resolveAudio: async () => ({ path: 'song.wav', source: 'master' }),
          decodeAudio,
          transcribe,
        },
      }),
    };
  }

  it('writes matched and interpolated words, and does not replace a time the director set', async () => {
    const transcribe = vi.fn(async () => ({
      text: 'walking home',
      words: [
        { text: 'walking', startSec: 0.5, endSec: 1 },
        { text: 'home', startSec: 1, endSec: 1.5 },
      ],
      latencyMs: 4,
    }));
    const { run, updateProject } = harness(transcribe);
    const saved = await run();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ verbose: true }));
    expect(saved.lyricCues[0]).toMatchObject({
      startSec: 1,
      endSec: 1.5,
      words: [
        { w: 'walking', startSec: 0.5, endSec: 1, conf: 'matched' },
        { w: 'home', startSec: 1, endSec: 1.5, conf: 'matched' },
      ],
    });
    expect(saved.lyricCues[1].words.every((word) => word.conf === 'interpolated')).toBe(true);
    expect(saved.lyricCues[1].words.every((word) => word.startSec >= 2 && word.endSec <= 2.8)).toBe(true);
    expect(updateProject).toHaveBeenCalledOnce();
  });

  it('re-aligns one windowed line without moving the other line', async () => {
    const record = {
      ...project,
      lyricCues: [
        {
          id: 'lc-1', text: 'walking home', startSec: 0.5, endSec: 1.5,
          words: [
            { w: 'walking', startSec: 0.5, endSec: 1, conf: 'matched' },
            { w: 'home', startSec: 1, endSec: 1.5, conf: 'matched' },
          ],
        },
        { id: 'lc-2', text: 'not sung here', startSec: 2, endSec: 2.8 },
      ],
    };
    const transcribe = vi.fn(async () => ({ text: '', words: [], latencyMs: 1 }));
    const saved = await harness(transcribe, record).run({ cueId: 'lc-2' });
    expect(saved.lyricCues[0].words).toEqual(record.lyricCues[0].words);
    expect(saved.lyricCues[1].words.every((word) => word.conf === 'interpolated')).toBe(true);
    expect(saved.lyricCues[1].words.every((word) => word.startSec >= 2 && word.endSec <= 2.8)).toBe(true);
  });

  it('reports an unreachable speech-to-text server instead of saving empty timings', async () => {
    const transcribe = vi.fn(async () => { throw new Error('fetch failed'); });
    const { run, updateProject } = harness(transcribe);
    await expect(run()).rejects.toMatchObject({
      status: 503,
      code: 'LYRIC_ALIGN_STT_UNAVAILABLE',
      message: expect.stringMatching(/Settings → Voice/),
    });
    expect(updateProject).not.toHaveBeenCalled();
    expect(explainSttFailure(new Error('fetch failed'))).toMatch(/not running/);
  });

  it('does not transcribe when the project has no lyric lines', async () => {
    const transcribe = vi.fn();
    const { run, decodeAudio } = harness(transcribe, { ...project, lyricCues: [] });
    await expect(run()).rejects.toMatchObject({ code: 'NO_LYRICS' });
    expect(transcribe).not.toHaveBeenCalled();
    expect(decodeAudio).not.toHaveBeenCalled();
  });
});
