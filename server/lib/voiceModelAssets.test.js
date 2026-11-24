import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PIPER_VOICES_HF_COMMIT,
  VOICE_MODEL_SHA256,
  WHISPER_HF_COMMIT,
  inspectVoiceAsset,
  isManagedVoiceAsset,
  isVoiceAssetUsable,
  pinnedVoiceModelSha256,
  piperVoiceBaseUrl,
  verifyVoiceAssetHashes,
  verifyVoiceModelSha256,
  voiceAssetReceiptPath,
  whisperModelUrl,
  writeVoiceAssetReceipt,
} from './voiceModelAssets.js';
import { PIPER_VOICES } from '../services/voice/piper-voices.js';

const CONFIG = JSON.stringify({ audio: { sample_rate: 22050 } });

describe('voice model asset completion contract', () => {
  let dir;
  let onnx;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'voice-assets-'));
    onnx = join(dir, 'voice.onnx');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a Piper model whose sidecar is missing or not a real config', () => {
    expect(inspectVoiceAsset('piper', onnx).state).toBe('missing');
    writeFileSync(onnx, 'onnx-bytes');
    expect(inspectVoiceAsset('piper', onnx)).toMatchObject({ state: 'incomplete', reason: 'sidecar config missing' });
    writeFileSync(`${onnx}.json`, '{"audio":');
    expect(inspectVoiceAsset('piper', onnx).state).toBe('incomplete');
    writeFileSync(`${onnx}.json`, CONFIG);
    expect(inspectVoiceAsset('piper', onnx).state).toBe('unverified');
  });

  it('treats an empty primary file as incomplete, never usable', () => {
    writeFileSync(join(dir, 'ggml.bin'), '');
    const { state } = inspectVoiceAsset('whisper', join(dir, 'ggml.bin'));
    expect(state).toBe('incomplete');
    expect(isVoiceAssetUsable(state)).toBe(false);
  });

  it('keeps a receipted pair verified, then rejects it once a file is truncated', async () => {
    writeFileSync(onnx, 'onnx-bytes');
    writeFileSync(`${onnx}.json`, CONFIG);
    await writeVoiceAssetReceipt('piper', onnx);
    expect(inspectVoiceAsset('piper', onnx).state).toBe('verified');
    writeFileSync(onnx, 'onnx');
    expect(inspectVoiceAsset('piper', onnx)).toMatchObject({ state: 'incomplete', reason: 'voice.onnx does not match its receipt' });
  });

  it('catches a same-size replacement only on the hash pass the scripts run', async () => {
    writeFileSync(onnx, 'AAAAAAAAAA');
    writeFileSync(`${onnx}.json`, CONFIG);
    await writeVoiceAssetReceipt('piper', onnx);
    writeFileSync(onnx, 'BBBBBBBBBB');
    expect(inspectVoiceAsset('piper', onnx).state).toBe('verified');
    expect((await verifyVoiceAssetHashes('piper', onnx)).state).toBe('incomplete');
  });

  it('re-records a receipt over a stale one left by the previous install', async () => {
    writeFileSync(onnx, 'AAAA');
    writeFileSync(`${onnx}.json`, CONFIG);
    await writeVoiceAssetReceipt('piper', onnx);
    writeFileSync(onnx, 'a longer replacement');
    expect(inspectVoiceAsset('piper', onnx).state).toBe('incomplete');
    await writeVoiceAssetReceipt('piper', onnx);
    expect(inspectVoiceAsset('piper', onnx).state).toBe('verified');
    expect(JSON.parse(readFileSync(voiceAssetReceiptPath(onnx), 'utf8')).files).toHaveLength(2);
  });

  it('only treats files directly in the managed directory as the script\'s to replace', () => {
    mkdirSync(join(dir, 'voices'));
    expect(isManagedVoiceAsset(join(dir, 'voices', 'a.onnx'), join(dir, 'voices'))).toBe(true);
    expect(isManagedVoiceAsset(join(dir, 'mine', 'a.onnx'), join(dir, 'voices'))).toBe(false);
    expect(isManagedVoiceAsset(join(dir, 'voices', 'nested', 'a.onnx'), join(dir, 'voices'))).toBe(false);
  });
});

describe('verifyVoiceArchiveSha256', () => {
  it('pins digests for all 10 Piper release archives', async () => {
    const { PIPER_RELEASE_ARCHIVE_SHA256 } = await import('./voiceModelAssets.js');
    expect(Object.keys(PIPER_RELEASE_ARCHIVE_SHA256)).toHaveLength(10);
    expect(Object.isFrozen(PIPER_RELEASE_ARCHIVE_SHA256)).toBe(true);
    for (const digest of Object.values(PIPER_RELEASE_ARCHIVE_SHA256)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a match, rejects a mismatch and unknown names', async () => {
    const { verifyVoiceArchiveSha256 } = await import('./voiceModelAssets.js');
    const archiveDir = mkdtempSync(join(tmpdir(), 'voice-archive-'));
    const file = join(archiveDir, 'a.tar.gz');
    writeFileSync(file, 'archive-ok');
    const good = createHash('sha256').update('archive-ok').digest('hex');
    await expect(verifyVoiceArchiveSha256('a.tar.gz', file, { 'a.tar.gz': good })).resolves.toBeUndefined();
    const table = { 'a.tar.gz': '0'.repeat(64) };
    await expect(verifyVoiceArchiveSha256('a.tar.gz', file, table)).rejects.toThrow(/mismatch/);
    await expect(verifyVoiceArchiveSha256('b.tar.gz', file, table)).rejects.toThrow(/no pinned sha256/);
    await expect(verifyVoiceArchiveSha256('toString', file, table)).rejects.toThrow(/no pinned sha256/);
    rmSync(archiveDir, { recursive: true, force: true });
  });
});

describe('pinned HuggingFace sources and catalog SHA-256 digests', () => {
  it('pins immutable 40-char commit SHAs for Whisper and Piper voice repos', () => {
    expect(WHISPER_HF_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(PIPER_VOICES_HF_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(whisperModelUrl('ggml-base.en.bin')).toBe(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_HF_COMMIT}/ggml-base.en.bin`,
    );
    expect(whisperModelUrl('ggml-base.en-encoder.mlmodelc.zip')).toBe(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_HF_COMMIT}/ggml-base.en-encoder.mlmodelc.zip`,
    );
    expect(piperVoiceBaseUrl('en_GB-jenny_dioco-medium')).toBe(
      `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_HF_COMMIT}/en/en_GB/jenny_dioco/medium`,
    );
    expect(piperVoiceBaseUrl('en_US-custom-speaker-high')).toBe(
      `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_HF_COMMIT}/en/en_US/custom-speaker/high`,
    );
    expect(() => whisperModelUrl('../etc/passwd')).toThrow(/invalid Whisper model filename/);
    expect(() => whisperModelUrl('')).toThrow(/invalid Whisper model filename/);
    expect(() => piperVoiceBaseUrl('en_US')).toThrow(/invalid Piper voice name/);
    expect(() => piperVoiceBaseUrl('en_US--high')).toThrow(/invalid Piper voice name/);
    expect(() => piperVoiceBaseUrl('../en_US-amy-medium')).toThrow(/invalid Piper voice name/);
  });

  it('pins valid SHA-256 digests for curated Whisper, CoreML, and all PIPER_VOICES catalog assets', () => {
    expect(Object.isFrozen(VOICE_MODEL_SHA256)).toBe(true);
    for (const digest of Object.values(VOICE_MODEL_SHA256)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(pinnedVoiceModelSha256('ggml-base.en.bin')).toMatch(/^[0-9a-f]{64}$/);
    expect(pinnedVoiceModelSha256('ggml-large-v3-turbo.bin')).toMatch(/^[0-9a-f]{64}$/);
    expect(pinnedVoiceModelSha256('ggml-base.en-encoder.mlmodelc.zip')).toMatch(/^[0-9a-f]{64}$/);
    expect(pinnedVoiceModelSha256('ggml-large-v3-turbo-encoder.mlmodelc.zip')).toMatch(/^[0-9a-f]{64}$/);
    for (const voice of PIPER_VOICES) {
      expect(pinnedVoiceModelSha256(`${voice.id}.onnx`)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(pinnedVoiceModelSha256('toString')).toBeNull();
  });

  it('verifies catalog matches, rejects mismatches, and skips custom user-named models', async () => {
    const modelDir = mkdtempSync(join(tmpdir(), 'voice-model-sha-'));
    try {
      const file = join(modelDir, 'ggml-base.en.bin');
      writeFileSync(file, 'model-bytes');
      const good = createHash('sha256').update('model-bytes').digest('hex');
      const table = { 'ggml-base.en.bin': good };

      await expect(verifyVoiceModelSha256('ggml-base.en.bin', file, table)).resolves.toEqual({
        verified: true,
        expected: good,
        actual: good,
      });
      await expect(verifyVoiceModelSha256('ggml-base.en.bin', file, { 'ggml-base.en.bin': '0'.repeat(64) }))
        .rejects.toThrow(/mismatch/);
      await expect(verifyVoiceModelSha256('ggml-custom.bin', file, table)).resolves.toEqual({
        verified: false,
        skipped: true,
      });
      await expect(verifyVoiceModelSha256('toString', file, table)).resolves.toEqual({
        verified: false,
        skipped: true,
      });
    } finally {
      rmSync(modelDir, { recursive: true, force: true });
    }
  });
});
