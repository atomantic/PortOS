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
});

describe('moodBoardItemUpdateSchema', () => {
  it('accepts a caption-only patch', () => {
    expect(moodBoardItemUpdateSchema.parse({ caption: 'c' }).caption).toBe('c');
  });
  it('accepts a null caption (clear)', () => {
    expect(moodBoardItemUpdateSchema.parse({ caption: null }).caption).toBeNull();
  });
});
