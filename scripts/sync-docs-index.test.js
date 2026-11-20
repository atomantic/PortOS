import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { BEGIN, END, listDocs, renderReadme } from './sync-docs-index.js';

const README = join(import.meta.dirname, '..', 'docs', 'README.md');

describe('sync-docs-index', () => {
  it('lists only unlinked docs in the generated block and skips plans/archive', () => {
    const readme = `# Docs\n[a](./a.md)\n${BEGIN}\nstale\n${END}\n`;
    const out = renderReadme(readme, ['a.md', 'b.md', 'plans/archive/x.md', 'decisions/d.md'], { 'b.md': 'B doc', 'decisions/d.md': 'D' });
    expect(out).toContain('- [B doc](./b.md)');
    expect(out).toContain('- [D](./decisions/d.md)');
    expect(out).not.toContain('./a.md)\n-');
    expect(out).not.toContain('stale');
  });

  it('listDocs excludes plans/archive', () => {
    expect(listDocs().some((f) => f.startsWith('plans/archive/'))).toBe(false);
  });

  it('docs/README.md generated block is current (run node scripts/sync-docs-index.js)', () => {
    const readme = readFileSync(README, 'utf8');
    const docs = listDocs();
    const titles = Object.fromEntries(docs.map((rel) => [rel, readFileSync(join(import.meta.dirname, '..', 'docs', rel), 'utf8').match(/^#\s+(.+)$/m)?.[1].trim() ?? rel]));
    expect(renderReadme(readme, docs, titles)).toBe(readme);
  });
});
