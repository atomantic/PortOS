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

describe('client/src/lib/ barrel', () => {
  it('re-exports every non-test source file from index.js', () => {
    expect(Object.keys(barrel).length).toBeGreaterThan(0);
    for (const f of sourceFiles) {
      expect(BARREL_SRC, `missing barrel re-export for ${f}`).toContain(`'./${f}'`);
    }
  });

  it('every non-test source file has a README row', () => {
    for (const f of sourceFiles) {
      const base = f.replace(/\.jsx?$/, '');
      expect(README_SRC, `missing README entry for ${f}`).toContain(base);
    }
  });
});
// @vitest-environment node
