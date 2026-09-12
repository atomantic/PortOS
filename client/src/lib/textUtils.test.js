import { describe, it, expect } from 'vitest';
import { pluralize } from './textUtils.js';

describe('pluralize', () => {
  it('uses the singular form for a count of 1', () => {
    expect(pluralize(1, 'item')).toBe('1 item');
  });

  it('appends "s" by default for any other count', () => {
    expect(pluralize(0, 'item')).toBe('0 items');
    expect(pluralize(2, 'item')).toBe('2 items');
  });

  it('uses an explicit irregular plural form when given one', () => {
    expect(pluralize(1, 'person', 'people')).toBe('1 person');
    expect(pluralize(3, 'person', 'people')).toBe('3 people');
  });
});
