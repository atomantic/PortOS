import { afterEach, describe, expect, it } from 'vitest';

import { vitestCiPool } from './vitestCiPool.js';

describe('vitestCiPool', () => {
  const original = process.env.CI;

  afterEach(() => {
    if (original === undefined) delete process.env.CI;
    else process.env.CI = original;
  });

  it('leaves local runs unbounded', () => {
    delete process.env.CI;
    expect(vitestCiPool()).toEqual({});
  });

  it('caps workers at 2 on CI', () => {
    process.env.CI = 'true';
    expect(vitestCiPool()).toEqual({ maxWorkers: 2 });
  });

  it('treats CI=1 as CI', () => {
    process.env.CI = '1';
    expect(vitestCiPool()).toEqual({ maxWorkers: 2 });
  });
});
