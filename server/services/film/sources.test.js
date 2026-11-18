/** The starter copy joins its names with pathWithin(): one that climbs out of py/starter throws instead of being read. */
import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { starterSourcePath } from './sources.js';

it('names a shipped starter file and refuses a path that climbs out of the starter', () => {
  expect(existsSync(starterSourcePath('shots/hero.py'))).toBe(true);
  expect(() => starterSourcePath('../portos_blender_driver.py')).toThrow(RangeError);
  expect(() => starterSourcePath('shots/../../portos_blender_driver.py')).toThrow(/outside/);
});
