import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { vitestCiPool } from './vitestCiPool.js';

describe('vitestCiPool', () => {
  const originalCi = process.env.CI;
  const originalRunnerOs = process.env.RUNNER_OS;

  beforeEach(() => {
    delete process.env.RUNNER_OS;
  });

  afterEach(() => {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    if (originalRunnerOs === undefined) delete process.env.RUNNER_OS;
    else process.env.RUNNER_OS = originalRunnerOs;
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

  it('uses one worker on Windows CI', () => {
    process.env.CI = 'true';
    process.env.RUNNER_OS = 'Windows';
    expect(vitestCiPool()).toEqual({ maxWorkers: 1, pool: 'threads' });
  });
});
