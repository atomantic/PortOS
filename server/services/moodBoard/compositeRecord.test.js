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

describe('composite board snapshot', () => {
  it('preserves both styles, media references and analyses without sharing identities or active jobs', () => {
    const boards = sources();
    const before = structuredClone(boards);
    const composite = buildCompositeBoardRecord({ name: 'Ink + Neon' }, boards, { id: 'new' });
    expect(composite.name).toBe('Ink + Neon');
    expect(composite.style.prompt).toBe('Ink:\nInk washes\n\nNeon:\nNeon light');
    expect(composite.style.negativePrompt).toBe('plastic\n\ndaylight');
    expect(composite.items.map(item => item.type)).toEqual(['image', 'text', 'video']);
    expect(new Set(composite.items.map(item => item.id)).size).toBe(3);
    expect(composite.items[0]).toMatchObject({ mediaKey: 'image:ink.png', analysis: { prompt: 'Brush strokes' } });
    expect(composite.items[1].render).toBeUndefined();
    expect(composite.posterImageRef).toBeUndefined();
    expect(composite.pinterest).toBeUndefined();
    composite.items[0].analysis.prompt = 'Changed';
    expect(boards).toEqual(before);
  });

  it('combines boards without saved styles for later analysis', () => {
    const boards = sources().map(({ style: _style, ...board }) => board);
    const composite = buildCompositeBoardRecord({ name: 'Unanalyzed' }, boards, { id: 'new' });
    expect(composite.items).toHaveLength(3);
    expect(composite.style).toBeUndefined();
  });

  it('refuses oversized pins or prompts instead of silently dropping source material', () => {
    const boards = sources();
    boards[0].items = Array.from({ length: 500 }, () => boards[0].items[0]);
    expect(() => buildCompositeBoardRecord({ name: 'Too many' }, boards, { id: 'new' })).toThrow('500 pins');
    const styled = sources();
    styled[0].style.prompt = 'a'.repeat(8000);
    expect(() => buildCompositeBoardRecord({ name: 'Too long' }, styled, { id: 'new' })).toThrow('8,000 characters');
  });
});
