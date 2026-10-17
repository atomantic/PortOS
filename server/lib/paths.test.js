import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname, relative } from 'path';
import { globSync } from 'tinyglobby';
import { PATHS } from './paths.js';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Replace comment bodies with spaces, preserving length and line breaks. */
const blankComments = (source) => source.replace(
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (chunk) => chunk.replace(/[^\n]/g, ' '),
);

// `PATHS` is a plain object, so a reference to a key that does not exist is not
// a syntax or type error — it is `undefined`, and the failure only surfaces when
// the value reaches an `fs` call at runtime. That is exactly how #11770 shipped:
// `imageGen/codex.js` read `PATHS.tmp`, a key the object has never had, and the
// suite stayed green because the provider's own test mock ASSIGNED `PATHS.tmp`
// before importing it. Every Codex render then died on
// `ERR_INVALID_ARG_TYPE: The "path" argument ... Received undefined` before the
// child ever spawned.
//
// A static scan is the right shape here: the property access is what is wrong,
// so checking it needs no process, no filesystem, and no provider. Dynamic
// accesses (`PATHS[key]`) are deliberately out of scope — they are rare and
// cannot be resolved without running the code.
describe('PATHS key references', () => {
  const files = globSync(['**/*.js'], {
    cwd: SERVER_ROOT,
    ignore: ['**/node_modules/**', '**/*.test.js'],
    absolute: true,
  });

  it('scans a meaningful portion of the server tree', () => {
    // Guards the glob itself: a broken pattern would otherwise make the
    // assertion below pass vacuously against an empty file list.
    expect(files.length).toBeGreaterThan(100);
  });

  it('every PATHS.<key> read in server source exists on the real object', async () => {
    const valid = new Set(Object.keys(PATHS));
    const offenders = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!source.includes('PATHS.')) continue;
      // Prose names these keys freely ("an earlier revision read PATHS.tmp",
      // "frames under PATHS.video-thumbnails"), so a scan of raw text reports
      // comments as defects. Blanking comments to same-length whitespace keeps
      // the reported line numbers honest. Only ever REMOVES text, so this can
      // hide a real reference on a line that also holds a `//` inside a string
      // (a URL) — a miss, never a false accusation.
      const code = blankComments(source);
      for (const match of code.matchAll(/\bPATHS\.([A-Za-z_$][\w$]*)/g)) {
        const key = match[1];
        if (valid.has(key)) continue;
        const line = code.slice(0, match.index).split('\n').length;
        offenders.push(`${relative(SERVER_ROOT, file)}:${line} → PATHS.${key}`);
      }
    }
    expect(
      offenders,
      `These read a PATHS key that does not exist (they evaluate to undefined at runtime):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
