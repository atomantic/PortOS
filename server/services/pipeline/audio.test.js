import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = join(tmpdir(), `portos-audio-test-${process.pid}-${Date.now()}`);
const FAKE_AUDIO_DIR = join(TEST_HOME, 'audio');

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, audio: FAKE_AUDIO_DIR },
    ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })),
  };
});

const synthesizeMock = vi.fn();
const listVoicesMock = vi.fn();
vi.mock('../voice/tts.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  synthesize: (...a) => synthesizeMock(...a),
  listVoices: (...a) => listVoicesMock(...a),
  VALID_ENGINES: new Set(['kokoro', 'piper']),
}));

const { parseVoiceId, listAllVoices, synthesizeToFile, extractDialogueLines, resolveVoiceForLine, wavDurationMs } = await import('./audio.js');

// Build a minimal canonical PCM WAV header for `dataBytes` of audio at the given
// sample rate / channels / bit depth, so duration math is exercised end-to-end.
function makeWav({ sampleRate = 24000, channels = 1, bitsPerSample = 16, dataBytes = 0 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

beforeEach(async () => {
  synthesizeMock.mockReset();
  listVoicesMock.mockReset();
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
  await mkdir(TEST_HOME, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('parseVoiceId', () => {
  it('splits engine:voice pairs', () => {
    expect(parseVoiceId('kokoro:af_heart')).toEqual({ engine: 'kokoro', voice: 'af_heart' });
    expect(parseVoiceId('piper:en_GB-northern_english_male')).toEqual({
      engine: 'piper', voice: 'en_GB-northern_english_male',
    });
  });

  it('ignores unknown engine prefixes and treats the whole id as a bare voice name', () => {
    expect(parseVoiceId('elevenlabs:Rachel')).toEqual({ engine: null, voice: 'elevenlabs:Rachel' });
  });

  it('treats unprefixed strings as a bare voice name', () => {
    expect(parseVoiceId('af_heart')).toEqual({ engine: null, voice: 'af_heart' });
  });

  it('returns nulls for empty / whitespace / non-string inputs', () => {
    expect(parseVoiceId('')).toEqual({ engine: null, voice: null });
    expect(parseVoiceId('   ')).toEqual({ engine: null, voice: null });
    expect(parseVoiceId(null)).toEqual({ engine: null, voice: null });
    expect(parseVoiceId(undefined)).toEqual({ engine: null, voice: null });
    expect(parseVoiceId(42)).toEqual({ engine: null, voice: null });
  });
});

describe('listAllVoices', () => {
  it('namespaces voices with engine: and merges across providers', async () => {
    listVoicesMock.mockImplementation(async (engine) => {
      if (engine === 'kokoro') return { engine, voices: [{ name: 'af_heart', label: 'Heart' }] };
      if (engine === 'piper') return { engine, voices: [{ name: 'en_GB-northern_english_male' }] };
      return { engine, voices: [] };
    });
    const voices = await listAllVoices();
    expect(voices).toContainEqual(expect.objectContaining({
      id: 'kokoro:af_heart', engine: 'kokoro', voice: 'af_heart',
    }));
    expect(voices).toContainEqual(expect.objectContaining({
      id: 'piper:en_GB-northern_english_male', engine: 'piper',
    }));
  });

  it('falls back gracefully when one engine throws', async () => {
    listVoicesMock.mockImplementation(async (engine) => {
      if (engine === 'kokoro') return { engine, voices: [{ name: 'af_heart' }] };
      throw new Error('piper unavailable');
    });
    const voices = await listAllVoices();
    expect(voices.length).toBe(1);
    expect(voices[0].engine).toBe('kokoro');
  });
});

describe('synthesizeToFile', () => {
  it('rejects empty text with 400', async () => {
    await expect(synthesizeToFile({ text: '  ', voiceId: 'kokoro:af_heart' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('writes the rendered WAV to PATHS.audio and returns the filename', async () => {
    synthesizeMock.mockResolvedValue({ wav: Buffer.from('FAKE-WAV-BYTES'), latencyMs: 123, engine: 'kokoro' });
    const result = await synthesizeToFile({ text: 'hello there', voiceId: 'kokoro:af_heart' });
    expect(result.filename).toMatch(/^vo-.*\.wav$/);
    expect(result.engine).toBe('kokoro');
    expect(result.latencyMs).toBe(123);
    const written = await readFile(join(FAKE_AUDIO_DIR, result.filename));
    expect(written.toString()).toBe('FAKE-WAV-BYTES');
  });

  it('passes engine + voice through to synthesize() when the id is namespaced', async () => {
    synthesizeMock.mockResolvedValue({ wav: Buffer.from('w'), latencyMs: 1, engine: 'piper' });
    await synthesizeToFile({ text: 'hi', voiceId: 'piper:en_GB-northern_english_male' });
    expect(synthesizeMock).toHaveBeenCalledWith('hi', expect.objectContaining({
      engine: 'piper',
      voice: 'en_GB-northern_english_male',
    }));
  });

  it('omits engine/voice when no voiceId is supplied (lets the configured default apply)', async () => {
    synthesizeMock.mockResolvedValue({ wav: Buffer.from('w'), latencyMs: 1, engine: 'kokoro' });
    await synthesizeToFile({ text: 'hi' });
    const passed = synthesizeMock.mock.calls.at(-1)[1];
    expect(passed).not.toHaveProperty('engine');
    expect(passed).not.toHaveProperty('voice');
  });

  it('returns the measured WAV duration (ms) for the narration timeline', async () => {
    // 24000 samples of 16-bit mono @ 24kHz = exactly 1 second.
    synthesizeMock.mockResolvedValue({ wav: makeWav({ dataBytes: 24000 * 2 }), latencyMs: 5, engine: 'kokoro' });
    const result = await synthesizeToFile({ text: 'one second please', voiceId: 'kokoro:af_heart' });
    expect(result.durationMs).toBe(1000);
  });
});

describe('wavDurationMs', () => {
  it('computes duration from the data chunk and byte rate', () => {
    expect(wavDurationMs(makeWav({ sampleRate: 24000, dataBytes: 24000 * 2 }))).toBe(1000);
    expect(wavDurationMs(makeWav({ sampleRate: 16000, dataBytes: 16000 * 2 }))).toBe(1000);
    // Half a second.
    expect(wavDurationMs(makeWav({ sampleRate: 24000, dataBytes: 24000 }))).toBe(500);
  });

  it('returns 0 for non-buffer / too-short / non-RIFF input', () => {
    expect(wavDurationMs(null)).toBe(0);
    expect(wavDurationMs(Buffer.alloc(4))).toBe(0);
    expect(wavDurationMs(Buffer.from('NOT-A-WAV-FILE-AT-ALL'))).toBe(0);
  });

  it('clamps a declared data size larger than the actual buffer', () => {
    const buf = makeWav({ sampleRate: 24000, dataBytes: 24000 * 2 });
    // Lie about the data size (claim 10x the bytes present) — duration must
    // reflect the bytes actually in the buffer, not the inflated header value.
    buf.writeUInt32LE(24000 * 2 * 10, 40);
    expect(wavDurationMs(buf)).toBe(1000);
  });
});

describe('extractDialogueLines', () => {
  const series = {
    characters: [
      { id: 'chr-jean', name: 'Jean', aliases: ['Jeanie'] },
      { id: 'chr-don', name: 'Don Carlos' },
    ],
  };
  const issueWithDialogue = {
    stages: {
      storyboards: {
        scenes: [
          {
            slugline: 'INT. KITCHEN — NIGHT',
            dialogue: [
              { character: 'JEAN', line: 'I told you he was coming.' },
              { character: 'DON CARLOS (whispered)', line: 'Quiet now.' },
              { character: 'NARRATOR', line: 'Outside, the rain began.' },
            ],
          },
          {
            slugline: 'EXT. STREET — NIGHT',
            dialogue: [
              { character: 'Jeanie', line: 'You always do this.' },
              { character: '', line: 'A scream — unattributed.' },
              { character: 'X', line: '   ' }, // whitespace text → skip
            ],
          },
        ],
      },
    },
  };

  it('flattens dialogue across scenes into a numbered lines[] list', () => {
    const { lines, preservedCount } = extractDialogueLines(issueWithDialogue, series);
    expect(lines.map((l) => l.id)).toEqual(['line-001', 'line-002', 'line-003', 'line-004', 'line-005']);
    expect(lines).toHaveLength(5);
    expect(preservedCount).toBe(0);
  });

  it('binds speakers to series characters case-insensitively, including aliases', () => {
    const { lines } = extractDialogueLines(issueWithDialogue, series);
    expect(lines[0].characterId).toBe('chr-jean');
    expect(lines[1].characterId).toBe('chr-don');  // strip "(whispered)" parenthetical
    expect(lines[2].characterId).toBe(null);       // NARRATOR — no match
    expect(lines[3].characterId).toBe('chr-jean'); // 'Jeanie' alias resolves
    expect(lines[4].characterId).toBe(null);       // empty speaker
  });

  it('preserves the raw speaker label (including parentheticals) on the line', () => {
    const { lines } = extractDialogueLines(issueWithDialogue, series);
    expect(lines[1].characterName).toBe('DON CARLOS (whispered)');
  });

  it('initializes voice + audio fields to null (per-line resolution happens at render time)', () => {
    const { lines } = extractDialogueLines(issueWithDialogue, series);
    for (const l of lines) {
      expect(l.voiceIdOverride).toBe(null);
      expect(l.audioJobId).toBe(null);
      expect(l.audioFilename).toBe(null);
    }
  });

  it('skips dialogue rows with empty / whitespace-only text', () => {
    const { lines } = extractDialogueLines(issueWithDialogue, series);
    // The "X" speaker with whitespace text in scene 2 is dropped.
    expect(lines.find((l) => l.characterName === 'X')).toBeUndefined();
  });

  it('returns an empty list when no scenes or no dialogue', () => {
    expect(extractDialogueLines({ stages: {} }, series).lines).toEqual([]);
    expect(extractDialogueLines({ stages: { storyboards: { scenes: [] } } }, series).lines).toEqual([]);
    expect(extractDialogueLines({ stages: { storyboards: { scenes: [{ slugline: 'INT.' }] } } }, series).lines).toEqual([]);
  });

  it('tolerates a series with no characters[] (everything stays unbound)', () => {
    const { lines } = extractDialogueLines(issueWithDialogue, {});
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.characterId).toBe(null);
  });

  it('strips prefix + stacked parentheticals from speaker labels for character matching', () => {
    const issue = {
      stages: {
        storyboards: {
          scenes: [{
            dialogue: [
              { character: '(O.S.) JEAN', line: 'Behind the door.' },
              { character: 'JEAN (O.S.)(angry)', line: 'I said GO.' },
            ],
          }],
        },
      },
    };
    const { lines } = extractDialogueLines(issue, series);
    expect(lines).toHaveLength(2);
    expect(lines[0].characterId).toBe('chr-jean');
    expect(lines[1].characterId).toBe('chr-jean');
    // characterName preserves the raw label so the UI can show performance hints.
    expect(lines[0].characterName).toBe('(O.S.) JEAN');
    expect(lines[1].characterName).toBe('JEAN (O.S.)(angry)');
  });

  it('preserves audioFilename + audioJobId for unchanged speaker+text on re-extract', () => {
    const previous = [
      { characterName: 'JEAN', text: 'I told you he was coming.', audioFilename: 'vo-keep-001.wav', audioJobId: 'job-keep' },
      { characterName: 'NARRATOR', text: 'Outside, the rain began.', audioFilename: 'vo-keep-002.wav', audioJobId: null },
      // Stale row — text changed → should NOT carry forward.
      { characterName: 'DON CARLOS (whispered)', text: 'Different line.', audioFilename: 'vo-stale.wav' },
    ];
    const { lines, preservedCount } = extractDialogueLines(issueWithDialogue, series, { preserveFrom: previous });
    // line-001 ("JEAN" / "I told you he was coming.") — same speaker + text → preserved.
    expect(lines[0].audioFilename).toBe('vo-keep-001.wav');
    expect(lines[0].audioJobId).toBe('job-keep');
    // line-002 (DON CARLOS) — text differs → no carry.
    expect(lines[1].audioFilename).toBe(null);
    // line-003 (NARRATOR / "Outside, the rain began.") — same speaker + text → preserved.
    expect(lines[2].audioFilename).toBe('vo-keep-002.wav');
    expect(preservedCount).toBe(2);
  });

  it('first-name-wins for duplicate character names (no last-writer flip)', () => {
    const seriesWithDup = {
      characters: [
        { id: 'chr-jean-first', name: 'Jean' },
        { id: 'chr-jean-second', name: 'Jean' },
      ],
    };
    const issue = {
      stages: {
        storyboards: { scenes: [{ dialogue: [{ character: 'JEAN', line: 'pick one.' }] }] },
      },
    };
    const { lines } = extractDialogueLines(issue, seriesWithDup);
    expect(lines[0].characterId).toBe('chr-jean-first');
  });
});

describe('resolveVoiceForLine priority', () => {
  const series = {
    characters: [{ id: 'chr-1', name: 'Jean', voiceId: 'kokoro:af_heart' }],
  };

  it('explicit request override wins over everything else', () => {
    const line = { characterId: 'chr-1', voiceIdOverride: 'kokoro:af_bella' };
    expect(resolveVoiceForLine(line, series, { explicit: 'piper:en_GB-northern_english_male' }))
      .toBe('piper:en_GB-northern_english_male');
  });

  it('line override wins over character binding', () => {
    const line = { characterId: 'chr-1', voiceIdOverride: 'kokoro:af_bella' };
    expect(resolveVoiceForLine(line, series)).toBe('kokoro:af_bella');
  });

  it('character.voiceId used when no override', () => {
    const line = { characterId: 'chr-1', voiceIdOverride: null };
    expect(resolveVoiceForLine(line, series)).toBe('kokoro:af_heart');
  });

  it('returns null when nothing resolves (caller falls through to default)', () => {
    expect(resolveVoiceForLine({ characterId: null, voiceIdOverride: null }, series)).toBe(null);
    expect(resolveVoiceForLine({ characterId: 'unknown', voiceIdOverride: null }, series)).toBe(null);
    expect(resolveVoiceForLine({}, {})).toBe(null);
  });

  it('ignores whitespace-only explicit overrides', () => {
    const line = { voiceIdOverride: 'kokoro:af_bella' };
    expect(resolveVoiceForLine(line, series, { explicit: '   ' })).toBe('kokoro:af_bella');
  });
});
