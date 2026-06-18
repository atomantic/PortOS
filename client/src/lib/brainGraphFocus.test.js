import { describe, it, expect } from 'vitest';
import { pushFocus, popFocus, currentFocusId } from './brainGraphFocus.js';

describe('pushFocus', () => {
  it('appends a node to an empty trail', () => {
    expect(pushFocus([], { id: 'a', label: 'A' })).toEqual([{ id: 'a', label: 'A' }]);
  });

  it('appends to a non-empty trail', () => {
    const trail = [{ id: 'a', label: 'A' }];
    expect(pushFocus(trail, { id: 'b', label: 'B' })).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ]);
  });

  it('is a no-op when re-focusing the current node (no duplicate)', () => {
    const trail = [{ id: 'a', label: 'A' }];
    expect(pushFocus(trail, { id: 'a', label: 'A' })).toBe(trail);
  });

  it('falls back to id when label is missing', () => {
    expect(pushFocus([], { id: 'x' })).toEqual([{ id: 'x', label: 'x' }]);
  });

  it('ignores a node with no id', () => {
    const trail = [{ id: 'a', label: 'A' }];
    expect(pushFocus(trail, {})).toBe(trail);
  });
});

describe('popFocus', () => {
  it('pops to the previous focus', () => {
    const trail = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    expect(popFocus(trail)).toEqual({ trail: [{ id: 'a', label: 'A' }], focusId: 'a' });
  });

  it('pops the last entry back to the overview (null focus)', () => {
    const trail = [{ id: 'a', label: 'A' }];
    expect(popFocus(trail)).toEqual({ trail: [], focusId: null });
  });

  it('handles an already-empty trail', () => {
    expect(popFocus([])).toEqual({ trail: [], focusId: null });
  });
});

describe('currentFocusId', () => {
  it('is null for the overview', () => {
    expect(currentFocusId([])).toBeNull();
  });

  it('is the last trail entry id when focused', () => {
    expect(currentFocusId([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])).toBe('b');
  });
});
