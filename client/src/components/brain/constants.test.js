import { describe, expect, it } from 'vitest';
import { MEMORY_TABS, TABS } from './constants';

describe('Brain navigation', () => {
  it('keeps native Ideas on its dedicated URL-backed Brain tab', () => {
    expect(TABS.map(({ id }) => id)).toContain('ideas');
    expect(MEMORY_TABS.map(({ id }) => id)).not.toContain('ideas');
  });
});
