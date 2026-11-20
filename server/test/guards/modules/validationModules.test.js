import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, } from 'node:fs';
import { join } from 'node:path';
import { staticImportSpecifiersFromSource } from '../../../lib/staticImportGraph.js';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

// #16828: the catch-all `validation.js` was dissolved into one `<domain>Validation.js` per route family.
// Regrowing it (or letting the split files import each other) brings back a module every suite pays for.
const LIB_DIR = join(REPO_ROOT, 'server/lib');
const SPLIT_MARKER = 'Moved out of the retired catch-all validation.js (#16828)';
// Leaves a split file may import. Only the files this split created are fenced off: older domain
// files and helper leaves (cronValidation.js) predate the rule.
const SHARED_LEAVES = new Set(['./sharedSchemas.js', './zodCompat.js', './queryValidation.js']);

const splitFiles = readdirSync(LIB_DIR)
  .filter((name) => /Validation\.js$/.test(name))
  .filter((name) => readText(join(LIB_DIR, name)).includes(SPLIT_MARKER));

describe('the catch-all validation module stays dissolved', () => {
  it('does not exist again', () => {
    expect(existsSync(join(LIB_DIR, 'validation.js')),
      'Put a schema in its route family\'s <domain>Validation.js (server/AGENTS.md), never a catch-all validation.js.')
      .toBe(false);
  });

  it('found the files this split created', () => {
    expect(splitFiles.length).toBeGreaterThan(30);
  });

  it.each(splitFiles)('%s imports no other file this split created', (name) => {
    const source = readText(join(LIB_DIR, name));
    const offenders = staticImportSpecifiersFromSource(source)
      .filter((specifier) => splitFiles.includes(specifier.replace(/^\.\//, '')) && !SHARED_LEAVES.has(specifier));
    expect(offenders, `${name}: move the shared schema into sharedSchemas.js instead of importing a sibling domain file`)
      .toEqual([]);
  });
});
