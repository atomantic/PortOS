import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  inspectVoiceAsset, isManagedVoiceAsset, isVoiceAssetUsable, verifyVoiceAssetHashes,
  voiceAssetReceiptPath, writeVoiceAssetReceipt,
} from './voiceModelAssets.js';

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
