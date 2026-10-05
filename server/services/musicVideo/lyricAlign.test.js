import { describe, it, expect, vi } from 'vitest';
import { ServerError } from '../../lib/errorHandler.js';
import { alignProjectLyrics } from './lyricAlign.js';
import {
  alignDirectorWords,
  encodePcm16Wav,
  lyricAlignChunkSec,
  lyricAlignFfmpegArgs,
  mergeChunkWords,
  mergeTranscripts,
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

  it('does not let a word the recognizer missed latch onto the same word a verse later', () => {
    // "the" in line one was not heard. A next-equal-word matcher would take the
    // "the" of line three for it and strand line two between them.
    const aligned = alignDirectorWords([
      { id: 'a', text: 'into the night', startSec: null, endSec: null },
      { id: 'b', text: 'running far away', startSec: null, endSec: null },
      { id: 'c', text: 'under the moon', startSec: null, endSec: null },
    ], [
      { text: 'into', startSec: 1, endSec: 1.3 },
      { text: 'night', startSec: 1.6, endSec: 2 },
      { text: 'running', startSec: 3, endSec: 3.4 },
      { text: 'far', startSec: 3.4, endSec: 3.7 },
      { text: 'away', startSec: 3.7, endSec: 4.2 },
      { text: 'under', startSec: 6, endSec: 6.3 },
      { text: 'the', startSec: 6.3, endSec: 6.4 },
      { text: 'moon', startSec: 6.4, endSec: 7 },
    ]);
    expect(aligned[0].words.map((word) => word.conf)).toEqual(['matched', 'interpolated', 'matched']);
    expect(aligned[0].words[1].startSec).toBeGreaterThanOrEqual(1.3);
    expect(aligned[0].words[1].endSec).toBeLessThanOrEqual(1.6);
    expect(aligned[1]).toMatchObject({ startSec: 3, endSec: 4.2 });
    expect(aligned[1].words.every((word) => word.conf === 'matched')).toBe(true);
    expect(aligned[2].words[1]).toMatchObject({ w: 'the', startSec: 6.3, conf: 'matched' });
  });

  it('matches a curly-apostrophe sheet word to the recognizer\'s straight one', () => {
    const [aligned] = alignDirectorWords(
      [{ id: 'a', text: 'I’m gonna stay', startSec: null, endSec: null }],
      [
        { text: "I'm", startSec: 1, endSec: 1.2 },
        { text: 'gona', startSec: 1.2, endSec: 1.5 },
        { text: 'stay', startSec: 1.5, endSec: 2 },
      ],
    );
    expect(aligned.words.map((word) => [word.w, word.conf])).toEqual([
      ['I’m', 'matched'], ['gonna', 'matched'], ['stay', 'matched'],
    ]);
  });

  it('gives a one-word line the recognizer timed as an instant a playable span', () => {
    const aligned = alignDirectorWords([
      { id: 'a', text: 'Hush.', startSec: null, endSec: null },
      { id: 'b', text: 'can you feel', startSec: null, endSec: null },
    ], [
      { text: 'Hush.', startSec: 20.5, endSec: 20.5 },
      { text: 'can', startSec: 21, endSec: 21.2 },
      { text: 'you', startSec: 21.2, endSec: 21.4 },
      { text: 'feel', startSec: 21.4, endSec: 21.8 },
    ]);
    expect(aligned[0]).toMatchObject({ startSec: 20.5, endSec: 20.75 });
    expect(aligned[0].words[0]).toMatchObject({ w: 'Hush.', conf: 'matched' });
    expect(aligned[1]).toMatchObject({ startSec: 21, endSec: 21.8 });
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

  it('uses the vocal stem with the mix beside it, and does not fall back when the stem file is missing', async () => {
    const resolveMaster = vi.fn(async () => '/library/mix.wav');
    await expect(pickAlignmentPath({ vocalStemFilename: 'v.wav' }, {
      resolveStem: () => '/library/v.wav',
      resolveMaster,
    })).resolves.toEqual({ path: '/library/v.wav', source: 'vocal-stem', mixPath: '/library/mix.wav' });

    await expect(pickAlignmentPath({}, {
      resolveStem: () => null,
      resolveMaster,
    })).resolves.toEqual({ path: '/library/mix.wav', source: 'master', mixPath: null });

    const missing = new ServerError('missing', { status: 404, code: 'MUSIC_VIDEO_VOCAL_STEM_MISSING' });
    await expect(pickAlignmentPath({ vocalStemFilename: 'gone.wav' }, {
      resolveStem: () => { throw missing; },
      resolveMaster,
    })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_VOCAL_STEM_MISSING' });
  });
});

describe('mergeTranscripts', () => {
  const words = (list) => list.map(([text, startSec]) => ({ text, startSec, endSec: startSec + 0.3 }));

  it('keeps the stem where it is clean and takes the mix only where the stem loops', () => {
    const stem = words([
      ['hold', 1], ['me', 1.4], ['close', 1.8],
      ['Na-na-na-na-na-na', 4],
      ['no', 9], ['no', 9.4], ['no', 9.8], ['no', 10.2], ['no', 10.6], ['no', 11],
    ]);
    // The mix mishears the clean stretch, and stretches words across the loop too.
    const mix = words([
      ['old', 1], ['me', 1.4], ['clothes', 1.8],
      ['tonight', 4.1],
      ['never', 9], ['let', 9.4], ['me', 9.8], ['go', 10.2],
    ]);
    const merged = mergeTranscripts(stem, mix, 'hold me close tonight\nnever let me go');
    expect(merged.map((word) => word.text)).toEqual(['hold', 'me', 'close', 'tonight', 'never', 'let', 'me', 'go']);
  });

  it('keeps a repeat the lyrics really sing, and drops a looped run with nothing to replace it', () => {
    const sung = words([['hey', 1], ['hey', 1.4], ['hey', 1.8], ['hey', 2.2]]);
    expect(mergeTranscripts(sung, [], 'hey hey hey hey')).toHaveLength(4);
    expect(mergeTranscripts(sung, [], 'hey there')).toHaveLength(0);
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

  function harness(transcribe, record = project, { resolveAudio } = {}) {
    const updateProject = vi.fn(async (id, patch) => ({ id, ...record, ...patch }));
    const decodeAudio = vi.fn(async () => encodePcm16Wav(16000 * 3));
    const getProject = vi.fn(async () => record);
    const release = vi.fn(async () => {});
    return {
      updateProject,
      decodeAudio,
      transcribe,
      release,
      run: (opts = {}) => alignProjectLyrics(record.id, {
        ...opts,
        deps: {
          getProject,
          updateProject,
          resolveAudio: resolveAudio || (async () => ({ path: 'song.wav', source: 'master', mixPath: null })),
          decodeAudio,
          resolveTranscriber: async () => ({ kind: 'test', transcribe, release }),
        },
      }),
    };
  }

  it('writes matched and interpolated words, and does not replace a time the director set', async () => {
    const transcribe = vi.fn(async () => [
      { text: 'walking', startSec: 0.5, endSec: 1 },
      { text: 'home', startSec: 1, endSec: 1.5 },
    ]);
    const { run, updateProject, release } = harness(transcribe);
    const saved = await run();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ prompt: 'walking home\nnot sung here' }));
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
    expect(release).toHaveBeenCalledOnce();
  });

  it('reports stages and stops without saving when cancelled mid-run (#10155)', async () => {
    const stages = [];
    const transcribe = vi.fn(async () => [{ text: 'walking', startSec: 0.5, endSec: 1 }]);
    const done = harness(transcribe);
    await done.run({ onProgress: (frame) => stages.push(frame.stage) });
    expect(stages).toEqual(['decoding', 'loading-model', 'transcribing', 'saving']);

    const stopped = harness(vi.fn(async () => [{ text: 'walking', startSec: 0.5, endSec: 1 }]));
    let cancel = false;
    await expect(stopped.run({
      isCancelled: () => cancel,
      onProgress: (frame) => { if (frame.stage === 'loading-model') cancel = true; },
    })).rejects.toMatchObject({ canceled: true });
    expect(stopped.transcribe).not.toHaveBeenCalled();
    expect(stopped.updateProject).not.toHaveBeenCalled();
    expect(stopped.release).toHaveBeenCalledOnce();
  });

  it('anchors a post-silence line to the stem while transcribing only sequential mix windows', async () => {
    const record = { ...project, lyricCues: [
      { id: 'a', text: 'hello morning', startSec: null, endSec: null },
      { id: 'b', text: 'gently awaken', startSec: null, endSec: null },
      { id: 'c', text: 'absent lyric', startSec: 8, endSec: 9 },
    ] };
    const stem = encodePcm16Wav(16000 * 10);
    for (const [start, end] of [[1, 2], [4, 5]]) {
      for (let i = start * 16000; i < end * 16000; i++) stem.writeInt16LE(5000, 44 + i * 2);
    }
    const mix = encodePcm16Wav(16000 * 10);
    let active = false;
    const transcribe = vi.fn(async (wav, region) => {
      expect(wav).toBe(mix);
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      active = false;
      // Mimic whisper's bias: first word starts at the slice's beginning.
      const text = region.startSec < 2 ? ['hello', 'morning'] : region.startSec < 5 ? ['gently', 'awaken'] : [];
      return text.map((word, i) => ({ text: word, startSec: region.startSec + i * 0.4, endSec: region.startSec + (i + 1) * 0.4 }));
    });
    const h = harness(transcribe, record, {
      resolveAudio: async () => ({ path: 'stem.wav', source: 'vocal-stem', mixPath: 'song.wav' }),
    });
    h.decodeAudio.mockImplementation(async (path) => path === 'stem.wav' ? stem : mix);
    const saved = await h.run();
    expect(h.decodeAudio.mock.calls.map(([path]) => path)).toEqual(['stem.wav', 'song.wav']);
    expect(Math.abs(saved.lyricCues[1].startSec - 4)).toBeLessThanOrEqual(0.06);
    expect(saved.lyricCues[1].matched).toBe(1);
    expect(saved.lyricCues[1].words[0].startSec).toBe(saved.lyricCues[1].startSec);
    expect(saved.lyricCues[2]).toEqual({ ...record.lyricCues[2], matched: 0 });
    expect(transcribe.mock.calls.every(([, window]) => window.endSec - window.startSec <= 11)).toBe(true);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('keeps current director times on a stem re-alignment, including edits made during transcription', async () => {
    const record = { ...project, lyricCues: [{ id: 'a', text: 'walking home', startSec: 1, endSec: 2 }] };
    const transcribe = vi.fn(async () => {
      record.lyricCues = [{ ...record.lyricCues[0], startSec: 1.2, endSec: 2.5 }];
      return [{ text: 'walking', startSec: 1, endSec: 1.5 }, { text: 'home', startSec: 1.5, endSec: 2 }];
    });
    const h = harness(transcribe, record, {
      resolveAudio: async () => ({ path: 'stem.wav', source: 'vocal-stem', mixPath: 'song.wav' }),
    });
    const stem = encodePcm16Wav(16000 * 3);
    for (let i = 16000; i < 32000; i++) stem.writeInt16LE(5000, 44 + i * 2);
    h.decodeAudio.mockResolvedValue(stem);
    const saved = await h.run({ cueId: 'a' });
    expect(saved.lyricCues[0]).toMatchObject({ startSec: 1.2, endSec: 2.5, matched: 1 });
  });

  it('names the analysis sections after the lyric sheet once the lines are timed', async () => {
    const record = {
      ...project,
      lyricCues: [
        { id: 'lc-1', text: 'walking home', startSec: null, endSec: null },
        { id: 'lc-2', text: 'under neon', startSec: null, endSec: null },
      ],
      lyricMarkers: [
        { type: 'section', label: 'Verse 1', kind: 'verse', line: 0 },
        { type: 'section', label: 'Chorus', kind: 'chorus', line: 1 },
      ],
      audioAnalysis: {
        bpm: 120, beats: [], downbeats: [], durationSec: 12,
        sections: [
          { label: 'Section 1', startSec: 0, endSec: 2, energy: 0.2 },
          { label: 'Section 2', startSec: 2, endSec: 5, energy: 0.5 },
          { label: 'Section 3', startSec: 5, endSec: 9, energy: 0.9 },
          { label: 'Section 4', startSec: 9, endSec: 12, energy: 0.3 },
        ],
      },
    };
    const transcribe = vi.fn(async () => [
      { text: 'walking', startSec: 2.2, endSec: 3 }, { text: 'home', startSec: 3, endSec: 4.5 },
      { text: 'under', startSec: 5.1, endSec: 6 }, { text: 'neon', startSec: 6, endSec: 8.8 },
    ]);
    const saved = await harness(transcribe, record).run();
    expect(saved.audioAnalysis.sections.map((section) => [section.label, section.labelSource ?? null])).toEqual([
      ['Intro', 'lyrics'], ['Verse 1', 'lyrics'], ['Chorus', 'lyrics'], ['Outro', 'lyrics'],
    ]);
    expect(saved.audioAnalysis.sections[2]).toMatchObject({ analysisLabel: 'Section 3', startSec: 5, endSec: 9, energy: 0.9 });
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
    const transcribe = vi.fn(async () => []);
    const saved = await harness(transcribe, record).run({ cueId: 'lc-2' });
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ startSec: 2, endSec: 2.8 }));
    expect(saved.lyricCues[0].words).toEqual(record.lyricCues[0].words);
    expect(saved.lyricCues[1].words.every((word) => word.conf === 'interpolated')).toBe(true);
    expect(saved.lyricCues[1].words.every((word) => word.startSec >= 2 && word.endSec <= 2.8)).toBe(true);
  });

  it('stops the runner and saves nothing when transcription fails', async () => {
    const failure = new ServerError('no whisper', { status: 503, code: 'LYRIC_ALIGN_STT_UNAVAILABLE' });
    const transcribe = vi.fn(async () => { throw failure; });
    const { run, updateProject, release } = harness(transcribe);
    await expect(run()).rejects.toBe(failure);
    expect(updateProject).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not transcribe when the project has no lyric lines', async () => {
    const transcribe = vi.fn();
    const { run, decodeAudio } = harness(transcribe, { ...project, lyricCues: [] });
    await expect(run()).rejects.toMatchObject({ code: 'NO_LYRICS' });
    expect(transcribe).not.toHaveBeenCalled();
    expect(decodeAudio).not.toHaveBeenCalled();
  });
});
