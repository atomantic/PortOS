import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as barrel from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL_SRC = readFileSync(join(HERE, 'index.js'), 'utf8');
const README_SRC = readFileSync(join(HERE, 'README.md'), 'utf8');

const sourceFiles = readdirSync(HERE).filter(
  (f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'index.js',
);

// Collect every top-level named export per module so we can prove no two flat
// `export * from` modules collide (a collision would silently shadow under the
// barrel — see CLAUDE.md "Name collisions").
const EXPORT_RE = /^export\s+(?:const|let|function|async function|class)\s+([A-Za-z0-9_$]+)/gm;
const exportsByName = new Map();
for (const f of sourceFiles) {
  const src = readFileSync(join(HERE, f), 'utf8');
  for (const m of src.matchAll(EXPORT_RE)) {
    const name = m[1];
    if (!exportsByName.has(name)) exportsByName.set(name, []);
    exportsByName.get(name).push(f);
  }
}

describe('client/src/utils/ barrel', () => {
  it('resolves every re-export', () => {
    expect(Object.keys(barrel).length).toBeGreaterThan(0);
  });

  it('exposes a representative sample of helpers', () => {
    expect(typeof barrel.formatBytes).toBe('function');
    expect(typeof barrel.timeAgo).toBe('function');
    expect(typeof barrel.describeCron).toBe('function');
    expect(typeof barrel.hashString).toBe('function');
    expect(typeof barrel.normalizeUrl).toBe('function');
    expect(typeof barrel.levelFromXP).toBe('function');
    expect(typeof barrel.computeAiCore).toBe('function');
    expect(typeof barrel.computeGoalMonuments).toBe('function');
  });

  it('re-exports every non-test .js file from index.js', () => {
    for (const f of sourceFiles) {
      expect(BARREL_SRC, `missing barrel re-export for ${f}`).toContain(`'./${f}'`);
    }
  });

  it('every non-test .js file has a backtick-wrapped README row', () => {
    // Require the documented-row form (`module`) rather than a bare substring,
    // so a name appearing only in prose — or as a substring of a longer name —
    // can't satisfy the catalog-coverage guard.
    for (const f of sourceFiles) {
      const base = f.replace(/\.js$/, '');
      expect(README_SRC, `missing README row for ${f}`).toContain('`' + base + '`');
    }
  });

  it('no two flat export-* modules share an identifier', () => {
    const collisions = [...exportsByName.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(', ')}`);
    expect(collisions, `colliding exports would silently shadow under the barrel:\n${collisions.join('\n')}`).toEqual([]);
  });
});
