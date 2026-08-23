/**
 * Drift guard for direct-invocation checks (issue #4868).
 *
 * A hand-rolled comparison between process.argv[1] and import.meta.url misses
 * symlink and case-folding behavior handled by scripts/lib/directInvocation.js.
 * Keep every import-safe CLI on the shared helper so a direct run cannot
 * silently no-op under a symlinked checkout.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_DIRS = ['scripts', 'server/scripts'];

const scriptFiles = SCRIPT_DIRS.flatMap((relativeDir) => {
  const directory = join(REPO_ROOT, relativeDir);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile()
      && entry.name.endsWith('.js')
      && !entry.name.endsWith('.test.js')
    ))
    .map((entry) => `${relativeDir}/${entry.name}`);
});

describe('direct-invocation checks have one owner (issue #4868)', () => {
  it('top-level JavaScript scripts do not compare argv[1] with import.meta.url themselves', () => {
    const offenders = scriptFiles.filter((relativePath) => {
      const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
      return /process\.argv\[1\][\s\S]{0,200}import\.meta\.url/.test(source)
        || /import\.meta\.url[\s\S]{0,200}process\.argv\[1\]/.test(source);
    });

    expect(offenders).toEqual([]);
  });
});
