import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as barrel from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL_SRC = readFileSync(join(HERE, 'index.js'), 'utf8');
const README_SRC = readFileSync(join(HERE, 'README.md'), 'utf8');

const sourceFiles = readdirSync(HERE)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'index.js');

// The barrel is the machine-checkable enumeration of every public surface in
// `server/lib/`. If a `export * from './foo.js'` line points to a non-existent
// module, the `import * as barrel` above throws — and so does this test. The
// catalog-parity test below catches the inverse drift: a file added without
// a README row. Both halves keep the discovery contract in CLAUDE.md honest.

describe('server/lib/ barrel', () => {
  it('resolves every re-export', () => {
    expect(Object.keys(barrel).length).toBeGreaterThan(0);
  });

  it('exposes a representative sample of helpers', () => {
    expect(typeof barrel.tryReadFile).toBe('function');
    expect(typeof barrel.atomicWrite).toBe('function');
    expect(typeof barrel.optionalBooleanMap).toBe('function');
    expect(typeof barrel.flattenCanonDescriptorFragments).toBe('function');
    expect(typeof barrel.mapCanonDescriptorFragments).toBe('function');
    expect(typeof barrel.descriptorForCanonEntry).toBe('function');
    expect(typeof barrel.ServerError).toBe('function');
    expect(typeof barrel.v4).toBe('function');
  });

  it('re-exports every non-test .js file from index.js', () => {
    // Forces the maintenance rule: a new server/lib/foo.js must be added to
    // index.js. Catches a new helper that bypassed the barrel.
    for (const f of sourceFiles) {
      expect(BARREL_SRC, `missing barrel re-export for ${f}`).toContain(`'./${f}'`);
    }
  });

  it('every non-test .js file has a README row', () => {
    // Forces the catalog parity: a new helper must also get a one-line
    // README entry. Looser match (filename anywhere in the README) so the
    // table format can evolve without breaking this guard.
    for (const f of sourceFiles) {
      const base = f.replace(/\.js$/, '');
      expect(README_SRC, `missing README entry for ${f}`).toContain(base);
    }
  });

  it('has no export-name collisions across flat-`export *` modules', async () => {
    // `export * from './foo.js'` (flat) silently drops names when two
    // modules export the same identifier — whichever line comes last wins.
    // `export * as foo from './foo.js'` (namespaced) is safe: it surfaces
    // exports under a single `foo.*` key. Parse the barrel source for
    // flat-star lines only, then verify their exports don't collide.
    const flatStarRe = /^export \* from '\.\/([^']+)';/gm;
    const flatModules = [...BARREL_SRC.matchAll(flatStarRe)].map((m) => m[1]);
    const seen = new Map();
    const collisions = [];
    for (const f of flatModules) {
      const mod = await import(/* @vite-ignore */ `./${f}`);
      for (const name of Object.keys(mod)) {
        if (name === 'default') continue;
        if (seen.has(name) && seen.get(name).export !== mod[name]) {
          // Same-name + different-identity = real collision. Same identity
          // (e.g. one module re-exports another's symbol) is silently fine.
          collisions.push(`${name}: ${seen.get(name).file} vs ${f}`);
        } else if (!seen.has(name)) {
          seen.set(name, { file: f, export: mod[name] });
        }
      }
    }
    expect(collisions, `Switch one module to \`export * as <name>\` namespace export:\n  ${collisions.join('\n  ')}`).toEqual([]);
  });
});
