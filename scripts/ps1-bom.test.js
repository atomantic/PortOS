import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Regression guard for issue #1788: setup.ps1 failed to parse on Windows
// PowerShell 5.1 ("string is missing the terminator" / "missing closing '}'").
// Root cause: the file was UTF-8 *without* a BOM and contained non-ASCII
// characters (em-dashes, an emoji). Windows PowerShell 5.1 reads BOM-less files
// as the system ANSI codepage, not UTF-8, so the multi-byte sequences misalign
// the parser. The fix is a UTF-8 BOM, which is Microsoft's documented
// requirement for 5.1 to interpret non-ASCII scripts (and harmless on 7+).
//
// This test fails the moment any tracked .ps1 loses (or is added without) its
// BOM, so the bug can't silently return via an editor that strips it.
//
// We enumerate via `git ls-files` rather than walking the tree so the check
// covers exactly the *tracked* scripts: gitignored runtime data (e.g. cloned
// repos under data/repos/) and the lib/slashdo submodule's own files are
// excluded for free — a BOM-less .ps1 a developer happens to clone locally
// must not fail this suite.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function trackedPs1Files() {
  const out = execFileSync('git', ['ls-files', '-z', '*.ps1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

describe('PowerShell scripts (.ps1) ship a UTF-8 BOM (issue #1788)', () => {
  const files = trackedPs1Files();

  it('finds the tracked .ps1 scripts to verify', () => {
    // Sanity: if `git ls-files` found nothing the assertions below are vacuous.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)(
    '%s starts with a UTF-8 BOM so Windows PowerShell 5.1 reads it as UTF-8',
    (rel) => {
      const head = readFileSync(join(REPO_ROOT, rel)).subarray(0, 3);
      expect(head.equals(UTF8_BOM)).toBe(true);
    }
  );
});
