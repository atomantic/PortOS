// Regression for #9808: a Piper voice that merely EXISTS must not short-circuit
// repair. Runs against a real temp HOME (no fs mock) so the completion contract
// in lib/voiceModelAssets.js is exercised end to end through bootstrap.js.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  const fs = await import('fs');
  home.dir = fs.mkdtempSync(actual.tmpdir() + '/voice-bootstrap-');
  return { ...actual, default: { ...actual, homedir: () => home.dir }, homedir: () => home.dir };
});
vi.mock('../pm2.js', () => ({
  clearJlistCache: vi.fn(),
  execPm2: vi.fn(async () => ({})),
  getAppStatusStrict: vi.fn(async () => ({ status: 'not_found' })),
}));
vi.mock('../../lib/processEnv.js', () => ({ whichFirst: vi.fn(async () => null) }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn() }));
vi.mock('../provider/providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('./llm.js', () => ({ isToolCapable: vi.fn(), isReasoningModel: vi.fn() }));

const { execFile } = await import('../../lib/childProcess.js');
const { VOICE_DEFAULTS, expandPath, piperVoiceTildePath } = await import('./config.js');
const { writeVoiceAssetReceipt, inspectVoiceAsset } = await import('../../lib/voiceModelAssets.js');
const { verifyModels, downloadPiperVoice, reconcile } = await import('./bootstrap.js');

const VOICE_ID = 'en_US-test-low';
const CONFIG = JSON.stringify({ audio: { sample_rate: 22050 } });
const onnxPath = () => expandPath(piperVoiceTildePath(VOICE_ID));
const cfg = (overrides = {}) => ({
  ...VOICE_DEFAULTS, enabled: true,
  stt: { ...VOICE_DEFAULTS.stt, engine: 'web-speech' },
  tts: { engine: 'piper', piper: { voicePath: piperVoiceTildePath(VOICE_ID) } },
  ...overrides,
});

// A setup script double that completes the pair the way the real one does.
const setupScriptCompletes = (ready = Promise.resolve()) => execFile.mockImplementation((_cmd, _args, _opts, done) => {
  ready.then(() => {
    writeFileSync(onnxPath(), 'onnx-bytes');
    writeFileSync(`${onnxPath()}.json`, CONFIG);
    return writeVoiceAssetReceipt('piper', onnxPath());
  }).then(() => done(null, { stdout: '', stderr: '' }), done);
});

describe('Piper voice with an ONNX but no sidecar (#9808)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmSync(join(home.dir, '.portos'), { recursive: true, force: true });
    mkdirSync(join(home.dir, '.portos/voice/voices'), { recursive: true });
    writeFileSync(onnxPath(), 'partial');
  });
  afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

  it('is not reported as a ready voice', () => {
    const models = verifyModels(cfg());
    expect(models.ttsVoice).toBeNull();
    expect(models.ttsVoiceState).toBe('incomplete');
  });

  it('repairs the voice once when overlapping downloads request the same voice', async () => {
    const ready = Promise.withResolvers();
    setupScriptCompletes(ready.promise);
    const downloads = Promise.all([downloadPiperVoice(VOICE_ID, cfg()), downloadPiperVoice(VOICE_ID, cfg())]);
    ready.resolve();

    await expect(downloads).resolves.toEqual([
      { downloaded: true, voicePath: piperVoiceTildePath(VOICE_ID) },
      { skipped: true, voicePath: piperVoiceTildePath(VOICE_ID) },
    ]);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(inspectVoiceAsset('piper', onnxPath()).state).toBe('verified');
  });

  it('keeps Piper audition setup from provisioning configured Whisper or CoreML', async () => {
    setupScriptCompletes();
    await expect(downloadPiperVoice(VOICE_ID, cfg({
      stt: { ...VOICE_DEFAULTS.stt, engine: 'whisper', coreml: true },
    }))).resolves.toMatchObject({ downloaded: true });

    const setupEnv = execFile.mock.calls[0][2].env;
    expect(setupEnv).toMatchObject({ STT_ENGINE: 'web-speech', INSTALL_COREML: '0' });
    expect(inspectVoiceAsset('piper', onnxPath()).state).toBe('verified');
  });

  it('rejects a download that left the voice unusable and lets the next request retry', async () => {
    setupScriptCompletes();
    execFile.mockImplementationOnce((_cmd, _args, _opts, done) => done(null, { stdout: '', stderr: '' }));
    const failed = expect(downloadPiperVoice(VOICE_ID, cfg())).rejects.toThrow(/still not usable/);
    const retried = expect(downloadPiperVoice(VOICE_ID, cfg())).resolves.toMatchObject({ downloaded: true });
    await Promise.all([failed, retried]);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('is repaired by Save & Reconcile (default allowSetup) via the setup script', async () => {
    setupScriptCompletes();
    await expect(reconcile(cfg({ stt: { ...VOICE_DEFAULTS.stt, engine: 'whisper', coreml: true } })))
      .rejects.toThrow(/whisper-server not on PATH/);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][2].env).toMatchObject({ STT_ENGINE: 'whisper', INSTALL_COREML: '1' });
  });

  it('is left alone at boot: readiness is read-only and starts no download', async () => {
    mkdirSync(join(home.dir, '.portos/voice/piper'), { recursive: true });
    await expect(reconcile(cfg(), { allowSetup: false })).resolves.toMatchObject({ setupRequired: 'piper' });
    expect(execFile).not.toHaveBeenCalled();
  });
});
