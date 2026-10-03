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
import { inspectVoiceAsset } from '../server/lib/voiceModelAssets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VOICE = 'en_US-test-low';
const PS = ['pwsh', 'powershell'].find((bin) => spawnSync(bin, ['-NoProfile', '-Command', 'exit 0']).status === 0);

const WRAPPER = `
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
    param($Uri, $OutFile, $Method, [switch]$UseBasicParsing)
    Add-Content -Path $env:CURL_LOG -Value "$Method $Uri"
    if ($env:CURL_FAIL_MATCH -and $Uri -like "*$($env:CURL_FAIL_MATCH)*") {
        Set-Content -Path $OutFile -Value 'partial' -NoNewline
        throw 'transfer dropped'
    }
    if ($Uri -like '*.onnx.json') { Set-Content -Path $OutFile -Value '{"audio":{"sample_rate":22050}}' -NoNewline }
    elseif ($Uri -like '*.onnx') { Set-Content -Path $OutFile -Value 'onnx-v1' -NoNewline }
    else { Set-Content -Path $OutFile -Value 'whisper-v1' -NoNewline }
}
. (Join-Path $env:REPO_ROOT 'scripts/setup-voice.ps1')
`;

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
});
