// Windows-installer counterpart of setup-voice.test.js. Runs the real
// setup-voice.ps1 under PowerShell with Invoke-WebRequest replaced by a function
// stub (functions outrank cmdlets), in a disposable USERPROFILE — no network.
// Skipped where no PowerShell is installed; Windows and ubuntu CI runners ship one.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import {
  PIPER_RELEASE_ARCHIVE_SHA256,
  PIPER_VOICES_HF_COMMIT,
  WHISPER_HF_COMMIT,
  inspectVoiceAsset,
} from '../server/lib/voiceModelAssets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VOICE = 'en_US-test-low';
const STUB_ARCHIVE_SHA256 = createHash('sha256').update('archive-ok').digest('hex');
const STUB_WHISPER_SHA256 = createHash('sha256').update('whisper-v1').digest('hex');
const STUB_ONNX_SHA256 = createHash('sha256').update('onnx-v1').digest('hex');
const PS = ['pwsh', 'powershell'].find((bin) => spawnSync(bin, ['-NoProfile', '-Command', 'exit 0']).status === 0);

const WRAPPER = `
$ErrorActionPreference = 'Stop'
if ($env:STUB_WHISPER) { function whisper-server {} }
function Invoke-WebRequest {
    param($Uri, $OutFile, $Method, [switch]$UseBasicParsing)
    Add-Content -Path $env:CURL_LOG -Value "$Method $Uri"
    if ($env:CURL_FAIL_MATCH -and $Uri -like "*$($env:CURL_FAIL_MATCH)*") {
        Set-Content -Path $OutFile -Value 'partial' -NoNewline
        throw 'transfer dropped'
    }
    if ($Uri -like '*.zip') { Set-Content -Path $OutFile -Value 'archive-ok' -NoNewline }
    elseif ($Uri -like '*.onnx.json') { Set-Content -Path $OutFile -Value '{"audio":{"sample_rate":22050}}' -NoNewline }
    elseif ($Uri -like '*.onnx') { Set-Content -Path $OutFile -Value 'onnx-v1' -NoNewline }
    else { Set-Content -Path $OutFile -Value 'whisper-v1' -NoNewline }
}
function Expand-Archive {
    param($Path, $DestinationPath, [switch]$Force)
    if ($env:EXPAND_FAIL) { throw 'bad archive' }
    New-Item -ItemType Directory -Force -Path (Join-Path $DestinationPath 'piper') | Out-Null
    Set-Content -Path (Join-Path $DestinationPath 'piper/piper.exe') -Value 'x' -NoNewline
}
. (Join-Path $env:REPO_ROOT 'scripts/setup-voice.ps1')
`;

describe('setup-voice.ps1 static integrity contract', () => {
  it('uses zero mutable /resolve/main/ URLs and delegates URLs and SHA-256 verification to voice-asset.js', () => {
    const source = readFileSync(join(ROOT, 'scripts/setup-voice.ps1'), 'utf8');
    expect(source).not.toContain('/resolve/main/');
    expect(source).toContain('Invoke-VoiceAsset url');
    expect(source).toContain("verify-model");
  });
});

describe.skipIf(!PS)('setup-voice.ps1 model provisioning', () => {
  let home;
  let voices;
  let log;
  let wrapper;

  const run = (env = {}) => spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      USERPROFILE: home,
      REPO_ROOT: ROOT,
      STT_ENGINE: 'web-speech',
      TTS_ENGINE: 'piper',
      VOICE_NAME: VOICE,
      CURL_LOG: log,
      PORTOS_TEST_ARCHIVE_SHA256: JSON.stringify(Object.fromEntries(Object.keys(PIPER_RELEASE_ARCHIVE_SHA256).map((n) => [n, STUB_ARCHIVE_SHA256]))),
      ...env,
    },
  });
  const onnx = () => join(voices, `${VOICE}.onnx`);
  const leftovers = () => readdirSync(voices).filter((f) => f.includes('.part.'));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'setup-voice-ps-'));
    wrapper = join(home, 'wrapper.ps1');
    writeFileSync(wrapper, WRAPPER);
    log = join(home, 'web.log');
    // Piper binary already installed, so only the voice is provisioned.
    const piper = join(home, '.portos/voice/piper');
    mkdirSync(piper, { recursive: true });
    writeFileSync(join(piper, 'piper.exe'), 'x');
    chmodSync(join(piper, 'piper.exe'), 0o755);
    voices = join(home, '.portos/voice/voices');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('leaves no partial pair when the sidecar transfer drops, then recovers on retry', () => {
    const failed = run({ CURL_FAIL_MATCH: '.onnx.json' });
    expect(failed.status).not.toBe(0);
    expect(existsSync(onnx())).toBe(false);
    expect(leftovers()).toEqual([]);

    const retry = run();
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(inspectVoiceAsset('piper', onnx()).state).toBe('verified');
  });

  it.each([
    ['download', { CURL_FAIL_MATCH: 'piper_windows' }],
    ['extraction', { EXPAND_FAIL: '1' }],
  ])('leaves no Piper zip or staging dir when the %s fails', (_label, fail) => {
    rmSync(join(home, '.portos/voice/piper/piper.exe'));
    const failed = run(fail);
    expect(failed.status).not.toBe(0);
    expect(readdirSync(join(home, '.portos/voice')).filter((f) => f.startsWith('.piper'))).toEqual([]);
  });

  it('rejects a mismatched Piper archive before extracting and leaves the install untouched', () => {
    const piperDir = join(home, '.portos/voice/piper');
    writeFileSync(join(piperDir, 'marker.txt'), 'keep');
    rmSync(join(piperDir, 'piper.exe'));
    const result = run({ PORTOS_TEST_ARCHIVE_SHA256: JSON.stringify({ 'piper_windows_amd64.zip': '0'.repeat(64) }) });
    expect(result.status).not.toBe(0);
    expect(readdirSync(piperDir)).toEqual(['marker.txt']);
    expect(readdirSync(join(home, '.portos/voice')).filter((f) => f.startsWith('.piper'))).toEqual([]);
  });

  it('repairs a poisoned ONNX that has no sidecar', () => {
    mkdirSync(voices, { recursive: true });
    writeFileSync(onnx(), 'partial');
    const result = run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(onnx(), 'utf8')).toBe('onnx-v1');
    expect(inspectVoiceAsset('piper', onnx()).state).toBe('verified');
  });

  it('adopts a complete pre-receipt pair without downloading', () => {
    mkdirSync(voices, { recursive: true });
    writeFileSync(onnx(), 'legacy-onnx');
    writeFileSync(`${onnx()}.json`, '{"audio":{"sample_rate":22050}}');
    expect(run().status).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(inspectVoiceAsset('piper', onnx()).state).toBe('verified');
  });

  it('uses pinned 40-char commit SHAs (never /resolve/main/) for Whisper and Piper downloads', () => {
    const result = run({
      STT_ENGINE: 'whisper',
      TTS_ENGINE: 'piper',
      MODEL_NAME: 'ggml-test.bin',
      STUB_WHISPER: '1',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const urls = readFileSync(log, 'utf8').trim().split(/\r?\n/);
    for (const line of urls) expect(line).not.toContain('/resolve/main/');
    expect(urls.join('\n')).toContain(`https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_HF_COMMIT}/ggml-test.bin`);
    expect(urls.join('\n')).toContain(`https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_HF_COMMIT}/en/en_US/test/low/en_US-test-low.onnx`);
  });

  it('rejects mismatched curated Whisper and Piper assets before promotion, and promotes on match', () => {
    const modelsDir = join(home, '.portos/voice/models');
    const catalogModel = 'ggml-base.en.bin';
    const catalogVoice = 'en_GB-jenny_dioco-medium';

    const badWhisper = run({
      STT_ENGINE: 'whisper',
      TTS_ENGINE: 'qwen3-tts',
      MODEL_NAME: catalogModel,
      STUB_WHISPER: '1',
    });
    expect(badWhisper.status).not.toBe(0);
    expect(existsSync(join(modelsDir, catalogModel))).toBe(false);
    expect(readdirSync(modelsDir).filter((f) => f.includes('.part.'))).toEqual([]);

    const goodWhisper = run({
      STT_ENGINE: 'whisper',
      TTS_ENGINE: 'qwen3-tts',
      MODEL_NAME: catalogModel,
      STUB_WHISPER: '1',
      PORTOS_TEST_MODEL_SHA256: JSON.stringify({ [catalogModel]: STUB_WHISPER_SHA256 }),
    });
    expect(goodWhisper.status, `${goodWhisper.stdout}\n${goodWhisper.stderr}`).toBe(0);
    expect(inspectVoiceAsset('whisper', join(modelsDir, catalogModel)).state).toBe('verified');

    const badPiper = run({ VOICE_NAME: catalogVoice });
    expect(badPiper.status).not.toBe(0);
    expect(existsSync(join(voices, `${catalogVoice}.onnx`))).toBe(false);
    expect(leftovers()).toEqual([]);

    const goodPiper = run({
      VOICE_NAME: catalogVoice,
      PORTOS_TEST_MODEL_SHA256: JSON.stringify({ [`${catalogVoice}.onnx`]: STUB_ONNX_SHA256 }),
    });
    expect(goodPiper.status, `${goodPiper.stdout}\n${goodPiper.stderr}`).toBe(0);
    expect(inspectVoiceAsset('piper', join(voices, `${catalogVoice}.onnx`)).state).toBe('verified');
  });
});
