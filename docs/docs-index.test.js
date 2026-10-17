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
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const DOCS_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(DOCS_DIR, 'README.md'), 'utf8');

const markdownIn = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);

const LIVING_DOCS = [
  ...markdownIn(DOCS_DIR).filter((name) => name !== 'README.md'),
  ...markdownIn(join(DOCS_DIR, 'features')).map((name) => `features/${name}`),
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
