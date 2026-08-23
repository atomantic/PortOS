/**
 * Guard for the pre-install zone: the CI `Plan test impact` job checks out the
 * repo and immediately runs `node scripts/ci-base-sha.js` and
 * `node scripts/ci-test-plan.js` — with no `npm ci` before them. Those two
 * scripts, and everything they transitively import, therefore have to load
 * from a bare checkout, using Node builtins only.
 *
 * Nothing enforces that today, and the failure is invisible until it isn't:
 * `server/lib/` is one `import { z } from 'zod'` away from unloadable (its
 * barrel already is), so "just move the shared helper somewhere tidier" would
 * take out the first job in CI — the one that decides what every other job
 * runs. That makes it latent rather than live, which is exactly why it needs a
 * guard rather than a comment.
 *
 * This is also why scripts/lib/directInvocation.js stays in scripts/lib/
 * rather than moving to server/lib/ alongside the other pure helpers: it is
 * imported by both pre-install entrypoints.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { builtinModules } from 'module';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run by the CI `impact` job before any dependency install. */
const PRE_INSTALL_ENTRYPOINTS = ['scripts/ci-base-sha.js', 'scripts/ci-test-plan.js'];

const BUILTINS = new Set(builtinModules);
const isBuiltin = (specifier) => BUILTINS.has(specifier.replace(/^node:/, ''));

/** Static `from '...'` / bare `import '...'` specifiers, comments stripped. */
function importSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(([, s]) => s);
}

/** Every bare (non-relative) specifier reachable from `entry`, transitively. */
function bareSpecifiersReachableFrom(entry) {
  const seen = new Set();
  const bare = new Set();
  const walk = (relativePath) => {
    if (seen.has(relativePath)) return;
    seen.add(relativePath);
    for (const specifier of importSpecifiers(readFileSync(join(REPO_ROOT, relativePath), 'utf8'))) {
      if (!specifier.startsWith('.')) {
        bare.add(specifier);
        continue;
      }
      walk(relative(REPO_ROOT, resolve(dirname(join(REPO_ROOT, relativePath)), specifier)));
    }
  };
  walk(entry);
  return [...bare];
}

describe('CI pre-install entrypoints load from a bare checkout', () => {
  // The walker decides whether the assertions below mean anything, so it is
  // verified against this file's own known imports rather than trusted.
  it('bareSpecifiersReachableFrom follows relative imports and collects bare ones', () => {
    const found = bareSpecifiersReachableFrom('scripts/ci-base-sha.js');
    expect(found).toContain('child_process');
    // Reached only through ./lib/directInvocation.js — proves it recursed.
    expect(found).toContain('fs');
    expect(found.every(isBuiltin)).toBe(true);
    expect(isBuiltin('zod')).toBe(false);
  });

  it.each(PRE_INSTALL_ENTRYPOINTS)('%s is still wired into the CI impact job', (entry) => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain(`node ${entry}`);
  });

  it.each(PRE_INSTALL_ENTRYPOINTS)('%s imports only Node builtins, transitively', (entry) => {
    const nonBuiltins = bareSpecifiersReachableFrom(entry).filter((s) => !isBuiltin(s));
    expect(nonBuiltins).toEqual([]);
  });
});
