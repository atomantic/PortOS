import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  readSafetensorsHeader,
  detectFlux2VariantFromHeader,
  detectFlux2Variant,
  classifyLoraKeyLayoutFromHeader,
  classifyLoraKeyLayout,
  videoLoraLayoutIssue,
  LORA_KEY_LAYOUTS,
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

describe('classifyLoraKeyLayoutFromHeader', () => {
  it('classifies bare module-path lora_A/lora_B keys', () => {
    expect(classifyLoraKeyLayoutFromHeader({
      'transformer_blocks.0.attn1.to_k.lora_A.weight': { shape: [32, 2048] },
      'transformer_blocks.0.attn1.to_k.lora_B.weight': { shape: [2048, 32] },
    })).toBe(LORA_KEY_LAYOUTS.BARE);
  });

  it('classifies ComfyUI diffusion_model.-prefixed keys', () => {
    expect(classifyLoraKeyLayoutFromHeader({
      'diffusion_model.transformer_blocks.0.attn1.to_k.lora_A.weight': { shape: [32, 2048] },
      'diffusion_model.transformer_blocks.0.attn1.to_k.lora_B.weight': { shape: [2048, 32] },
    })).toBe(LORA_KEY_LAYOUTS.COMFYUI);
  });

  it('classifies diffusers/PEFT wrapper prefixes', () => {
    expect(classifyLoraKeyLayoutFromHeader({
      'transformer.single_transformer_blocks.0.attn.to_out.lora_A.weight': { shape: [32, 3072] },
      'transformer.single_transformer_blocks.0.attn.to_out.lora_B.weight': { shape: [3072, 32] },
    })).toBe(LORA_KEY_LAYOUTS.DIFFUSERS);
    expect(classifyLoraKeyLayoutFromHeader({
      'base_model.model.blocks.0.attn.q.lora_A.weight': { shape: [16, 1024] },
    })).toBe(LORA_KEY_LAYOUTS.DIFFUSERS);
  });

  it('classifies kohya lora_unet_ + lora_down/lora_up keys', () => {
    expect(classifyLoraKeyLayoutFromHeader({
      'lora_unet_transformer_blocks_0_attn1_to_k.alpha': { shape: [] },
      'lora_unet_transformer_blocks_0_attn1_to_k.lora_down.weight': { shape: [32, 2048] },
      'lora_unet_transformer_blocks_0_attn1_to_k.lora_up.weight': { shape: [2048, 32] },
    })).toBe(LORA_KEY_LAYOUTS.KOHYA);
  });

  it('calls a diffusion_model.-prefixed lora_down/lora_up file kohya, not comfyui', () => {
    // Real-world shape: the ComfyUI prefix is present but the rank pair is
    // kohya's, so an lora_A/lora_B fuser matches nothing.
    expect(classifyLoraKeyLayoutFromHeader({
      'diffusion_model.transformer_blocks.0.attn1.to_k.alpha': { shape: [] },
      'diffusion_model.transformer_blocks.0.attn1.to_k.lora_down.weight': { shape: [32, 2048] },
      'diffusion_model.transformer_blocks.0.attn1.to_k.lora_up.weight': { shape: [2048, 32] },
    })).toBe(LORA_KEY_LAYOUTS.KOHYA);
  });

  it('picks the dominant layout in a mixed-layout file', () => {
    const header = {
      'diffusion_model.transformer_blocks.0.attn1.to_k.lora_down.weight': { shape: [32, 2048] },
      'diffusion_model.transformer_blocks.0.attn1.to_k.lora_up.weight': { shape: [2048, 32] },
      'lora_unet_transformer_blocks_0_attn1_to_k.lora_down.weight': { shape: [32, 2048] },
      'lora_unet_transformer_blocks_0_attn1_to_k.lora_up.weight': { shape: [2048, 32] },
      'diffusion_model.transformer_blocks.1.attn1.to_k.lora_A.weight': { shape: [32, 2048] },
    };
    expect(classifyLoraKeyLayoutFromHeader(header)).toBe(LORA_KEY_LAYOUTS.KOHYA);
  });

  it('returns not_a_lora for a header with no LoRA tensors', () => {
    expect(classifyLoraKeyLayoutFromHeader({
      'transformer_blocks.0.attn1.to_k.weight': { shape: [2048, 2048] },
      __metadata__: { format: 'pt' },
    })).toBe(LORA_KEY_LAYOUTS.NOT_A_LORA);
  });

  it('returns null (undetermined, NOT not_a_lora) for an unparsable header', () => {
    expect(classifyLoraKeyLayoutFromHeader(null)).toBeNull();
    expect(classifyLoraKeyLayoutFromHeader('nope')).toBeNull();
  });
});

describe('classifyLoraKeyLayout (file)', () => {
  it('reads + classifies in one call', async () => {
    const p = writeTmp('comfy.safetensors', makeFile({
      'diffusion_model.transformer_blocks.0.attn1.to_k.lora_A.weight': { shape: [32, 2048] },
    }));
    expect(await classifyLoraKeyLayout(p)).toBe(LORA_KEY_LAYOUTS.COMFYUI);
  });

  it('returns null for a non-safetensors file', async () => {
    const p = writeTmp('garbage.safetensors', Buffer.from('garbage'));
    expect(await classifyLoraKeyLayout(p)).toBeNull();
  });
});

describe('videoLoraLayoutIssue', () => {
  it('passes the two fusable layouts', () => {
    expect(videoLoraLayoutIssue(LORA_KEY_LAYOUTS.BARE)).toBeNull();
    expect(videoLoraLayoutIssue(LORA_KEY_LAYOUTS.COMFYUI)).toBeNull();
  });

  it('is permissive when the layout is undetermined', () => {
    expect(videoLoraLayoutIssue(null)).toBeNull();
    expect(videoLoraLayoutIssue(undefined)).toBeNull();
  });

  it('names the layout and the reason for un-fusable files', () => {
    expect(videoLoraLayoutIssue(LORA_KEY_LAYOUTS.KOHYA)).toMatch(/kohya/i);
    expect(videoLoraLayoutIssue(LORA_KEY_LAYOUTS.DIFFUSERS)).toMatch(/diffusers/i);
    expect(videoLoraLayoutIssue(LORA_KEY_LAYOUTS.NOT_A_LORA)).toMatch(/no LoRA tensors/i);
  });
});
