/** The staged driver files are joined with pathWithin(): a kit name that climbs out of py/ throws instead of being read. */
import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { driverSourcePath } from './driver.js';

it('names a shipped driver file and refuses a path that climbs out of py/', () => {
  expect(existsSync(driverSourcePath('portos_film/timing.py'))).toBe(true);
  expect(() => driverSourcePath('portos_film/../../driver.js')).toThrow(RangeError);
  expect(() => driverSourcePath('../sources.js')).toThrow(/outside/);
});
