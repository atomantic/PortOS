/**
 * Index guard for docs/README.md.
 *
 * The index opens with "Index of everything under `docs/`", and AGENTS.md sends
 * contributors there as the documentation entry point. Nothing enforced that
 * claim, so living guides (JEV_SETUP, PROMPT_GUARD_SETUP, tailcat-peers, ...)
 * accumulated outside it and were effectively undiscoverable.
 *
 * Every top-level docs/*.md and docs/features/*.md must be linked from the
 * index by its relative path. Decision records, plans, research, and the
 * point-in-time directories are deliberately out of scope: the index presents
 * them as examples and per-directory READMEs rather than a complete list.
 */
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

const DOCS_DIR = join(REPO_ROOT, 'docs');
const INDEX = readText(join(DOCS_DIR, 'README.md'));

const markdownIn = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);

const LIVING_DOCS = [
  ...markdownIn(DOCS_DIR).filter((name) => name !== 'README.md'),
  ...markdownIn(join(DOCS_DIR, 'features')).map((name) => `features/${name}`),
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MAX_DOC_BYTES = 40 * 1024;
const RATCHET_SLACK_BYTES = 2 * 1024;

// Grandfathered byte ceilings for living docs that currently exceed 40 KB.
// Each ceiling must stay within 2 KB of the file's actual size so shrinking
// a doc forces its entry down or out.
const SIZE_RATCHET_CEILINGS = {
  'BACKUP.md': 48200,
  'HTML_COMPOSITIONS.md': 67233,
  'TROUBLESHOOTING.md': 46000,
  'FEDERATED_MEDIA_PROVIDERS.md': 45625,
  'QUOTA-BURN.md': 44909,
};

describe('docs/README.md index coverage', () => {
  it('discovers the living docs it guards', () => {
    expect(LIVING_DOCS).toContain('JEV_SETUP.md');
    expect(LIVING_DOCS).toContain('features/tailcat-peers.md');
  });

  it.each(LIVING_DOCS)('links %s by its relative path', (doc) => {
    const link = new RegExp(`\\]\\((\\./)?${escapeRegExp(doc)}(#[^)]*)?\\)`);
    expect(INDEX, `docs/README.md must link ./${doc}`).toMatch(link);
  });
});

describe('living doc size ratchet', () => {
  it('only lists existing living docs above 40 KB', () => {
    for (const [doc, ceiling] of Object.entries(SIZE_RATCHET_CEILINGS)) {
      expect(LIVING_DOCS, `${doc} is not a living doc`).toContain(doc);
      expect(ceiling, `${doc} ceiling should be > ${MAX_DOC_BYTES}`).toBeGreaterThan(MAX_DOC_BYTES);
    }
  });

  it.each(LIVING_DOCS)('keeps %s within its byte ceiling', (doc) => {
    const size = statSync(join(DOCS_DIR, doc)).size;
    const ceiling = SIZE_RATCHET_CEILINGS[doc] ?? MAX_DOC_BYTES;
    expect(
      size,
      `${doc} (${size} B) exceeds ceiling (${ceiling} B); split by topic instead of appending`
    ).toBeLessThanOrEqual(ceiling);
    if (doc in SIZE_RATCHET_CEILINGS) {
      expect(
        ceiling - size,
        `${doc} shrank to ${size} B; lower or remove its SIZE_RATCHET_CEILINGS entry (${ceiling} B)`
      ).toBeLessThanOrEqual(RATCHET_SLACK_BYTES);
    }
  });
});
