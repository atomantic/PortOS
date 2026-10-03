// Regression for #9808: a Piper voice that merely EXISTS must not short-circuit
// repair. Runs against a real temp HOME (no fs mock) so the completion contract
// in lib/voiceModelAssets.js is exercised end to end through bootstrap.js.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  const fs = await import('fs');
  home.dir = fs.mkdtempSync(actual.tmpdir() + '/voice-bootstrap-');
  return { ...actual, default: { ...actual, homedir: () => home.dir }, homedir: () => home.dir };
});
vi.mock('../pm2.js', () => ({ execPm2: vi.fn(async () => ({})), getAppStatus: vi.fn(async () => null) }));
vi.mock('../../lib/processEnv.js', () => ({ whichFirst: vi.fn(async () => null) }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn() }));
vi.mock('../providers.js', () => ({ getProviderById: vi.fn() }));
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
const setupScriptCompletes = () => execFile.mockImplementation((_cmd, _args, _opts, done) => {
  writeFileSync(onnxPath(), 'onnx-bytes');
  writeFileSync(`${onnxPath()}.json`, CONFIG);
  writeVoiceAssetReceipt('piper', onnxPath()).then(() => done(null, { stdout: '', stderr: '' }), done);
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

  it('is repaired by the voice download action instead of being skipped', async () => {
    setupScriptCompletes();
    await expect(downloadPiperVoice(VOICE_ID, cfg())).resolves.toMatchObject({ downloaded: true });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(inspectVoiceAsset('piper', onnxPath()).state).toBe('verified');
    // …and once verified, the next request really is a no-op.
    await expect(downloadPiperVoice(VOICE_ID, cfg())).resolves.toMatchObject({ skipped: true });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('never reports a download that left the voice unusable', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, done) => done(null, { stdout: '', stderr: '' }));
    await expect(downloadPiperVoice(VOICE_ID, cfg())).rejects.toThrow(/still not usable/);
  });

  it('is repaired by Save & Reconcile (default allowSetup) via the setup script', async () => {
    setupScriptCompletes();
    await reconcile(cfg());
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(inspectVoiceAsset('piper', onnxPath()).state).toBe('verified');
  });

  it('is left alone at boot: readiness is read-only and starts no download', async () => {
    mkdirSync(join(home.dir, '.portos/voice/piper'), { recursive: true });
    await expect(reconcile(cfg(), { allowSetup: false })).resolves.toMatchObject({ setupRequired: 'piper' });
    expect(execFile).not.toHaveBeenCalled();
  });
});
