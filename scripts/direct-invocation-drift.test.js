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

/** True when `source` hand-rolls the argv[1] <-> import.meta.url comparison. */
const handRollsCheck = (source) => (
  /process\.argv\[1\][\s\S]{0,200}import\.meta\.url/.test(source)
  || /import\.meta\.url[\s\S]{0,200}process\.argv\[1\]/.test(source)
);

describe('direct-invocation checks have one owner (issue #4868)', () => {
  // The scan below can only fail while the detector still fires and the file
  // list is still populated, so both are verified rather than trusted — a
  // broken regex or an empty glob would otherwise pass silently forever.
  it('handRollsCheck flags hand-rolled guards and clears the shared helper', () => {
    expect(handRollsCheck('const isMain = process.argv[1]\n  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));')).toBe(true);
    expect(handRollsCheck('if (import.meta.url === pathToFileURL(process.argv[1]).href) main();')).toBe(true);
    expect(handRollsCheck('if (import.meta.url === `file://${process.argv[1]}`) main();')).toBe(true);
    expect(handRollsCheck('if (isDirectlyInvoked(import.meta.url)) main();')).toBe(false);
  });

  it('top-level JavaScript scripts do not compare argv[1] with import.meta.url themselves', () => {
    expect(scriptFiles.length).toBeGreaterThan(0);

    const offenders = scriptFiles.filter((relativePath) => (
      handRollsCheck(readFileSync(join(REPO_ROOT, relativePath), 'utf8'))
    ));

    expect(offenders).toEqual([]);
  });
});
