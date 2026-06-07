/**
 * Pure row-transform tests for the media asset index logic. No I/O — these lock
 * the mediaKey vocabulary, the verbatim `data` passthrough, and the bind-safe
 * createdAt mirror that the reconcile pass and the live hook both depend on.
 */

import { describe, it, expect } from 'vitest';
import { imageToRow, videoToRow } from './logic.js';

describe('imageToRow', () => {
  it('builds an image:<filename> row with the metadata stored verbatim', () => {
    const item = { filename: 'abc.png', prompt: 'a cat', createdAt: '2026-01-02T03:04:05.000Z', seed: 7 };
    const row = imageToRow(item);
    expect(row).toEqual({
      mediaKey: 'image:abc.png',
      kind: 'image',
      ref: 'abc.png',
      data: item,
      createdAt: '2026-01-02T03:04:05.000Z',
    });
  });
  it('falls back to `now` when createdAt is missing/invalid (bind-safe column)', () => {
    expect(imageToRow({ filename: 'x.png' }, { now: 'fb' }).createdAt).toBe('fb');
    expect(imageToRow({ filename: 'x.png', createdAt: 'not-a-date' }, { now: 'fb' }).createdAt).toBe('fb');
    // Out-of-range calendar date normalizes (Feb 31 → Mar 3) so PG accepts it.
    expect(imageToRow({ filename: 'x.png', createdAt: '2026-02-31T00:00:00.000Z' }, { now: 'fb' }).createdAt)
      .toBe('2026-03-03T00:00:00.000Z');
  });
  it('returns null when there is no usable filename', () => {
    expect(imageToRow(null)).toBeNull();
    expect(imageToRow({})).toBeNull();
    expect(imageToRow({ filename: '' })).toBeNull();
    expect(imageToRow({ filename: 123 })).toBeNull();
  });
});

describe('videoToRow', () => {
  it('builds a video:<id> row keyed on the job id, not the filename', () => {
    const entry = { id: 'job-1', filename: 'job-1.mp4', prompt: 'a ball', createdAt: '2026-01-02T03:04:05.000Z' };
    const row = videoToRow(entry);
    expect(row).toEqual({
      mediaKey: 'video:job-1',
      kind: 'video',
      ref: 'job-1',
      data: entry,
      createdAt: '2026-01-02T03:04:05.000Z',
    });
  });
  it('falls back to `now` for a missing/invalid createdAt', () => {
    expect(videoToRow({ id: 'job-2' }, { now: 'fb' }).createdAt).toBe('fb');
  });
  it('returns null when there is no usable id', () => {
    expect(videoToRow(null)).toBeNull();
    expect(videoToRow({ filename: 'x.mp4' })).toBeNull();
    expect(videoToRow({ id: '' })).toBeNull();
  });
});
