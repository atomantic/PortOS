/**
 * Schema tests for mood board validation (issue #911). Locks the cross-field
 * item rules (image requires mediaKey|imageUrl; text requires non-empty text)
 * and the URL/media-key shape guards the route boundary relies on.
 */

import { describe, it, expect } from 'vitest';
import {
  moodBoardCreateSchema,
  moodBoardUpdateSchema,
  moodBoardItemCreateSchema,
  moodBoardItemUpdateSchema,
  isVideoItemMediaKey,
} from './moodBoardValidation.js';

describe('moodBoardCreateSchema', () => {
  it('accepts a name + optional description', () => {
    expect(moodBoardCreateSchema.parse({ name: 'Refs' }).name).toBe('Refs');
    expect(moodBoardCreateSchema.parse({ name: 'Refs', description: 'd' }).description).toBe('d');
  });
  it('rejects an empty name', () => {
    expect(moodBoardCreateSchema.safeParse({ name: '' }).success).toBe(false);
  });
  it('rejects unknown keys (strict)', () => {
    expect(moodBoardCreateSchema.safeParse({ name: 'x', items: [] }).success).toBe(false);
  });
});

describe('moodBoardUpdateSchema', () => {
  it('accepts a partial patch', () => {
    expect(moodBoardUpdateSchema.parse({ description: '' }).description).toBe('');
  });
});

describe('moodBoardItemCreateSchema', () => {
  it('accepts an image item with imageUrl', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'image', imageUrl: 'https://x/y.png' }).success).toBe(true);
  });
  it('accepts an image item with an app-path imageUrl', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'image', imageUrl: '/data/images/a.png' }).success).toBe(true);
  });
  it('accepts an image item with a mediaKey', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'image', mediaKey: 'image:a.png' }).success).toBe(true);
  });
  it('rejects an image item with neither mediaKey nor imageUrl', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'image' }).success).toBe(false);
  });
  it('rejects a bad imageUrl scheme', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'image', imageUrl: 'javascript:alert(1)' }).success).toBe(false);
  });
  it('rejects a protocol-relative imageUrl', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'image', imageUrl: '//evil.com/x.png' }).success).toBe(false);
  });
  it('rejects a malformed mediaKey', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'image', mediaKey: 'no-colon' }).success).toBe(false);
  });
  it('accepts a text item with text', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'text', text: 'note' }).success).toBe(true);
  });
  it('rejects a text item with blank text', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'text', text: '   ' }).success).toBe(false);
  });
  it('accepts a video item with a video mediaKey (#4188)', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'video', mediaKey: 'video:upload-ab12cd34.mp4' }).success).toBe(true);
  });
  it('accepts a video item with a poster imageUrl alongside the mediaKey', () => {
    expect(moodBoardItemCreateSchema.safeParse({
      type: 'video', mediaKey: 'video:a.mp4', imageUrl: '/data/video-thumbnails/a.jpg',
    }).success).toBe(true);
  });
  it('rejects a video item without a mediaKey', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'video', imageUrl: '/data/video-thumbnails/a.jpg' }).success).toBe(false);
  });
  it('rejects a video item whose mediaKey is not kind video', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'video', mediaKey: 'image:a.png' }).success).toBe(false);
  });
  it('rejects a video item whose ref is a bare id (no extension) — it would 404 as a filename', () => {
    expect(moodBoardItemCreateSchema.safeParse({ type: 'video', mediaKey: 'video:job-123' }).success).toBe(false);
  });
});

describe('isVideoItemMediaKey', () => {
  it('accepts a filename-with-extension video key', () => {
    expect(isVideoItemMediaKey('video:upload-ab12cd34.mp4')).toBe(true);
    expect(isVideoItemMediaKey('video:clip.webm')).toBe(true);
  });
  it('rejects non-video kinds, extension-less refs, and traversal shapes', () => {
    expect(isVideoItemMediaKey('image:a.png')).toBe(false);
    expect(isVideoItemMediaKey('video:job-123')).toBe(false);
    expect(isVideoItemMediaKey('video:..')).toBe(false);
    expect(isVideoItemMediaKey('video:a/b.mp4')).toBe(false);
    expect(isVideoItemMediaKey('video:a\\b.mp4')).toBe(false);
    expect(isVideoItemMediaKey(null)).toBe(false);
    expect(isVideoItemMediaKey('')).toBe(false);
  });
});

describe('moodBoardItemUpdateSchema', () => {
  it('accepts a caption-only patch', () => {
    expect(moodBoardItemUpdateSchema.parse({ caption: 'c' }).caption).toBe('c');
  });
  it('accepts a null caption (clear)', () => {
    expect(moodBoardItemUpdateSchema.parse({ caption: null }).caption).toBeNull();
  });
  it('accepts a full and a minimal analysis patch (#4188 Phase 3)', () => {
    const full = moodBoardItemUpdateSchema.parse({
      analysis: {
        prompt: 'a moody castle at dusk',
        negativePrompt: 'blurry',
        rationale: 'gothic look',
        providerId: 'openai',
        model: 'gpt-4o',
        analyzedAt: '2026-08-14T00:00:00.000Z',
      },
    });
    expect(full.analysis.prompt).toBe('a moody castle at dusk');
    expect(moodBoardItemUpdateSchema.parse({ analysis: { prompt: 'p' } }).analysis.prompt).toBe('p');
  });
  it('accepts a null analysis (clear)', () => {
    expect(moodBoardItemUpdateSchema.parse({ analysis: null }).analysis).toBeNull();
  });
  it('rejects an analysis without a prompt, with unknown keys, or with a non-ISO analyzedAt', () => {
    expect(() => moodBoardItemUpdateSchema.parse({ analysis: {} })).toThrow();
    expect(() => moodBoardItemUpdateSchema.parse({ analysis: { prompt: '   ' } })).toThrow();
    expect(() => moodBoardItemUpdateSchema.parse({ analysis: { prompt: 'p', extra: true } })).toThrow();
    expect(() => moodBoardItemUpdateSchema.parse({ analysis: { prompt: 'p', analyzedAt: 'yesterday' } })).toThrow();
  });
});
