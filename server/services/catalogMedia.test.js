import { describe, it, expect, vi } from 'vitest';
import { catalogSyncEnvelopeSchema } from '../lib/catalogValidation.js';
import { GENERATION_METADATA_LIMITS } from '../lib/pngMetadata.js';
import {
  classifyUploadMime,
  readImageGenerationMetadata,
  uploadIngredientMediaFile,
  recordIngredientVoiceMemo,
} from './catalogMedia.js';

describe('classifyUploadMime', () => {
  it('classifies images to the reference kind', () => {
    expect(classifyUploadMime('image/png')).toEqual({ category: 'image', kind: 'reference', ext: 'png' });
    expect(classifyUploadMime('image/jpeg')).toEqual({ category: 'image', kind: 'reference', ext: 'png' });
  });

  it('classifies audio and strips a codecs parameter', () => {
    expect(classifyUploadMime('audio/wav')).toEqual({ category: 'audio', kind: 'audio', ext: 'wav' });
    expect(classifyUploadMime('audio/webm;codecs=opus')).toEqual({ category: 'audio', kind: 'audio', ext: 'webm' });
    expect(classifyUploadMime('audio/mpeg')).toEqual({ category: 'audio', kind: 'audio', ext: 'mp3' });
  });

  it('classifies video with a container fallback for unknown subtypes', () => {
    expect(classifyUploadMime('video/mp4')).toEqual({ category: 'video', kind: 'video', ext: 'mp4' });
    expect(classifyUploadMime('video/x-matroska')).toEqual({ category: 'video', kind: 'video', ext: 'mp4' });
  });

  it('returns null for unsupported / missing MIME (documents do not federate)', () => {
    expect(classifyUploadMime('application/pdf')).toBeNull();
    expect(classifyUploadMime('text/plain')).toBeNull();
    expect(classifyUploadMime('')).toBeNull();
    expect(classifyUploadMime(undefined)).toBeNull();
  });
});

const okIngredient = () => ({ id: 'ing-1', name: 'Test' });
const b64 = (s) => Buffer.from(s).toString('base64');

describe('uploadIngredientMediaFile', () => {
  it('routes an image through the gallery saver and attaches as reference', async () => {
    const saveImageFn = vi.fn().mockResolvedValue({ filename: 'upload-abcd1234.png' });
    const attachMediaFn = vi.fn().mockResolvedValue({ mediaKey: 'upload-abcd1234.png', kind: 'reference' });
    const persistFileFn = vi.fn();
    const media = await uploadIngredientMediaFile(
      { ingredientId: 'ing-1', dataBase64: b64('img'), mimeType: 'image/png', filename: 'pic.png' },
      { getIngredientFn: okIngredient, attachMediaFn, saveImageFn, persistFileFn },
    );
    expect(saveImageFn).toHaveBeenCalledWith(b64('img'));
    expect(persistFileFn).not.toHaveBeenCalled();
    expect(attachMediaFn).toHaveBeenCalledWith('ing-1', 'upload-abcd1234.png', 'reference', { role: null, caption: null });
    expect(media).toEqual({ mediaKey: 'upload-abcd1234.png', kind: 'reference' });
  });

  it('persists extracted generation provenance when the gallery saver returns it', async () => {
    const metadata = { format: 'a1111', prompt: 'a paper boat', negativePrompt: 'blurry', steps: 24, seed: 42 };
    const saveImageFn = vi.fn().mockResolvedValue({ filename: 'upload-provenance.png', metadata });
    const attachMediaFn = vi.fn().mockResolvedValue({ mediaKey: 'upload-provenance.png', kind: 'reference', metadata });
    await uploadIngredientMediaFile(
      { ingredientId: 'ing-1', dataBase64: b64('img'), mimeType: 'image/png' },
      { getIngredientFn: okIngredient, attachMediaFn, saveImageFn },
    );
    expect(attachMediaFn).toHaveBeenCalledWith(
      'ing-1', 'upload-provenance.png', 'reference', { role: null, caption: null, metadata },
    );
  });

  it('bounds uploaded provenance to the peer contract, including escaped JSON size', async () => {
    const metadata = {
      format: 'format'.repeat(30), parameters: '\u0001'.repeat(65_536),
      prompt: 'p'.repeat(16_001), negativePrompt: 'n'.repeat(16_001),
      sampler: 's'.repeat(300), modelHash: 'h'.repeat(300), model: 'm'.repeat(600),
      seed: 'seed'.repeat(40), steps: 100_001, cfgScale: 1_001,
      width: 100_001, height: false,
    };
    const media = await uploadIngredientMediaFile(
      { ingredientId: 'ing-1', dataBase64: b64('img'), mimeType: 'image/png' },
      {
        getIngredientFn: okIngredient,
        saveImageFn: async () => ({ filename: 'upload-provenance.png', metadata }),
        attachMediaFn: async (ingredientId, mediaKey, kind, options) => ({
          ingredientId, mediaKey, kind, ...options, createdAt: '2026-01-01T00:00:00Z',
        }),
      },
    );
    expect(catalogSyncEnvelopeSchema.parse({ media: [media] }).media[0]).toEqual(media);
    expect(media.metadata.prompt).toBe('p'.repeat(GENERATION_METADATA_LIMITS.prompt));
    expect(media.metadata.negativePrompt).toBe('n'.repeat(GENERATION_METADATA_LIMITS.negativePrompt));
    expect(media.metadata.parameters).toBeTruthy();
    expect(JSON.stringify(media.metadata).length).toBeLessThanOrEqual(GENERATION_METADATA_LIMITS.jsonChars);
    for (const field of ['steps', 'cfgScale', 'width', 'height']) expect(media.metadata).not.toHaveProperty(field);
  });

  it('persists audio bytes to the library dir and attaches as audio', async () => {
    const persistFileFn = vi.fn().mockResolvedValue('upload-11112222.webm');
    const attachMediaFn = vi.fn().mockImplementation((id, key, kind) => ({ mediaKey: key, kind }));
    await uploadIngredientMediaFile(
      { ingredientId: 'ing-1', dataBase64: b64('audiobytes'), mimeType: 'audio/webm', filename: 'clip.webm', role: 'sfx' },
      { getIngredientFn: okIngredient, attachMediaFn, saveImageFn: vi.fn(), persistFileFn },
    );
    expect(persistFileFn).toHaveBeenCalledTimes(1);
    const [buffer, , ext] = persistFileFn.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(ext).toBe('webm');
    expect(attachMediaFn).toHaveBeenCalledWith('ing-1', 'upload-11112222.webm', 'audio', { role: 'sfx', caption: null });
  });

  it('rejects an unsupported MIME with a 422', async () => {
    await expect(uploadIngredientMediaFile(
      { ingredientId: 'ing-1', dataBase64: b64('doc'), mimeType: 'application/pdf' },
      { getIngredientFn: okIngredient, attachMediaFn: vi.fn(), saveImageFn: vi.fn(), persistFileFn: vi.fn() },
    )).rejects.toMatchObject({ status: 422 });
  });

  it('404s when the ingredient is missing', async () => {
    await expect(uploadIngredientMediaFile(
      { ingredientId: 'nope', dataBase64: b64('x'), mimeType: 'image/png' },
      { getIngredientFn: async () => null, attachMediaFn: vi.fn(), saveImageFn: vi.fn(), persistFileFn: vi.fn() },
    )).rejects.toMatchObject({ status: 404 });
  });

  it('rejects empty (all-whitespace-decoding) file bytes for non-image kinds', async () => {
    await expect(uploadIngredientMediaFile(
      { ingredientId: 'ing-1', dataBase64: '', mimeType: 'audio/wav' },
      { getIngredientFn: okIngredient, attachMediaFn: vi.fn(), saveImageFn: vi.fn(), persistFileFn: vi.fn() },
    )).rejects.toMatchObject({ status: 400 });
  });
});

describe('readImageGenerationMetadata', () => {
  it('normalizes sidecar provenance and prefers it over the PNG fallback', async () => {
    const readFileFn = vi.fn();
    const metadata = await readImageGenerationMetadata('render.png', {
      readSidecarFn: async () => ({ metadata: { prompt: 'a fox', guidance: 4, modelId: 'example-model' } }),
      readFileFn,
      resolveImagePathFn: () => '/images/render.png',
    });
    expect(metadata).toEqual({ prompt: 'a fox', cfgScale: 4, model: 'example-model' });
    expect(readFileFn).not.toHaveBeenCalled();
  });

  it('returns no provenance when neither sidecar nor image is readable', async () => {
    await expect(readImageGenerationMetadata('missing.png', {
      readSidecarFn: async () => ({ metadata: {} }),
      resolveImagePathFn: () => null,
    })).resolves.toEqual({});
  });
});

describe('recordIngredientVoiceMemo', () => {
  it('transcribes, persists audio, and attaches with the transcript in caption', async () => {
    const transcribeFn = vi.fn().mockResolvedValue({ text: '  hello world  ' });
    const persistFileFn = vi.fn().mockResolvedValue('voice-xyz.wav');
    const attachMediaFn = vi.fn().mockImplementation((id, key, kind, meta) => ({ mediaKey: key, kind, ...meta }));
    const { media, transcript } = await recordIngredientVoiceMemo(
      { ingredientId: 'ing-1', audioBase64: b64('wavbytes'), mimeType: 'audio/wav' },
      { getIngredientFn: okIngredient, attachMediaFn, transcribeFn, persistFileFn },
    );
    expect(transcript).toBe('hello world');
    // Persist happens AFTER transcription.
    expect(transcribeFn).toHaveBeenCalledTimes(1);
    expect(persistFileFn).toHaveBeenCalledTimes(1);
    expect(attachMediaFn).toHaveBeenCalledWith('ing-1', 'voice-xyz.wav', 'audio', { role: 'voice-memo', caption: 'hello world' });
    expect(media.caption).toBe('hello world');
  });

  it('still attaches the audio when the transcript is empty (caption null)', async () => {
    const attachMediaFn = vi.fn().mockImplementation((id, key, kind, meta) => ({ mediaKey: key, kind, ...meta }));
    await recordIngredientVoiceMemo(
      { ingredientId: 'ing-1', audioBase64: b64('wav'), mimeType: 'audio/wav' },
      { getIngredientFn: okIngredient, attachMediaFn, transcribeFn: async () => ({ text: '   ' }), persistFileFn: async () => 'voice-empty.wav' },
    );
    expect(attachMediaFn).toHaveBeenCalledWith('ing-1', 'voice-empty.wav', 'audio', { role: 'voice-memo', caption: null });
  });

  it('does not persist audio when transcription throws (no orphan file)', async () => {
    const persistFileFn = vi.fn();
    await expect(recordIngredientVoiceMemo(
      { ingredientId: 'ing-1', audioBase64: b64('wav'), mimeType: 'audio/wav' },
      { getIngredientFn: okIngredient, attachMediaFn: vi.fn(), transcribeFn: async () => { throw new Error('whisper down'); }, persistFileFn },
    )).rejects.toThrow('whisper down');
    expect(persistFileFn).not.toHaveBeenCalled();
  });

  it('rejects empty audio with a 400', async () => {
    await expect(recordIngredientVoiceMemo(
      { ingredientId: 'ing-1', audioBase64: '', mimeType: 'audio/wav' },
      { getIngredientFn: okIngredient, attachMediaFn: vi.fn(), transcribeFn: vi.fn(), persistFileFn: vi.fn() },
    )).rejects.toMatchObject({ status: 400 });
  });
});
