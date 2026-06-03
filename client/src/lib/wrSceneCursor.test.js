import { describe, it, expect } from 'vitest';
import { sceneAnchorIndex, sceneAtCursor } from './wrSceneCursor.js';

const BODY = [
  '# Chapter One',
  '',
  '## The arrival',
  'She stepped off the train into the rain.',
  '',
  '## The market',
  'Stalls lined the square, loud and bright.',
].join('\n');

const SCENES = [
  { id: 's1', heading: 'The arrival', summary: 'She stepped off the train', visualPrompt: 'a' },
  { id: 's2', heading: 'The market', summary: 'Stalls lined the square', visualPrompt: 'b' },
];

describe('sceneAnchorIndex', () => {
  it('locates a scene by its markdown heading', () => {
    const idx = sceneAnchorIndex(BODY, SCENES[1]);
    expect(idx).toBe(BODY.indexOf('## The market'));
  });

  it('falls back to a summary snippet when the heading is absent', () => {
    const scene = { heading: 'Nowhere in the body', summary: 'Stalls lined the square' };
    const idx = sceneAnchorIndex(BODY, scene);
    expect(idx).toBe(BODY.indexOf('Stalls lined the square'));
  });

  it('returns -1 when nothing matches', () => {
    expect(sceneAnchorIndex(BODY, { heading: 'Ghost', summary: 'no such text' })).toBe(-1);
    expect(sceneAnchorIndex('', SCENES[0])).toBe(-1);
    expect(sceneAnchorIndex(BODY, null)).toBe(-1);
  });
});

describe('sceneAtCursor', () => {
  it('returns the scene whose anchor is the greatest index <= the caret', () => {
    // Caret inside the second scene's prose.
    const caret = BODY.indexOf('Stalls lined') + 5;
    const hit = sceneAtCursor(SCENES, BODY, caret);
    expect(hit?.scene.id).toBe('s2');
    expect(hit?.sceneNumber).toBe(2); // 1-based index in the scenes array
  });

  it('returns the first scene when the caret sits in its prose', () => {
    const caret = BODY.indexOf('She stepped') + 3;
    const hit = sceneAtCursor(SCENES, BODY, caret);
    expect(hit?.scene.id).toBe('s1');
    expect(hit?.sceneNumber).toBe(1);
  });

  it('returns null when the caret is before the first locatable scene', () => {
    const hit = sceneAtCursor(SCENES, BODY, 2); // inside "# Chapter One"
    expect(hit).toBeNull();
  });

  it('returns null for empty inputs', () => {
    expect(sceneAtCursor([], BODY, 10)).toBeNull();
    expect(sceneAtCursor(SCENES, '', 10)).toBeNull();
    expect(sceneAtCursor(null, BODY, 10)).toBeNull();
  });

  it('defaults a non-finite offset to end-of-body (last scene wins)', () => {
    const hit = sceneAtCursor(SCENES, BODY, undefined);
    expect(hit?.scene.id).toBe('s2');
  });
});
