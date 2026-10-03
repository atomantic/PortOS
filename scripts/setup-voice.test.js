// Script-boundary coverage for scripts/setup-voice.sh: runs the real script in a
// disposable HOME with a `curl` stub on PATH, so no network, model or host state
// is touched. The stub can fail a chosen transfer after writing a partial file
// to the requested destination — what a dropped connection leaves behind.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { inspectVoiceAsset } from '../server/lib/voiceModelAssets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VOICE = 'en_US-test-low';
const CURL_STUB = `#!/usr/bin/env bash
dest=""; head=0; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    --head) head=1; shift ;;
    --fail|--location|--silent|--progress-bar) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$head $url" >> "$CURL_LOG"
if [[ $head == 1 ]]; then
  [[ -n "\${CURL_REMOTE_SIZE:-}" ]] || exit 22
  printf 'HTTP/2 200\\r\\ncontent-length: %s\\r\\n\\r\\n' "$CURL_REMOTE_SIZE"
  exit 0
fi
if [[ -z "$dest" ]]; then
  printf 'archive'
  exit 0
fi
if [[ -n "\${CURL_FAIL_MATCH:-}" && "$url" == *"\${CURL_FAIL_MATCH}"* ]]; then
  printf 'partial' > "$dest"
  exit 18
fi
case "$url" in
  *.onnx.json) printf '{"audio":{"sample_rate":22050}}' > "$dest" ;;
  *.onnx) printf 'onnx-%s' "\${CURL_TAG:-v1}" > "$dest" ;;
  *) printf 'whisper-%s' "\${CURL_TAG:-v1}" > "$dest" ;;
esac
`;
const UNAME_STUB = `#!/usr/bin/env bash
case "$1" in
  -s) printf '%s\\n' "\${FAKE_UNAME_S:-Linux}" ;;
  -m) printf '%s\\n' "\${FAKE_UNAME_M:-x86_64}" ;;
  *) exit 2 ;;
esac
`;
const TAR_STUB = `#!/usr/bin/env bash
dest=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C) dest="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat >/dev/null
if [[ "$dest" == *"/.portos/voice" ]]; then
  mkdir -p "$dest/piper"
  printf '#!/bin/sh\\n' > "$dest/piper/piper"
  chmod +x "$dest/piper/piper"
else
  mkdir -p "$dest/piper-phonemize/lib"
  : > "$dest/piper-phonemize/lib/libpiper_phonemize.so"
  : > "$dest/piper-phonemize/lib/libpiper_phonemize.dylib"
fi
`;

describe.skipIf(process.platform === 'win32')('setup-voice.sh model provisioning', () => {
  let home;
  let stubDir;
  let voices;
  let models;
  let log;

  const run = (env = {}) => spawnSync('bash', [join(ROOT, 'scripts/setup-voice.sh')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${stubDir}:${process.env.PATH}`,
      STT_ENGINE: 'web-speech',
      TTS_ENGINE: 'piper',
      VOICE_NAME: VOICE,
      MODEL_NAME: 'ggml-test.bin',
      CURL_LOG: log,
      ...env,
    },
  });
  const downloads = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('0 ')) : []);
  const onnx = () => join(voices, `${VOICE}.onnx`);
  const leftovers = (dir) => readdirSync(dir).filter((f) => f.includes('.part.'));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'setup-voice-'));
    stubDir = join(home, 'stub');
    mkdirSync(stubDir);
    writeFileSync(join(stubDir, 'curl'), CURL_STUB);
    chmodSync(join(stubDir, 'curl'), 0o755);
    writeFileSync(join(stubDir, 'uname'), UNAME_STUB);
    chmodSync(join(stubDir, 'uname'), 0o755);
    writeFileSync(join(stubDir, 'tar'), TAR_STUB);
    chmodSync(join(stubDir, 'tar'), 0o755);
    log = join(home, 'curl.log');
    // Pretend the Piper binary and its libs are already installed.
    const piper = join(home, '.portos/voice/piper');
    mkdirSync(join(piper, 'lib'), { recursive: true });
    writeFileSync(join(piper, 'piper'), '#!/bin/sh\n');
    chmodSync(join(piper, 'piper'), 0o755);
    writeFileSync(join(piper, 'lib/libpiper_phonemize.1.dylib'), 'x');
    voices = join(home, '.portos/voice/voices');
    models = join(home, '.portos/voice/models');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it.each([
    ['ONNX', `${VOICE}.onnx`],
    ['sidecar', '.onnx.json'],
  ])('leaves no partial Piper asset when the %s transfer drops, then recovers on retry', (_label, failMatch) => {
    const failed = run({ CURL_FAIL_MATCH: failMatch });
    expect(failed.status).toBe(18);
    expect(existsSync(onnx())).toBe(false);
    expect(leftovers(voices)).toEqual([]);

    const retry = run();
    expect(retry.status).toBe(0);
    expect(inspectVoiceAsset('piper', onnx()).state).toBe('verified');
  });

  it.each([
    ['Linux', 'x86_64', 'linux_x86_64'],
    ['Darwin', 'x86_64', 'macos_x64'],
    ['Linux', 'aarch64', 'linux_aarch64'],
    ['Darwin', 'arm64', 'macos_aarch64'],
  ])('selects published Piper and phonemize archives for %s/%s', (system, machine, suffix) => {
    rmSync(join(home, '.portos/voice/piper'), { recursive: true, force: true });
    const result = run({ FAKE_UNAME_S: system, FAKE_UNAME_M: machine });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const urls = downloads().join('\n');
    expect(urls).toContain(`piper_${suffix}.tar.gz`);
    expect(urls).toContain(`piper-phonemize_${suffix}.tar.gz`);
  });

  it('rejects an unsupported platform before requesting an archive', () => {
    rmSync(join(home, '.portos/voice/piper'), { recursive: true, force: true });
    const result = run({ FAKE_UNAME_S: 'FreeBSD', FAKE_UNAME_M: 'x86_64' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsupported Piper platform: freebsd/x86_64');
    expect(downloads()).toEqual([]);
  });

  it('repairs a poisoned ONNX with no sidecar instead of reporting ready', () => {
    mkdirSync(voices, { recursive: true });
    writeFileSync(onnx(), 'partial');
    const result = run();
    expect(result.status).toBe(0);
    expect(downloads()).toHaveLength(2);
    expect(readFileSync(onnx(), 'utf8')).toBe('onnx-v1');
    expect(inspectVoiceAsset('piper', onnx()).state).toBe('verified');
  });

  it('keeps the existing pair when its replacement fails partway, and writes no new receipt', () => {
    expect(run().status).toBe(0);
    const receipt = readFileSync(`${onnx()}.portos-complete.json`, 'utf8');
    // Same-size tamper: only the hash pass can tell, and it forces a re-download.
    writeFileSync(onnx(), 'onnx-vX');
    const failed = run({ CURL_FAIL_MATCH: '.onnx.json', CURL_TAG: 'v2' });
    expect(failed.status).toBe(18);
    expect(readFileSync(onnx(), 'utf8')).toBe('onnx-vX');
    expect(readFileSync(`${onnx()}.portos-complete.json`, 'utf8')).toBe(receipt);
    expect(leftovers(voices)).toEqual([]);
  });

  it('adopts a complete pre-receipt pair without any download', () => {
    mkdirSync(voices, { recursive: true });
    writeFileSync(onnx(), 'legacy-onnx');
    writeFileSync(`${onnx()}.json`, '{"audio":{"sample_rate":22050}}');
    expect(run().status).toBe(0);
    expect(downloads()).toEqual([]);
    expect(readFileSync(onnx(), 'utf8')).toBe('legacy-onnx');
    expect(inspectVoiceAsset('piper', onnx()).state).toBe('verified');
  });

  describe('Whisper model', () => {
    const model = () => join(models, 'ggml-test.bin');
    const whisperEnv = () => {
      writeFileSync(join(stubDir, 'whisper-server'), '#!/bin/sh\n');
      chmodSync(join(stubDir, 'whisper-server'), 0o755);
      return { STT_ENGINE: 'whisper', TTS_ENGINE: 'qwen3-tts' };
    };

    it('drops a partial download instead of leaving a model at the final path', () => {
      const env = whisperEnv();
      const failed = run({ ...env, CURL_FAIL_MATCH: 'ggml-test.bin' });
      expect(failed.status).toBe(18);
      expect(existsSync(model())).toBe(false);
      expect(leftovers(models)).toEqual([]);
      expect(run(env).status).toBe(0);
      expect(inspectVoiceAsset('whisper', model()).state).toBe('verified');
    });

    it('re-downloads a pre-receipt file whose size differs from the remote one', () => {
      const env = whisperEnv();
      mkdirSync(models, { recursive: true });
      writeFileSync(model(), 'trunc');
      expect(run({ ...env, CURL_REMOTE_SIZE: '9' }).status).toBe(0);
      expect(readFileSync(model(), 'utf8')).toBe('whisper-v1');
    });

    it('adopts a pre-receipt file whose size matches, and leaves it alone when the remote size is unknown', () => {
      const env = whisperEnv();
      mkdirSync(models, { recursive: true });
      writeFileSync(model(), 'custom-model');
      expect(run(env).status).toBe(0);
      expect(downloads()).toEqual([]);
      expect(inspectVoiceAsset('whisper', model()).state).toBe('unverified');
      expect(run({ ...env, CURL_REMOTE_SIZE: String('custom-model'.length) }).status).toBe(0);
      expect(downloads()).toEqual([]);
      expect(readFileSync(model(), 'utf8')).toBe('custom-model');
      expect(inspectVoiceAsset('whisper', model()).state).toBe('verified');
    });
  });
});
