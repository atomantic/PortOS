import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  readSafetensorsHeader,
  detectFlux2VariantFromHeader,
  detectFlux2Variant,
} from './safetensors.js';

// Build a valid safetensors file buffer from a header object: 8-byte LE u64
// header length + UTF-8 JSON + a tiny fake payload byte.
const makeFile = (header) => {
  const json = Buffer.from(JSON.stringify(header), 'utf-8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length), 0);
  return Buffer.concat([len, json, Buffer.from([0])]);
};

let tmpRoot;
const writeTmp = (name, buf) => {
  if (!tmpRoot) tmpRoot = mkdtempSync(join(tmpdir(), 'portos-safetensors-'));
  const p = join(tmpRoot, name);
  writeFileSync(p, buf);
  return p;
};

afterEach(() => {
  if (tmpRoot) { rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = null; }
});

describe('readSafetensorsHeader', () => {
  it('parses a well-formed header', async () => {
    const header = { 'foo.weight': { dtype: 'F16', shape: [3072, 32], data_offsets: [0, 1] } };
    const p = writeTmp('ok.safetensors', makeFile(header));
    expect(await readSafetensorsHeader(p)).toEqual(header);
  });

  it('returns null for a missing file', async () => {
    expect(await readSafetensorsHeader(join(tmpdir(), 'does-not-exist.safetensors'))).toBeNull();
  });

  it('returns null for a truncated / non-safetensors blob', async () => {
    const p = writeTmp('junk.safetensors', Buffer.from('not safetensors'));
    expect(await readSafetensorsHeader(p)).toBeNull();
  });

  it('returns null when the declared header length is absurd', async () => {
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(500 * 1024 * 1024), 0); // > MAX_HEADER_BYTES
    const p = writeTmp('huge.safetensors', Buffer.concat([len, Buffer.from('{}')]));
    expect(await readSafetensorsHeader(p)).toBeNull();
  });
});

describe('detectFlux2VariantFromHeader', () => {
  it('detects 9B from a 4096/16384-dim transformer tensor', () => {
    const header = {
      'transformer.single_transformer_blocks.19.attn.to_out.lora_A.weight': { shape: [32, 16384] },
      'transformer.single_transformer_blocks.19.attn.to_out.lora_B.weight': { shape: [4096, 32] },
    };
    expect(detectFlux2VariantFromHeader(header)).toBe('9b');
  });

  it('detects 4B from a 3072/12288-dim transformer tensor', () => {
    const header = {
      'transformer.single_transformer_blocks.0.attn.to_out.lora_A.weight': { shape: [32, 12288] },
      'transformer.single_transformer_blocks.0.attn.to_out.lora_B.weight': { shape: [3072, 32] },
    };
    expect(detectFlux2VariantFromHeader(header)).toBe('4b');
  });

  it('ignores text-encoder tensors so T5\'s 4096 dim does not false-positive 9B', () => {
    // A 4B LoRA that also trains the T5 text encoder (hidden dim 4096). Only
    // the transformer_blocks tensors should decide the variant.
    const header = {
      'text_encoder_2.encoder.block.0.layer.0.SelfAttention.q.lora_A.weight': { shape: [16, 4096] },
      'transformer.single_transformer_blocks.0.attn.to_q.lora_B.weight': { shape: [3072, 16] },
    };
    expect(detectFlux2VariantFromHeader(header)).toBe('4b');
  });

  it('returns null when no transformer-block tensor identifies a dim', () => {
    expect(detectFlux2VariantFromHeader({ 'vae.weight': { shape: [8, 8] } })).toBeNull();
    expect(detectFlux2VariantFromHeader({ __metadata__: { foo: 'bar' } })).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(detectFlux2VariantFromHeader(null)).toBeNull();
    expect(detectFlux2VariantFromHeader('nope')).toBeNull();
  });

  it('refuses to guess when both variants appear', () => {
    const header = {
      'transformer.single_transformer_blocks.0.attn.to_out.lora_A.weight': { shape: [32, 16384] },
      'transformer.single_transformer_blocks.1.attn.to_out.lora_A.weight': { shape: [32, 12288] },
    };
    expect(detectFlux2VariantFromHeader(header)).toBeNull();
  });
});

describe('detectFlux2Variant (file)', () => {
  it('reads + classifies in one call', async () => {
    const p = writeTmp('9b.safetensors', makeFile({
      'transformer.single_transformer_blocks.0.attn.to_out.lora_A.weight': { shape: [32, 16384] },
    }));
    expect(await detectFlux2Variant(p)).toBe('9b');
  });

  it('returns null for a non-safetensors file', async () => {
    const p = writeTmp('bad.safetensors', Buffer.from('garbage'));
    expect(await detectFlux2Variant(p)).toBeNull();
  });
});
