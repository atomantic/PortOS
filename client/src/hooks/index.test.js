import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as barrel from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL_SRC = readFileSync(join(HERE, 'index.js'), 'utf8');
const README_SRC = readFileSync(join(HERE, 'README.md'), 'utf8');

const sourceFiles = readdirSync(HERE).filter(
  (f) => (f.endsWith('.js') || f.endsWith('.jsx'))
    && !f.endsWith('.test.js') && !f.endsWith('.test.jsx')
    && f !== 'index.js',
);

describe('client/src/hooks/ barrel', () => {
  it('resolves every re-export', () => {
    expect(Object.keys(barrel).length).toBeGreaterThan(0);
  });

  it('exposes hooks under their canonical names', () => {
    // Both default-exported and named-exported hooks should surface as `useX`.
    expect(typeof barrel.useLockToggle).toBe('function');
    expect(typeof barrel.useMounted).toBe('function');
    expect(typeof barrel.useAsyncAction).toBe('function');
    expect(typeof barrel.useSseProgress).toBe('function');
    expect(typeof barrel.useSocket).toBe('function');
    expect(typeof barrel.useClickOutside).toBe('function');
  });

  it('re-exports every non-test hook file from index.js', () => {
    for (const f of sourceFiles) {
      expect(BARREL_SRC, `missing barrel re-export for ${f}`).toContain(`'./${f}'`);
    }
  });

  it('every non-test hook file has a README row', () => {
    for (const f of sourceFiles) {
      const base = f.replace(/\.(js|jsx)$/, '');
      expect(README_SRC, `missing README entry for ${f}`).toContain(base);
    }
  });
});
