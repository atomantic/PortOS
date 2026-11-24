import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractPlanSlugs,
  appendProposalToPlan,
} from './planFiler.js';

describe('extractPlanSlugs', () => {
  it('collects lil-tagged slugs with their checkbox state from PLAN.md content', () => {
    const plan = `## Next Up\n- [ ] [lil-add-metrics] Add metrics\n- [ ] [lil-fix-thing] Fix\n- [ ] [ref-watch-other] not ours`;
    expect(extractPlanSlugs(plan)).toEqual([
      { slug: 'add-metrics', state: 'open' },
      { slug: 'fix-thing', state: 'open' }
    ]);
  });

  it('reads a checked `- [x]` item as closed and an unchecked one as open (#2435)', () => {
    const plan = `## Done\n- [x] [lil-add-metrics] Add metrics\n## Next Up\n- [ ] [lil-fix-thing] Fix`;
    expect(extractPlanSlugs(plan)).toEqual([
      { slug: 'add-metrics', state: 'closed' },
      { slug: 'fix-thing', state: 'open' }
    ]);
  });

  it('treats an uppercase `- [X]` checkbox as closed', () => {
    expect(extractPlanSlugs('- [X] [lil-shipped] done')).toEqual([
      { slug: 'shipped', state: 'closed' }
    ]);
  });

  it('treats a bare tag with no checkbox as open (absent ≠ done)', () => {
    // A tag mentioned inline, with no list checkbox, must NOT collapse to closed
    // (which would mark it completed in the outcome loop) — it stays open.
    expect(extractPlanSlugs('see [lil-inline-ref] elsewhere')).toEqual([
      { slug: 'inline-ref', state: 'open' }
    ]);
  });

  it('returns [] for non-string / empty', () => {
    expect(extractPlanSlugs(null)).toEqual([]);
    expect(extractPlanSlugs('')).toEqual([]);
  });
});

describe('appendProposalToPlan', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-plan-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('creates PLAN.md with a Next Up section when absent', async () => {
    const res = await appendProposalToPlan({ repoPath: dir, appName: 'App', slug: 'add-x', title: 'Add X', body: 'do it' });
    expect(res).toEqual({ success: true, duplicate: false });
    const content = await readFile(join(dir, 'PLAN.md'), 'utf-8');
    expect(content).toContain('# App — Development Plan');
    expect(content).toContain('## Next Up');
    expect(content).toContain('[lil-add-x]');
  });

  it('is a no-op (duplicate) when the slug tag already exists', async () => {
    await writeFile(join(dir, 'PLAN.md'), '## Next Up\n- [ ] [lil-add-x] existing\n');
    const res = await appendProposalToPlan({ repoPath: dir, appName: 'App', slug: 'add-x', title: 'Add X', body: 'b' });
    expect(res.duplicate).toBe(true);
  });

  it('inserts under an existing Next Up heading that has NO trailing newline (no duplicate section)', async () => {
    await writeFile(join(dir, 'PLAN.md'), '# Plan\n\n## Next Up'); // ends at heading, no newline
    const res = await appendProposalToPlan({ repoPath: dir, appName: 'App', slug: 'add-x', title: 'Add X', body: 'b' });
    expect(res.duplicate).toBe(false);
    const content = await readFile(join(dir, 'PLAN.md'), 'utf-8');
    // Exactly one Next Up section, item on its own line.
    expect(content.match(/## Next Up/g)).toHaveLength(1);
    expect(content).toContain('\n- [ ] [lil-add-x]');
  });

  it('files a proposal containing replacement patterns verbatim', async () => {
    await writeFile(join(dir, 'PLAN.md'), '# Plan\n\n## Next Up\n- [ ] older\n');
    await appendProposalToPlan({ repoPath: dir, appName: 'App', slug: 'add-x', title: 'Escape $&', body: "Keep $1, $$ and $' as typed" });
    expect(await readFile(join(dir, 'PLAN.md'), 'utf-8'))
      .toBe("# Plan\n\n## Next Up\n- [ ] [lil-add-x] **Escape $&** Keep $1, $$ and $' as typed\n- [ ] older\n");
  });

  it('appends a Next Up section when the file exists without one', async () => {
    await writeFile(join(dir, 'PLAN.md'), '# Plan\n\nSome notes.\n');
    await appendProposalToPlan({ repoPath: dir, appName: 'App', slug: 'add-x', title: 'Add X', body: 'b' });
    const content = await readFile(join(dir, 'PLAN.md'), 'utf-8');
    expect(content).toContain('## Next Up');
    expect(content).toContain('[lil-add-x]');
  });
});
