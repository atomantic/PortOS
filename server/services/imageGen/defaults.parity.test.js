import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_NEGATIVE_PROMPT } from './defaults.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

describe('imageGen defaults', () => {
  it('matches the client mirror, which cannot import this module', () => {
    // client/src/lib/imageGenDefaults.js hardcodes the same string for the
    // Image Gen form and the Dashboard Quick Image widget. If it drifts,
    // the user edits against one default while the server applies another —
    // silently, which is why this is a test and not a comment.
    const clientSrc = read('../../../client/src/lib/imageGenDefaults.js');
    const match = clientSrc.match(/DEFAULT_NEGATIVE_PROMPT = '([^']+)'/);
    expect(match, 'client mirror not found — did DEFAULT_NEGATIVE_PROMPT move?').toBeTruthy();
    expect(match[1]).toBe(DEFAULT_NEGATIVE_PROMPT);
  });

  it('is the only server-side definition of the base negative prompt', () => {
    // The dedupe this module exists for: discover the service's modules
    // rather than listing them, so a fresh pasted-in copy cannot sneak back
    // in next to a new provider.
    const offenders = readdirSync(HERE)
      .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'defaults.js')
      .map((f) => [f, read(f)])
      .filter(([, src]) => src.includes("'blurry, low quality"))
      .map(([f]) => f);
    expect(offenders, 'literal copies found outside defaults.js').toEqual([]);
  });
});
