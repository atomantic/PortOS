import { describe, it, expect } from 'vitest';
import { UNSORTED_ID, buildUnsortedCollection } from './unsorted.js';

describe('buildUnsortedCollection', () => {
  it('omits images and videos already filed in a collection', () => {
    const collections = [{
      items: [
        { kind: 'image', ref: 'kept.png' },
        { kind: 'video', ref: 'vid-1' },
      ],
    }];
    const images = [
      { filename: 'kept.png', createdAt: '2026-01-02' },
      { filename: 'loose.png', createdAt: '2026-01-03' },
    ];
    const videos = [
      { id: 'vid-1', createdAt: '2026-01-01' },
      { id: 'vid-2', createdAt: '2026-01-04' },
    ];
    const result = buildUnsortedCollection(collections, images, videos);
    expect(result.id).toBe(UNSORTED_ID);
    expect(result.synthetic).toBe(true);
    expect(result.items.map((i) => `${i.kind}:${i.ref}`)).toEqual([
      'video:vid-2',
      'image:loose.png',
    ]);
  });

  it('treats a missing collections/images/videos list as empty', () => {
    const result = buildUnsortedCollection(null, null, null);
    expect(result.items).toEqual([]);
    expect(result.synthetic).toBe(true);
  });
});
// @vitest-environment node
