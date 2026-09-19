import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  formatClauseCitation,
  indexClausesById,
  parsePrdClauses,
  PRD_CLAUSE_SOURCES,
  PRD_MAX_CLAUSE_CHARS,
} from './prdClauses.js';

const DOC = `# Example Product

A one-line pitch that is long enough to count as a clause on its own.

## Goals

1. **Thing one** — the product does the first thing it promises to do.
2. **Thing two** — the product also does the second thing it promises.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | The system MUST keep every record on the operator's own machine. | Must |
| FR-2 | The system SHOULD surface a digest of what it decided. | Should |

## Notes

> A quoted note that states an intention and is long enough to survive.

\`\`\`bash
# This heading-looking comment lives in a fence and must be ignored
echo hi
\`\`\`
`;

const parse = (text = DOC) => parsePrdClauses(text, { sourceFile: 'PRD.md' });

describe('parsePrdClauses', () => {
  it('splits paragraphs, list items, table rows and blockquotes into clauses under their heading path', () => {
    const clauses = parse();
    const byText = (needle) => clauses.find((clause) => clause.text.includes(needle));

    expect(byText('one-line pitch')?.headingPath).toBe('');
    expect(byText('Thing one')?.headingPath).toBe('Goals');
    expect(byText('Thing two')?.headingPath).toBe('Goals');

    const fr1 = byText('FR-1');
    expect(fr1.headingPath).toBe('Functional Requirements');
    // The row is flattened into one sentence, acceptance column included, and
    // the header row + divider are not clauses of their own.
    expect(fr1.text).toBe("FR-1 — The system MUST keep every record on the operator's own machine. — Must");
    expect(clauses.some((clause) => clause.text.startsWith('ID —'))).toBe(false);

    // The blockquote marker is stripped; the fenced `#` line is not a heading
    // and its body is not a clause.
    expect(byText('quoted note')?.text.startsWith('A quoted note')).toBe(true);
    expect(clauses.some((clause) => clause.text.includes('heading-looking comment'))).toBe(false);
    expect(clauses.some((clause) => clause.headingPath.includes('This heading-looking'))).toBe(false);
  });

  it('keeps a clause id stable when unrelated text is inserted earlier in the file', () => {
    const before = parse();
    const target = before.find((clause) => clause.text.includes('FR-2'));

    const edited = DOC.replace(
      '## Goals\n',
      '## Goals\n\nAn entirely new paragraph inserted ahead of everything that follows it.\n',
    );
    const after = parsePrdClauses(edited, { sourceFile: 'PRD.md' });
    const moved = after.find((clause) => clause.text.includes('FR-2'));

    // This is the regression the id scheme exists for: a verdict recorded
    // against a clause last week must still address that clause today.
    expect(moved.id).toBe(target.id);
    expect(moved.line).toBeGreaterThan(target.line);
    expect(after.length).toBe(before.length + 1);
  });

  it('gives byte-identical clauses under one heading distinct ids', () => {
    const repeated = '## Repeats\n\nThe very same sentence twice over, stated identically.\n\nThe very same sentence twice over, stated identically.\n';
    const ids = parsePrdClauses(repeated, { sourceFile: 'GOALS.md' }).map((clause) => clause.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('caps a clause at the premise budget and drops the document title from the citation', () => {
    const long = `# Title\n\n## Long\n\n${'word '.repeat(2000)}\n`;
    const [clause] = parsePrdClauses(long, { sourceFile: 'PRD.md' });
    expect(clause.text.length).toBeLessThanOrEqual(PRD_MAX_CLAUSE_CHARS);
    // A single H1 is a title, not a section, so it never appears in a citation.
    expect(formatClauseCitation(clause)).toBe('PRD.md § Long');
  });

  it('parses this repository\'s own PRD.md and GOALS.md into a unique, non-empty corpus', async () => {
    // The corpus is the feature's whole input. A parser change that silently
    // collapsed these two files would leave scoring with nothing to retrieve.
    const root = join(import.meta.dirname, '..', '..');
    const clauses = [];
    for (const sourceFile of PRD_CLAUSE_SOURCES) {
      clauses.push(...parsePrdClauses(await readFile(join(root, sourceFile), 'utf8'), { sourceFile }));
    }
    expect(clauses.length).toBeGreaterThan(50);
    expect(indexClausesById(clauses).size).toBe(clauses.length);
    expect(clauses.every((clause) => clause.text.length <= PRD_MAX_CLAUSE_CHARS)).toBe(true);
  });
});
