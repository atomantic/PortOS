/**
 * Tree-wide guard: a repo-root-anchored file path cited in a production source
 * comment must name a git-tracked file (#12408).
 *
 * PortOS comments are written for coding agents, which follow a cited path to
 * learn a contract. Modules moved from `server/lib/` to `server/services/` and
 * the comments that named the old path went stale with nothing to catch them.
 *
 * Scanned (comment lines only): git-tracked non-test .js/.jsx/.mjs/.cjs under server/, client/src/
 * and scripts/. Referenced: paths anchored at `server/`, `client/src/`,
 * `scripts/` or `docs/(research|decisions|plans)/` ending in a file extension.
 * Placeholder examples (stem of one character, or foo|bar|baz|example) are
 * skipped. There is no allowlist: fix the path or drop the citation.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REFERENCE = /(?<![\w./-])((?:server|client\/src|scripts|docs\/(?:research|decisions|plans))\/[\w./-]*[\w-]\.[A-Za-z][A-Za-z0-9]*)(?![\w-])/g;
const PLACEHOLDER_STEM = /^(?:.|foo|bar|baz|example)$/;
const SOURCE = /\.(?:jsx?|mjs|cjs)$/;
// Comment text only: a path in a string literal is runtime data (a spawn arg, a
// test-file list), not a pointer for the reader.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)|\s\/\/\s/;
const TEST_FILE = /\.test\.[cm]?jsx?$/;

const stemOf = (path) => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.slice(0, base.indexOf('.') === -1 ? undefined : base.indexOf('.'));
};

export function findBrokenReferences(src, tracked) {
  const broken = [];
  src.split('\n').forEach((line, i) => {
    if (!COMMENT_LINE.test(line)) return;
    for (const match of line.matchAll(REFERENCE)) {
      const ref = match[1].replace(/\.+$/, '');
      if (PLACEHOLDER_STEM.test(stemOf(ref))) continue;
      if (!tracked.has(ref)) broken.push({ line: i + 1, ref });
    }
  });
  return broken;
}

const gitFiles = () => execFileSync('git', ['ls-files'], {
  cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter(Boolean);

describe('source file references (#12408)', () => {
  it('flags a moved path and ignores placeholder examples', () => {
    const tracked = new Set(['server/services/tuiPromptRunner.js']);
    expect(findBrokenReferences('// see server/lib/tuiPromptRunner.js\n// server/services/tuiPromptRunner.js', tracked))
      .toEqual([{ line: 1, ref: 'server/lib/tuiPromptRunner.js' }]);
    expect(findBrokenReferences('// `docs/decisions/x.md` and docs/a/b.md and server/lib/foo.js', tracked)).toEqual([]);
  });

  it('every cited repo path in production sources exists', () => {
    const files = gitFiles();
    expect(files.length).toBeGreaterThan(100);
    const tracked = new Set(files);
    const offenders = [];
    for (const file of files) {
      if (!SOURCE.test(file) || TEST_FILE.test(file)) continue;
      if (!/^(?:server|client\/src|scripts)\//.test(file)) continue;
      for (const { line, ref } of findBrokenReferences(readFileSync(join(REPO_ROOT, file), 'utf8'), tracked)) {
        offenders.push(`${file}:${line} -> ${ref}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
