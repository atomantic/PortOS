/**
 * Drift guard for direct-invocation checks (issue #4868).
 *
 * A hand-rolled comparison between process.argv[1] and import.meta.url misses
 * symlink and case-folding behavior handled by scripts/lib/directInvocation.js.
 * Keep every import-safe CLI on the shared helper so a direct run cannot
 * silently no-op under a symlinked checkout.
 *
 * The scan covers every tracked non-test .js file rather than a directory list:
 * CLI entrypoints are not confined to scripts/, and the tenth copy is most
 * likely to appear exactly where nobody thought to look. Reading the whole
 * tracked tree costs ~65ms, so scoping it any tighter buys nothing.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The helper itself compares the two by definition — it is the one owner. */
const OWNER = 'scripts/lib/directInvocation.js';

const scriptFiles = execFileSync('git', ['ls-files', '*.js'], { cwd: REPO_ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((relativePath) => (
    relativePath
    && !relativePath.endsWith('.test.js')
    && relativePath !== OWNER
  ));

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

  it('tracked JavaScript files do not compare argv[1] with import.meta.url themselves', () => {
    expect(scriptFiles.length).toBeGreaterThan(0);

    const offenders = scriptFiles.filter((relativePath) => (
      handRollsCheck(readFileSync(join(REPO_ROOT, relativePath), 'utf8'))
    ));

    expect(offenders).toEqual([]);
  });
});
