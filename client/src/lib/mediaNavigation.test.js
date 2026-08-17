import { describe, it, expect, vi } from 'vitest';
import { getAdjacentMedia, getMediaNavProps } from './mediaNavigation.js';

const items = [
  { key: 'one' },
  { key: 'two' },
  { key: 'three' },
];

describe('getAdjacentMedia', () => {
  it('returns both neighbors for a middle item', () => {
    const nav = getAdjacentMedia(items, { key: 'two' });
    expect(nav.previous).toEqual({ key: 'one' });
    expect(nav.next).toEqual({ key: 'three' });
    expect(nav.hasPrevious).toBe(true);
    expect(nav.hasNext).toBe(true);
  });

  it('has no previous on the first item and no next on the last', () => {
    expect(getAdjacentMedia(items, { key: 'one' })).toMatchObject({
      previous: null, hasPrevious: false, next: { key: 'two' }, hasNext: true,
    });
    expect(getAdjacentMedia(items, { key: 'three' })).toMatchObject({
      next: null, hasNext: false, previous: { key: 'two' }, hasPrevious: true,
    });
  });

  it('returns empty nav when the item has no key or the list is empty', () => {
    const empty = { previous: null, next: null, hasPrevious: false, hasNext: false };
    expect(getAdjacentMedia(items, {})).toEqual(empty);
    expect(getAdjacentMedia([], { key: 'one' })).toEqual(empty);
    expect(getAdjacentMedia(null, { key: 'one' })).toEqual(empty);
  });
});

describe('getMediaNavProps', () => {
  it('calls onSelect with the adjacent item', () => {
    const onSelect = vi.fn();
    const props = getMediaNavProps(items, { key: 'two' }, onSelect);
    props.onPrevious();
    props.onNext();
    expect(onSelect.mock.calls).toEqual([[{ key: 'one' }], [{ key: 'three' }]]);
  });
});
// @vitest-environment node
