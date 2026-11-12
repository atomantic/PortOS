import { describe, it, expect } from 'vitest';
import { buildCompositeBoardRecord } from './compositeRecord.js';

const sources = () => [
  { id: 'a', name: 'Ink', style: { prompt: 'Ink washes', negativePrompt: 'plastic' }, posterImageRef: 'old.png', pinterest: { feedUrl: 'old' }, items: [
    { id: 'pin', type: 'image', mediaKey: 'image:ink.png', analysis: { prompt: 'Brush strokes' } },
  ] },
  { id: 'b', name: 'Neon', style: { prompt: 'Neon light', negativePrompt: 'daylight' }, items: [
    { id: 'pin', type: 'text', text: 'Blue shadows', render: { status: 'queued', jobId: 'old' } },
    { id: 'video', type: 'video', mediaKey: 'video:light.mp4' },
  ] },
];

describe('composite board record', () => {
  it('starts empty with only the synthesized style, independently of source pins and jobs', () => {
    const boards = sources();
    boards[0].items = Array.from({ length: 500 }, () => boards[0].items[0]);
    const before = structuredClone(boards);
    const composite = buildCompositeBoardRecord({ name: 'Ink + Neon', style: { prompt: 'Luminous ink washes' } }, boards, { id: 'new' });
    expect(composite.name).toBe('Ink + Neon');
    expect(composite.style.prompt).toBe('Luminous ink washes');
    expect(composite.items).toEqual([]);
    expect(composite.posterImageRef).toBeUndefined();
    expect(composite.pinterest).toBeUndefined();
    expect(boards).toEqual(before);
  });
});
