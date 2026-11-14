import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as barrel from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL_SRC = readFileSync(join(HERE, 'index.js'), 'utf8');
const README_SRC = readFileSync(join(HERE, 'README.md'), 'utf8');

const sourceFiles = readdirSync(HERE)
  .filter((f) => (f.endsWith('.js') || f.endsWith('.jsx'))
    && !f.endsWith('.test.js') && !f.endsWith('.test.jsx')
    && f !== 'index.js');

// The barrel is the machine-checkable enumeration of every public surface in
// `server/lib/`. If a `export * from './foo.js'` line points to a non-existent
// module, the `import * as barrel` above throws — and so does this test. The
// catalog-parity test below catches the inverse drift: a file added without
// a README row. Both halves keep the discovery contract in AGENTS.md honest.

describe('server/lib/ barrel', () => {
  it('re-exports every non-test source file from index.js', () => {
    // The `import * as barrel` above is the load: a star-export of a missing
    // module throws before this body runs. The length check keeps `barrel` live
    // so an unused-import lint can't delete that load.
    expect(Object.keys(barrel).length).toBeGreaterThan(0);
    // Forces the maintenance rule: a new server/lib/foo.js must be added to
    // index.js. Catches a new helper that bypassed the barrel.
    // Migration 443 imports this frozen helper directly; runtime must not load it.
    expect(BARREL_SRC).not.toContain("'./legacyRetirementTransition.js'");
    for (const f of sourceFiles.filter(file => file !== 'legacyRetirementTransition.js')) {
      expect(BARREL_SRC, `missing barrel re-export for ${f}`).toContain(`'./${f}'`);
    }
  });

  it('lists every source file exactly once in the alphabetical module table', () => {
    // The README's `## Modules` table is the catalog: one row per module, in
    // alphabetical order, so a new row has exactly one correct place (and
    // concurrent additions stop colliding at the same insertion point).
    const section = README_SRC.split(/^## Modules$/m)[1]?.split(/^## /m)[0] ?? '';
    const rows = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
    const missing = sourceFiles.filter((f) => !rows.includes(f));
    expect(missing, 'add a `| `<file>` | <purpose> |` row to the README module table').toEqual([]);
    const duplicated = rows.filter((f, i) => rows.indexOf(f) !== i);
    expect(duplicated, 'merge duplicate README module rows').toEqual([]);
    const stale = rows.filter((f) => !sourceFiles.includes(f));
    expect(stale, 'remove README module rows for files that no longer exist').toEqual([]);
    // Plain case-insensitive code-point order: no locale, so every machine agrees.
    const key = (f) => f.toLowerCase();
    const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const firstOutOfPlace = rows.findIndex((f, i) => f !== sorted[i]);
    expect(firstOutOfPlace, `README module row out of alphabetical order: ${rows[firstOutOfPlace]} (belongs where ${sorted[firstOutOfPlace]} is)`).toBe(-1);
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
