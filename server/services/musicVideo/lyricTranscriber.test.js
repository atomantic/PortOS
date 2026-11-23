import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { encodePcm16Wav, parseWhisperCliWords } from './lyricAlignCore.js';
import {
  ALIGN_MODEL_FILE,
  ALIGN_MODEL_SHA256,
  ALIGN_MODEL_URL,
  ensureAlignmentModel,
  resolveAlignmentTranscriber,
} from './lyricTranscriber.js';
import {
  VOICE_MODEL_SHA256,
  WHISPER_HF_COMMIT,
  inspectVoiceAsset,
  voiceAssetReceiptPath,
  writeVoiceAssetReceipt,
} from '../../lib/voiceModelAssets.js';

// A whisper-cli `-ml 1 -sow -ojf` file: one entry per word, offsets in ms,
// special tokens and empty entries mixed in, a contraction split over two
// tokens, and a sound caption the recognizer invented.
const CLI_JSON = {
  systeminfo: 'test',
  model: { type: 'large' },
  result: { language: 'en' },
  transcription: [
    { offsets: { from: 0, to: 170 }, text: '', tokens: [{ text: '[_BEG_]', offsets: { from: 0, to: 0 } }] },
    {
      offsets: { from: 170, to: 900 },
      text: " I'm",
      tokens: [{ text: ' I', offsets: { from: 170, to: 400 } }, { text: "'m", offsets: { from: 400, to: 900 } }],
    },
    { offsets: { from: 900, to: 1400 }, text: ' walking', tokens: [{ text: ' walking', offsets: { from: 900, to: 1400 } }] },
    { offsets: { from: 1400, to: 2000 }, text: ' home', tokens: [{ text: ' home', offsets: { from: 1400, to: 2000 } }, { text: '[_TT_100]', offsets: { from: 2000, to: 2000 } }] },
    { offsets: { from: 2500, to: 2800 }, text: ' *soft', tokens: [{ text: ' *', offsets: { from: 2500, to: 2600 } }, { text: 'soft', offsets: { from: 2600, to: 2800 } }] },
    { offsets: { from: 2800, to: 3200 }, text: ' music*', tokens: [{ text: ' music', offsets: { from: 2800, to: 3100 } }, { text: '*', offsets: { from: 3100, to: 3200 } }] },
    { offsets: { from: 4000, to: 4600 }, text: ' tonight', tokens: [{ text: ' tonight', offsets: { from: 4000, to: 4600 } }] },
  ],
};

describe('parseWhisperCliWords', () => {
  it('reads word timings from the -ojf file, dropping special tokens and sound captions', () => {
    expect(parseWhisperCliWords(CLI_JSON)).toEqual([
      { text: "I'm", startSec: 0.17, endSec: 0.9 },
      { text: 'walking', startSec: 0.9, endSec: 1.4 },
      { text: 'home', startSec: 1.4, endSec: 2 },
      { text: 'tonight', startSec: 4, endSec: 4.6 },
    ]);
  });
});

describe('resolveAlignmentTranscriber', () => {
  const voiceConfig = async () => ({ stt: { endpoint: 'http://127.0.0.1:5562', language: 'en', modelPath: '/models/ggml-base.en.bin' } });
  const which = (present) => vi.fn(async (name) => (present.includes(name) ? `/bin/${name}` : null));

  it('prefers whisper-cli with the music model, and runs it once over the song', async () => {
    const ensureModel = vi.fn(async () => '/models/ggml-large-v3-turbo.bin');
    const probeEndpoint = vi.fn(async () => true);
    const runCommand = vi.fn(async (bin, args) => {
      const outBase = args[args.indexOf('-of') + 1];
      await writeFile(`${outBase}.json`, JSON.stringify(CLI_JSON));
      return { success: true };
    });
    const transcriber = await resolveAlignmentTranscriber({
      which: which(['whisper-cli', 'whisper-server']), voiceConfig, probeEndpoint, ensureModel, runCommand,
    });
    expect(transcriber.kind).toBe('whisper-cli');
    expect(probeEndpoint).not.toHaveBeenCalled();
    expect(ensureModel).toHaveBeenCalledWith({ configuredModelPath: '/models/ggml-base.en.bin', onDownloadProgress: null });

    // A windowed re-align slices the audio and shifts the words onto the song clock.
    const words = await transcriber.transcribe(encodePcm16Wav(16000 * 10), { startSec: 2, endSec: 8, prompt: 'walking home' });
    expect(runCommand).toHaveBeenCalledOnce();
    const [bin, args] = runCommand.mock.calls[0];
    expect(bin).toBe('/bin/whisper-cli');
    expect(args).toEqual(expect.arrayContaining(['-m', '/models/ggml-large-v3-turbo.bin', '-ml', '1', '-ojf', '-sow', '--prompt', 'walking home']));
    expect(words[0]).toEqual({ text: "I'm", startSec: 2.17, endSec: 2.9 });
  });

  it('uses the voice endpoint when whisper-cli is absent and something answers there', async () => {
    const ensureModel = vi.fn();
    const transcribe = vi.fn(async () => ({ words: [{ text: 'hello', startSec: 0.1, endSec: 0.4 }] }));
    const transcriber = await resolveAlignmentTranscriber({
      which: which(['whisper-server']), voiceConfig, probeEndpoint: async () => true, ensureModel, transcribe,
    });
    expect(transcriber.kind).toBe('stt-endpoint');
    expect(ensureModel).not.toHaveBeenCalled();
    const words = await transcriber.transcribe(encodePcm16Wav(16000 * 4), { prompt: 'hello' });
    expect(words).toEqual([{ text: 'hello', startSec: 0.1, endSec: 0.4 }]);
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ endpoint: 'http://127.0.0.1:5562', verbose: true, prompt: 'hello' }));
  });

  it('starts a temporary whisper-server when nothing answers and only the server binary exists', async () => {
    const stop = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:40123', stop }));
    const transcriber = await resolveAlignmentTranscriber({
      which: which(['whisper-server']),
      voiceConfig,
      probeEndpoint: async () => false,
      ensureModel: async () => '/models/ggml-large-v3-turbo.bin',
      startServer,
      transcribe: vi.fn(async () => ({ words: [] })),
    });
    expect(transcriber.kind).toBe('whisper-server');
    expect(startServer).toHaveBeenCalledWith({ bin: '/bin/whisper-server', modelPath: '/models/ggml-large-v3-turbo.bin' });
    await transcriber.release();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('refuses with install steps, and downloads nothing, when no whisper exists at all', async () => {
    const ensureModel = vi.fn();
    await expect(resolveAlignmentTranscriber({
      which: which([]), voiceConfig, probeEndpoint: async () => false, ensureModel,
    })).rejects.toMatchObject({ status: 503, code: 'LYRIC_ALIGN_STT_UNAVAILABLE', message: expect.stringMatching(/brew install whisper-cpp/) });
    expect(ensureModel).not.toHaveBeenCalled();
  });
});


it('requests DTW with matching turbo weights and reads DTW transitions, not legacy offsets', async () => {
  const ensureModel = vi.fn(async () => '/models/ggml-large-v3-turbo.bin');
  const runCommand = vi.fn(async (_bin, args) => {
    await writeFile(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ transcription: [{ tokens: [
      { text: '[_BEG_]', t_dtw: -1 },
      { text: ' bright', offsets: { from: 100, to: 300 }, t_dtw: 60 },
      { text: ' morning', offsets: { from: 300, to: 500 }, t_dtw: 110 },
      { text: ' river', offsets: { from: 500, to: 700 }, t_dtw: 160 },
    ] }] }));
    return { success: true };
  });
  const transcriber = await resolveAlignmentTranscriber({ requireDtw: true,
    which: async name => name === 'whisper-cli' ? '/bin/whisper-cli' : null,
    voiceConfig: async () => ({ stt: { modelPath: '/models/ggml-large-v2.bin' } }), ensureModel, runCommand });
  const words = await transcriber.transcribe(encodePcm16Wav(16000 * 8), { startSec: 2, endSec: 5, prompt: 'bright morning river' });
  expect(ensureModel).toHaveBeenCalledWith({ configuredModelPath: null, onDownloadProgress: null });
  expect(runCommand.mock.calls[0][1]).toEqual(expect.arrayContaining(['-dtw', 'large.v3.turbo', '-nfa']));
  expect(words).toEqual([{ text: 'bright', startSec: 2.1, endSec: 2.6 }, { text: 'morning', startSec: 2.6, endSec: 3.1 }, { text: 'river', startSec: 3.1, endSec: 3.6 }]);
});

it('does not substitute non-DTW endpoint timing for an independent placement check', async () => {
  const probeEndpoint = vi.fn(async () => true);
  await expect(resolveAlignmentTranscriber({ requireDtw: true, which: async () => null,
    voiceConfig: async () => ({ stt: { endpoint: 'http://127.0.0.1:5562' } }), probeEndpoint,
  })).rejects.toMatchObject({ code: 'LYRIC_VERIFY_DTW_UNAVAILABLE' });
  expect(probeEndpoint).not.toHaveBeenCalled();
});

describe('ensureAlignmentModel integrity contract', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lyric-align-model-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('pins ALIGN_MODEL_URL to a 40-char commit SHA and ALIGN_MODEL_SHA256 to the catalog digest', () => {
    expect(ALIGN_MODEL_URL).not.toContain('/resolve/main/');
    expect(ALIGN_MODEL_URL).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_HF_COMMIT}/${ALIGN_MODEL_FILE}`);
    expect(ALIGN_MODEL_SHA256).toBe(VOICE_MODEL_SHA256[ALIGN_MODEL_FILE]);
    expect(ALIGN_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('downloads with the pinned URL and SHA-256 and writes a completion receipt', async () => {
    const payload = 'large-v3-turbo-weights';
    const digest = createHash('sha256').update(payload).digest('hex');
    const download = vi.fn(async ({ destPath, url, expectedSha256 }) => {
      expect(url).toBe(ALIGN_MODEL_URL);
      expect(expectedSha256).toBe(digest);
      writeFileSync(destPath, payload);
    });

    const target = await ensureAlignmentModel({ modelDir: dir, download, expectedSha256: digest });
    expect(target).toBe(join(dir, ALIGN_MODEL_FILE));
    expect(download).toHaveBeenCalledOnce();
    expect(existsSync(voiceAssetReceiptPath(target))).toBe(true);
    expect(inspectVoiceAsset('whisper', target).state).toBe('verified');

    // A subsequent call reuses the verified asset without downloading again.
    const second = await ensureAlignmentModel({ modelDir: dir, download, expectedSha256: digest });
    expect(second).toBe(target);
    expect(download).toHaveBeenCalledOnce();
  });

  it('re-downloads when an existing target is empty or truncated against its receipt', async () => {
    const target = join(dir, ALIGN_MODEL_FILE);
    const download = vi.fn(async ({ destPath }) => {
      writeFileSync(destPath, 'complete-repaired-weights');
    });

    // Empty file must not satisfy readiness (bare existsSync would have returned it).
    writeFileSync(target, '');
    await ensureAlignmentModel({ modelDir: dir, download });
    expect(download).toHaveBeenCalledTimes(1);
    expect(inspectVoiceAsset('whisper', target).state).toBe('verified');

    // Truncating after a valid receipt marks the asset incomplete and forces repair.
    writeFileSync(target, 'short');
    expect(inspectVoiceAsset('whisper', target).state).toBe('incomplete');
    await ensureAlignmentModel({ modelDir: dir, download });
    expect(download).toHaveBeenCalledTimes(2);
    expect(inspectVoiceAsset('whisper', target).state).toBe('verified');
  });

  it('reuses a usable configured large model and rejects an incomplete configured large model', async () => {
    const configured = join(dir, 'ggml-large-v3.bin');
    const download = vi.fn(async ({ destPath }) => {
      writeFileSync(destPath, 'downloaded-turbo');
    });

    // Empty configured model is incomplete → must fall back to downloading alignment model.
    writeFileSync(configured, '');
    const downloaded = await ensureAlignmentModel({ modelDir: dir, configuredModelPath: configured, download });
    expect(downloaded).toBe(join(dir, ALIGN_MODEL_FILE));
    expect(download).toHaveBeenCalledOnce();

    // Remove the alignment model and make the configured large model verified → reuse it.
    rmSync(downloaded, { force: true });
    rmSync(voiceAssetReceiptPath(downloaded), { force: true });
    writeFileSync(configured, 'real-large-v3-weights');
    await writeVoiceAssetReceipt('whisper', configured);
    const reused = await ensureAlignmentModel({ modelDir: dir, configuredModelPath: configured, download });
    expect(reused).toBe(configured);
    expect(download).toHaveBeenCalledOnce();
  });

  it('fails with LYRIC_ALIGN_MODEL_DOWNLOAD_FAILED and writes no receipt when download verification fails', async () => {
    const target = join(dir, ALIGN_MODEL_FILE);
    const download = vi.fn(async () => {
      throw new Error('Download failed SHA-256 verification');
    });
    await expect(ensureAlignmentModel({ modelDir: dir, download })).rejects.toMatchObject({
      status: 502,
      code: 'LYRIC_ALIGN_MODEL_DOWNLOAD_FAILED',
    });
    expect(existsSync(voiceAssetReceiptPath(target))).toBe(false);
  });
});
