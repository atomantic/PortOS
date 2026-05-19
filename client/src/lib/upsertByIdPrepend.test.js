import { describe, it, expect } from 'vitest';
import { upsertByIdPrepend } from './upsertByIdPrepend';

describe('upsertByIdPrepend', () => {
  it('prepends a new item when the id is absent', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    const next = upsertByIdPrepend(list, { id: 'c', name: 'fresh' });
    expect(next).toEqual([{ id: 'c', name: 'fresh' }, { id: 'a' }, { id: 'b' }]);
  });

  it('replaces an existing entry with the new one at the front', () => {
    const list = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
    const next = upsertByIdPrepend(list, { id: 'b', v: 2 });
    expect(next).toEqual([{ id: 'b', v: 2 }, { id: 'a', v: 1 }, { id: 'c', v: 1 }]);
  });

  it('handles an empty list', () => {
    expect(upsertByIdPrepend([], { id: 'a' })).toEqual([{ id: 'a' }]);
  });

  it('does not mutate the input list', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    upsertByIdPrepend(list, { id: 'a', changed: true });
    expect(list).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});
