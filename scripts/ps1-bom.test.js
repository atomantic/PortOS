import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function findPs1Files(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Skip the vendored slashdo submodule — it owns its own files.
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (relative(REPO_ROOT, full) === join('lib', 'slashdo')) continue;
      findPs1Files(full, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ps1')) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

describe('PowerShell scripts (.ps1) ship a UTF-8 BOM (issue #1788)', () => {
  const files = findPs1Files(REPO_ROOT);

  it('finds the project .ps1 scripts to verify', () => {
    // Sanity: if the walk finds nothing the assertions below are vacuous.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => relative(REPO_ROOT, f)))(
    '%s starts with a UTF-8 BOM so Windows PowerShell 5.1 reads it as UTF-8',
    (rel) => {
      const head = readFileSync(join(REPO_ROOT, rel)).subarray(0, 3);
      expect(head.equals(UTF8_BOM)).toBe(true);
    }
  );
});
