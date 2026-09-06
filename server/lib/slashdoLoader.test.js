import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const { fixtureRoot } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  return { fixtureRoot: mkdtempSync(join(tmpdir(), 'slashdo-loader-')) };
});
vi.mock('./fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS,
    slashdo: fixtureRoot, slashdoResolved: `${fixtureRoot}/resolved`,
  } };
});
import { loadSlashdoLib, loadSlashdoFile, loadSlashdoBundle, writeResolvedSlashdoBody } from './slashdoLoader.js';
import { requireSlashdoSubmoduleInCi } from './testHelper.js';

const source = fileURLToPath(new URL('../../lib/slashdo/src', import.meta.url));
const hasSubmodule = existsSync(join(source, 'transformer.js'));
requireSlashdoSubmoduleInCi(hasSubmodule);
const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};
beforeAll(() => {
  // The upstream renderer has its own fixture matrix. These exercise the real
  // PortOS adapter and staging boundary when the bundled submodule is available.
  if (hasSubmodule) cpSync(source, join(fixtureRoot, 'src'), { recursive: true });
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe.skipIf(!hasSubmodule)('slashdo rendering adapter', () => {
  it('keeps command/lib eager consumers self-contained and resolves host capabilities', async () => {
    const lib = 'run "$PROMPT" $& $`tail\n<!-- if:teams -->IN_PROCESS<!-- else -->SUBPROCESS<!-- /if:teams -->';
    write(join(fixtureRoot, 'lib/example.md'), lib);
    write(join(fixtureRoot, 'commands/do/example.md'), '---\ndescription: Example\n---\n!`cat ~/.claude/lib/example.md`');
    const body = await loadSlashdoFile('example', { stripFrontmatter: true });
    expect(body).toContain('run "$PROMPT" $& $`tail');
    expect(body).toContain('SUBPROCESS');
    expect(body).not.toContain('IN_PROCESS');
    expect(body).not.toContain('description:');
    expect(await loadSlashdoLib('example', { teams: true })).toContain('IN_PROCESS');
    expect(await loadSlashdoLib('example')).toContain('SUBPROCESS');
  });

  it('renders the bundled scoped review without rejecting it or enabling public edits', async () => {
    const { buildReviewLoopFollowUpSection } = await import('../services/promptSections/reviewLifecycle.js');
    const recipe = readFileSync(new URL('../../lib/slashdo/lib/local-agent-review-loop.md', import.meta.url), 'utf8');
    write(join(fixtureRoot, 'lib/scoped-review.md'), recipe);
    const body = await loadSlashdoLib('scoped-review');
    const prompt = buildReviewLoopFollowUpSection(
      { reviewLoopReviewers: ['claude', 'antigravity', 'codex'], reviewLoopReviewerApplies: true },
      { localOnly: true, baseBranch: 'main', localAgentLoopBody: body },
    );

    expect(prompt).not.toContain('entire recipe was rejected');
    expect(prompt).toContain('--tools "Read,Glob,Grep" --allowedTools "Read,Glob,Grep"');
    expect(prompt).toContain('--strict-mcp-config');
    expect(prompt).toContain('disableAllHooks');
    expect(prompt).toMatch(/Inlining a\s+diff alone is not tool isolation/);
    expect(prompt).toContain('--sandbox read-only review --base');
    expect(prompt).not.toContain('--sandbox workspace-write');
    expect(prompt).not.toContain('--sandbox danger-full-access');
    expect(prompt).not.toContain('agy --dangerously');
    expect(prompt).toContain('Reviewer applies (off)');
  });

  it('keeps inline reviewer recipes limited to explicit reads', async () => {
    write(join(fixtureRoot, 'lib/recipe.md'), 'Recipe\n!read lib/required.md\nSee `lib/unrelated.md`.');
    write(join(fixtureRoot, 'lib/required.md'), 'Required verification');
    write(join(fixtureRoot, 'lib/unrelated.md'), 'Unrelated reviewer workflow');
    const body = await loadSlashdoLib('recipe');
    expect(body).toContain('Required verification');
    expect(body).not.toContain('Unrelated reviewer workflow');
    expect(body).not.toContain('!read');
  });

  it('stages deferred phase reads and keeps different reviewer bundles independent', async () => {
    write(join(fixtureRoot, 'commands/do/phases.md'), '# Workflow\n!read lib/audit.md\n!read lib/local-agent-review-loop.md');
    write(join(fixtureRoot, 'lib/audit.md'), 'Required audit phase\n!read lib/verify.md');
    write(join(fixtureRoot, 'lib/verify.md'), 'Required verification');
    write(join(fixtureRoot, 'lib/local-agent-review-loop.md'), 'Required local review');
    const full = await loadSlashdoBundle('phases');
    const pruned = await loadSlashdoBundle('phases', { skipIncludes: ['local-agent-review-loop'] });
    const fullPath = await writeResolvedSlashdoBody('phases', full.body, { files: full.files });
    const prunedPath = await writeResolvedSlashdoBody('phases', pruned.body, { files: pruned.files });
    expect(fullPath).not.toBe(prunedPath);
    expect(readFileSync(fullPath, 'utf8')).toContain('lib/audit.md');
    expect(readFileSync(join(dirname(fullPath), 'lib/audit.md'), 'utf8')).toContain('./verify.md');
    expect(readFileSync(join(dirname(fullPath), 'lib/verify.md'), 'utf8')).toContain('Required verification');
    expect(pruned.files).not.toHaveProperty('local-agent-review-loop.md');
    expect(full.files).toHaveProperty('local-agent-review-loop.md');
    const eager = await loadSlashdoFile('phases');
    expect(eager).toContain('Required verification');
    expect(eager).toContain('Required local review');
    expect(eager).not.toContain('!read');
  });

  it('distinguishes absent commands from missing required dependencies', async () => {
    expect(await loadSlashdoFile('no-such-command')).toBeNull();
    write(join(fixtureRoot, 'commands/do/broken.md'), '!read lib/no-such-library.md');
    await expect(loadSlashdoBundle('broken')).rejects.toThrow();
  });
});

describe('immutable slashdo staging', () => {
  it('addresses the entire bundle by content, preserving earlier dispatched procedures', async () => {
    const body = 'Read lib/review.md';
    const oldPath = await writeResolvedSlashdoBody('review', body, { files: { 'review.md': 'Original review' } });
    const newPath = await writeResolvedSlashdoBody('review', body, { files: { 'review.md': 'Updated review' } });
    expect(newPath).not.toBe(oldPath);
    expect(readFileSync(join(dirname(oldPath), 'lib/review.md'), 'utf8')).toBe('Original review');
    expect(readFileSync(join(dirname(newPath), 'lib/review.md'), 'utf8')).toBe('Updated review');
    expect(await writeResolvedSlashdoBody('review', body, { files: { 'review.md': 'Updated review' } })).toBe(newPath);
  });

  it('rejects unsafe output paths before writing the entrypoint', async () => {
    expect(await writeResolvedSlashdoBody('../outside', 'Body')).toBeNull();
    await expect(writeResolvedSlashdoBody('review', 'Body', { files: { '../outside.md': 'Outside' } })).rejects.toThrow('Invalid slashdo supporting file');
    await expect(writeResolvedSlashdoBody('review', 'Body', { files: { 'invalid.md': null } })).rejects.toThrow('Invalid slashdo supporting file');
    expect(existsSync(join(fixtureRoot, 'outside.md'))).toBe(false);
  });
});
