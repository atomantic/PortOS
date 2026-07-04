import { describe, it, expect, vi } from 'vitest';
import {
  classifyUploadMime,
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
