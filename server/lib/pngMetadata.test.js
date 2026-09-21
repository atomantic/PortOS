import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  extractPngGenerationMetadata,
  normalizeGenerationMetadata,
  parseStableDiffusionParameters,
} from './pngMetadata.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// The parser intentionally does not validate pixel chunks; sharp owns image
// validation. These small chunk fixtures keep the metadata contract focused.
const chunk = (type, data) => {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, body, Buffer.alloc(4)]);
};

const textChunk = (keyword, text) => chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text)]));
const ztxtChunk = (keyword, text) => chunk('zTXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, 0]), deflateSync(Buffer.from(text))]));
const itxtChunk = (keyword, text, compressed = false) => chunk('iTXt', Buffer.concat([
  Buffer.from(keyword, 'utf8'), Buffer.from([0, compressed ? 1 : 0, 0]),
  Buffer.from([0]), Buffer.from([0]), compressed ? deflateSync(Buffer.from(text)) : Buffer.from(text),
]));

describe('parseStableDiffusionParameters', () => {
  it('extracts the prompt, negative prompt, and Automatic1111 settings', () => {
    expect(parseStableDiffusionParameters([
      'a paper boat on a moonlit lake',
      'Negative prompt: blurry, text',
      'Steps: 24, Sampler: DPM++ 2M, CFG scale: 7.5, Seed: 42, Size: 768x512, Model hash: abc123, Model: example-model',
    ].join('\n'))).toEqual({
      format: 'a1111',
      parameters: 'a paper boat on a moonlit lake\nNegative prompt: blurry, text\nSteps: 24, Sampler: DPM++ 2M, CFG scale: 7.5, Seed: 42, Size: 768x512, Model hash: abc123, Model: example-model',
      prompt: 'a paper boat on a moonlit lake',
      negativePrompt: 'blurry, text',
      steps: 24,
      sampler: 'DPM++ 2M',
      cfgScale: 7.5,
      seed: 42,
      width: 768,
      height: 512,
      modelHash: 'abc123',
      model: 'example-model',
    });
  });
});

describe('extractPngGenerationMetadata', () => {
  it('reads tEXt, compressed zTXt, and JSON iTXt metadata without requiring a decoder', () => {
    const parameters = 'a small lighthouse\nNegative prompt: low quality\nSteps: 18, Sampler: Euler a, CFG scale: 6, Seed: 9, Size: 512x512';
    const png = Buffer.concat([
      PNG_SIGNATURE,
      textChunk('parameters', parameters),
      ztxtChunk('negative_prompt', 'low quality, watermark'),
      itxtChunk('sd-metadata', JSON.stringify({ model_name: 'example-sdxl', model_hash: 'deadbeef' }), true),
      chunk('IEND', ''),
    ]);

    expect(extractPngGenerationMetadata(png)).toEqual({
      format: 'a1111',
      parameters,
      prompt: 'a small lighthouse',
      negativePrompt: 'low quality',
      steps: 18,
      sampler: 'Euler a',
      cfgScale: 6,
      seed: 9,
      width: 512,
      height: 512,
      model: 'example-sdxl',
      modelHash: 'deadbeef',
    });
  });

  it('accepts the camel-case negative prompt keyword used by some exporters', () => {
    const png = Buffer.concat([
      PNG_SIGNATURE,
      textChunk('negativePrompt', 'low quality, watermark'),
      chunk('IEND', ''),
    ]);
    expect(extractPngGenerationMetadata(png)).toEqual({ negativePrompt: 'low quality, watermark' });
  });

  it('returns no metadata for non-PNG or malformed chunks', () => {
    expect(extractPngGenerationMetadata(Buffer.from('not a png'))).toEqual({});
    expect(extractPngGenerationMetadata(Buffer.concat([PNG_SIGNATURE, chunk('tEXt', Buffer.from('parameters'))]))).toEqual({});
  });
});

describe('normalizeGenerationMetadata', () => {
  it('maps PortOS sidecar field names to the catalog provenance shape', () => {
    expect(normalizeGenerationMetadata({
      prompt: 'a fox', negativePrompt: 'blurry', guidance: 4, seed: '7',
      width: 640, height: 384, steps: 20, modelId: 'example-model',
    })).toEqual({
      prompt: 'a fox', negativePrompt: 'blurry', cfgScale: 4, seed: 7,
      width: 640, height: 384, steps: 20, model: 'example-model',
    });
  });
});
