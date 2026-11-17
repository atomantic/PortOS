import { describe, it, expect } from 'vitest';
import { paginationQuerySchema, limitQuerySchema } from './queryValidation.js';

describe('shared list query schemas (#16428)', () => {
  it('keeps today\'s lenient values (non-numeric strings reach parsePagination) and strips unknown keys', () => {
    expect(paginationQuerySchema.parse({ limit: 'abc', offset: '-4', cursor: 'x' })).toEqual({ limit: 'abc', offset: '-4' });
    expect(limitQuerySchema.parse({})).toEqual({});
  });

  it('rejects the repeated-key and bracket shapes Express turns into arrays and objects', () => {
    expect(paginationQuerySchema.safeParse({ limit: ['1', '2'] }).success).toBe(false);
    expect(limitQuerySchema.safeParse({ limit: { a: '1' } }).success).toBe(false);
  });
});
