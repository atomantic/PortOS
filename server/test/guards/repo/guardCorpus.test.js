import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardCorpus, readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

describe('the checkout-scoped corpus', () => {
  it('uses the shared corpus inside the checkout', () => {
    const corpus = guardCorpus();
    expect(guardCorpus()).toBe(corpus);
    expect(readText(join(REPO_ROOT, 'AGENTS.md'))).toBe(corpus.read('AGENTS.md'));
  });

  it('reads paths outside the checkout fresh', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'portos-guard-corpus-read-'));
    try {
      const outside = join(scratch, 'outside.txt');
      writeFileSync(outside, 'one');
      expect(readText(outside)).toBe('one');
      writeFileSync(outside, 'two');
      expect(readText(outside)).toBe('two');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
