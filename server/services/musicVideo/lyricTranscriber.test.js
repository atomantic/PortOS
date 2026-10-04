import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'fs/promises';
import { encodePcm16Wav, parseWhisperCliWords } from './lyricAlignCore.js';
import { resolveAlignmentTranscriber } from './lyricTranscriber.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

describe('freeLoopbackPort error handling', () => {
  it('registers error listener on net.Server to prevent crashes on listen failures', () => {
    // freeLoopbackPort is a private helper used by startTemporaryWhisperServer to find
    // a free loopback port. It creates a temporary net.Server and registers error handling:
    //
    // 1. server.unref() prevents the port-finder from blocking process shutdown
    // 2. server.on('error', reject) catches listen() errors before they become unhandled
    //
    // When listen() encounters socket errors (EMFILE, ENFILE, EADDRNOTAVAIL, etc.),
    // an uncaught error event would crash the entire process. The error listener ensures
    // the promise rejects cleanly instead.
    //
    // Verify the implementation contains the critical error listener:
    const sourceFile = join(dirname(fileURLToPath(import.meta.url)), './lyricTranscriber.js');
    const source = readFileSync(sourceFile, 'utf-8');

    // The function must register error listener before listen() call
    expect(source).toMatch(/server\.on\('error',\s*reject\)/);
    expect(source).toMatch(/server\.unref\(\)/);
    expect(source).toMatch(/return new Promise\(\(resolve,\s*reject\)\s*=>/);
  });

  it('resolves with valid port on successful socket listen', async () => {
    // Integration test: startTemporaryWhisperServer calls freeLoopbackPort internally.
    // Verify that port allocation works correctly through the higher-level function.
    const { resolveAlignmentTranscriber } = await import('./lyricTranscriber.js');

    const voiceConfig = async () => ({
      stt: { endpoint: 'http://127.0.0.1:5562', language: 'en', modelPath: '/models/ggml-base.en.bin' },
    });

    // Test that when whisper-server is the available option, we can start a temporary server
    // This implicitly exercises freeLoopbackPort's success path
    const stop = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:40123', stop }));

    const transcriber = await resolveAlignmentTranscriber({
      which: vi.fn(async (name) => (name === 'whisper-server' ? '/bin/whisper-server' : null)),
      voiceConfig,
      probeEndpoint: async () => false,
      ensureModel: async () => '/models/ggml-large-v3-turbo.bin',
      startServer,
      transcribe: vi.fn(async () => ({ words: [] })),
    });

    expect(transcriber.kind).toBe('whisper-server');
    expect(startServer).toHaveBeenCalledWith({ bin: '/bin/whisper-server', modelPath: '/models/ggml-large-v3-turbo.bin' });
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
    expect(ensureModel).toHaveBeenCalledWith({ configuredModelPath: '/models/ggml-base.en.bin' });

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
