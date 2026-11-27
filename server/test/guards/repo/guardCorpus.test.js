import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGuardCorpus, guardCorpus, readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

describe('the checkout-scoped corpus', () => {
  it('uses the shared corpus inside the checkout', () => {
    const corpus = guardCorpus();
    expect(guardCorpus()).toBe(corpus);
    expect(readText(join(REPO_ROOT, 'AGENTS.md'))).toBe(corpus.read('AGENTS.md'));
  });

  it('reuses one Babel AST by normalized path and keeps syntax recovery visible', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'portos-guard-corpus-ast-'));
    try {
      const path = join(scratch, 'module.js');
      writeFileSync(path, 'return 1;');
      const corpus = createGuardCorpus(scratch);
      const ast = corpus.parseAst('module.js');
      expect(ast.program.loc).toBeUndefined();
      expect(ast.tokens[0].type.label).toBe('return');
      expect(ast.errors.map(error => error.reasonCode)).toEqual(['IllegalReturn']);
      expect(corpus.parseAst(path)).toBe(ast);
      expect(corpus.parseAst('./module.js')).toBe(ast);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
