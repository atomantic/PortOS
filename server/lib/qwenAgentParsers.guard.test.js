import { trackedFiles } from '../../scripts/lib/trackedFiles.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('qwen parser spellings live only in the table', () => {
  it('no other tracked source file hard-codes a qwen3 parser spelling', () => {
    // Acceptance criterion of #4778: the SGLang runtime (#4776) and the vLLM
    // guided install (#4767) must import this table instead of retyping the
    // string. Scoped to git-tracked JS so scratch files never flake it.
    const tracked = trackedFiles(REPO_ROOT, ['*.js', '*.jsx', '*.cjs', '*.mjs']);
    // The table, its behavioural suite, and this file, whose pattern below spells both.
    const allowed = new Set(['server/lib/qwenAgentParsers.js', 'server/lib/qwenAgentParsers.test.js', 'server/lib/qwenAgentParsers.guard.test.js']);
    const offenders = tracked.filter((rel) => {
      if (allowed.has(rel)) return false;
      return /qwen3_xml|qwen3_coder/.test(readFileSync(join(REPO_ROOT, rel), 'utf8'));
    });
    expect(
      offenders,
      `These files hard-code a Qwen tool-call parser spelling — import parserFlagsFor() from server/lib/qwenAgentParsers.js instead: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
