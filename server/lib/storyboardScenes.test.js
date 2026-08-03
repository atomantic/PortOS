import { describe, it, expect } from 'vitest';
import { ensureStoryboardIds, resolveStoryboardTarget, sceneIdForIndex, shotIdForIndex } from './storyboardScenes.js';

describe('ensureStoryboardIds', () => {
  it('stamps deterministic ids on scenes that lack one', () => {
    const scenes = [{ description: 'a' }, { description: 'b' }];
    const out = ensureStoryboardIds(scenes);
    expect(out.map((s) => s.id)).toEqual(['scene-01', 'scene-02']);
    // Two independent readers of the same un-migrated record must agree.
    expect(ensureStoryboardIds(structuredClone(scenes)).map((s) => s.id)).toEqual(out.map((s) => s.id));
  });

  it('stamps shot ids inside each scene', () => {
    const out = ensureStoryboardIds([{ description: 'a', shots: [{ description: 's1' }, { id: 'kept', description: 's2' }] }]);
    expect(out[0].shots.map((s) => s.id)).toEqual(['shot-01', 'kept']);
  });

  it('leaves existing ids alone and returns the SAME array reference when nothing changed', () => {
    const scenes = [{ id: 'custom-a', description: 'a' }, { id: 'custom-b', description: 'b', shots: [{ id: 'shot-01' }] }];
    expect(ensureStoryboardIds(scenes)).toBe(scenes);
  });

  it('escapes a collision instead of stamping a duplicate id', () => {
    // The scene at index 0 has no id, but `scene-01` is already taken by a
    // later scene — a duplicate would make id resolution ambiguous.
    const out = ensureStoryboardIds([{ description: 'a' }, { id: 'scene-01', description: 'b' }]);
    expect(out[0].id).toBe('scene-01-2');
    expect(out[1].id).toBe('scene-01');
  });

  it('re-stamps a DUPLICATE id, keeping the first occurrence', () => {
    // A duplicated scene is as ambiguous as an id-less one: after a reorder the
    // captured-index tiebreak would land the write on the wrong copy.
    const out = ensureStoryboardIds([
      { id: 'scene-01', description: 'original' },
      { id: 'scene-01', description: 'duplicate' },
    ]);
    expect(out[0].id).toBe('scene-01');
    expect(out[0].description).toBe('original');
    expect(out[1].id).toBe('scene-02');
    expect(new Set(out.map((s) => s.id)).size).toBe(2);
  });

  it('re-stamps duplicate SHOT ids too (the scene extractor tolerates them)', () => {
    const out = ensureStoryboardIds([{
      id: 'scene-01',
      shots: [{ id: 'shot-01' }, { id: 'shot-01' }, { id: 'shot-01' }],
    }]);
    expect(out[0].shots.map((s) => s.id)).toEqual(['shot-01', 'shot-02', 'shot-03']);
  });

  it('escapes when the deterministic replacement for a duplicate is itself taken', () => {
    const out = ensureStoryboardIds([
      { id: 'dup' },
      { id: 'dup' },
      { id: 'scene-02' },
    ]);
    expect(out.map((s) => s.id)).toEqual(['dup', 'scene-02-2', 'scene-02']);
  });

  it('passes non-array / empty input straight through', () => {
    expect(ensureStoryboardIds(null)).toBe(null);
    expect(ensureStoryboardIds(undefined)).toBe(undefined);
    const empty = [];
    expect(ensureStoryboardIds(empty)).toBe(empty);
  });

  it('leaves non-object entries untouched', () => {
    const scenes = ['nope', null, { description: 'real' }];
    const out = ensureStoryboardIds(scenes);
    expect(out[0]).toBe('nope');
    expect(out[1]).toBe(null);
    expect(out[2].id).toBe('scene-03');
  });

  it('exposes the id formats it stamps', () => {
    expect(sceneIdForIndex(0)).toBe('scene-01');
    expect(shotIdForIndex(11)).toBe('shot-12');
  });
});

describe('resolveStoryboardTarget', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('resolves by id after a reorder, ignoring the stale index', () => {
    const hit = resolveStoryboardTarget([{ id: 'c' }, { id: 'a' }], { id: 'a', index: 0 });
    expect(hit).toMatchObject({ index: 1, matchedBy: 'id', stale: false });
  });

  it('prefers the captured index when a duplicated id matches twice', () => {
    const dup = [{ id: 'a', tag: 'first' }, { id: 'a', tag: 'second' }];
    expect(resolveStoryboardTarget(dup, { id: 'a', index: 1 }).record.tag).toBe('second');
    // …and falls back to the first match when the index does not carry the id.
    expect(resolveStoryboardTarget(dup, { id: 'a', index: 5 }).record.tag).toBe('first');
  });

  it('reports stale (never an index retarget) when a captured id is gone', () => {
    const hit = resolveStoryboardTarget(list, { id: 'gone', index: 1 });
    expect(hit).toMatchObject({ index: -1, record: null, matchedBy: null, stale: true });
  });

  it('falls back to the index only when no id was captured', () => {
    expect(resolveStoryboardTarget(list, { index: 2 })).toMatchObject({ index: 2, matchedBy: 'index' });
    expect(resolveStoryboardTarget(list, { id: '  ', index: 2 })).toMatchObject({ index: 2, matchedBy: 'index' });
    expect(resolveStoryboardTarget(list, { index: 9 })).toMatchObject({ index: -1, matchedBy: null, stale: false });
  });

  it('tolerates a non-array list and a non-integer index', () => {
    expect(resolveStoryboardTarget(null, { index: 0 }).record).toBe(null);
    expect(resolveStoryboardTarget(list, { index: 'nope' }).record).toBe(null);
    expect(resolveStoryboardTarget(list, {}).record).toBe(null);
  });
});
