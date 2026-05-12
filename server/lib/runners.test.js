import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { RUNNER_FAMILIES, isMflux, isFlux2, isZImage, isErnie } from './runners.js';

const __dirname_self = dirname(fileURLToPath(import.meta.url));
const CLIENT_MIRROR_PATH = join(__dirname_self, '..', '..', 'client', 'src', 'lib', 'runnerFamilies.js');

describe('RUNNER_FAMILIES', () => {
  it('exports the four canonical runner ids', () => {
    expect(RUNNER_FAMILIES.MFLUX).toBe('mflux');
    expect(RUNNER_FAMILIES.FLUX2).toBe('flux2');
    expect(RUNNER_FAMILIES.Z_IMAGE).toBe('z-image');
    expect(RUNNER_FAMILIES.ERNIE).toBe('ernie');
  });

  it('is frozen so callers can\'t mutate the canonical strings at runtime', () => {
    expect(Object.isFrozen(RUNNER_FAMILIES)).toBe(true);
  });

  it('client mirror at client/src/lib/runnerFamilies.js carries the same ids', () => {
    // The mirror is plain JS (not importable from a Vitest server suite —
    // Vite's fs.allow doesn't cross), so we string-grep the file. Any
    // change to a canonical id has to be reflected in both places, or this
    // test fails.
    const text = readFileSync(CLIENT_MIRROR_PATH, 'utf-8');
    expect(text).toMatch(/MFLUX:\s*'mflux'/);
    expect(text).toMatch(/FLUX2:\s*'flux2'/);
    expect(text).toMatch(/Z_IMAGE:\s*'z-image'/);
    expect(text).toMatch(/ERNIE:\s*'ernie'/);
  });

  it('predicate helpers match on the canonical runner ids', () => {
    expect(isMflux({ runner: 'mflux' })).toBe(true);
    expect(isFlux2({ runner: 'flux2' })).toBe(true);
    expect(isZImage({ runner: 'z-image' })).toBe(true);
    expect(isErnie({ runner: 'ernie' })).toBe(true);
    expect(isFlux2({ runner: 'mflux' })).toBe(false);
    expect(isFlux2(null)).toBe(false);
    expect(isFlux2(undefined)).toBe(false);
  });
});
