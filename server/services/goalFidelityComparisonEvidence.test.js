import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comparisonReferenceEvidence } from './goalFidelityComparisonEvidence.js';

// The public #15627 diff exposes observations that were already on its base.
const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/goal-fidelity-comparison-chart.json', import.meta.url), 'utf8'));

describe('comparison evidence for goal-fidelity review', () => {
  let repo, base, head;
  const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
  const catalog = observations => writeFileSync(join(repo, 'data.reference/model-comparison.json'), JSON.stringify({ observations }));
  const evidence = (overrides = {}) => comparisonReferenceEvidence({
    workspacePath: repo, base, head, objective: fixture.objective, diff: fixture.diff, maxChars: 60_000, ...overrides,
  });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'portos-fidelity-comparison-'));
    git('init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'data.reference'));
    const olderVersion = { ...fixture.observations[0], id: 'older-model', model: 'claude-fable-5' };
    const estimated = { ...fixture.observations[0], id: 'estimated', quality: { ...fixture.observations[0].quality, source: { ...fixture.observations[0].quality.source, methodology: 'Publisher estimate: example' } } };
    catalog([...fixture.observations, olderVersion, estimated]);
    git('add', 'data.reference/model-comparison.json');
    git('commit', '-qm', 'seed comparison data');
    base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'change.txt'), 'chart change\n');
    git('add', 'change.txt');
    git('commit', '-qm', 'expose current chart');
    head = git('rev-parse', 'HEAD');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('supplies all five shipped score and cost pairs from the pinned commits, not the working tree', async () => {
    catalog([]);
    const rows = JSON.parse(await evidence());
    expect(rows.map(row => row.effort).sort()).toEqual(['high', 'low', 'max', 'medium', 'xhigh']);
    expect(rows.map(row => [row.quality.value, row.costPerTask.value]).sort()).toEqual(
      fixture.observations.map(row => [row.quality.value, row.costPerTask.value]).sort(),
    );
    expect(rows.every(row => row.model === 'claude-fable-5.2')).toBe(true);
  });

  it('does not present deleted or changed rows as unchanged evidence', async () => {
    catalog(fixture.observations.slice(1).map((row, index) => index === 0
      ? { ...row, costPerTask: { ...row.costPerTask, value: 999 } } : row));
    git('add', 'data.reference/model-comparison.json');
    git('commit', '-qm', 'change catalog');
    head = git('rev-parse', 'HEAD');
    const rows = JSON.parse(await evidence());
    expect(rows).toHaveLength(3);
    expect(rows.some(row => row.costPerTask.value === 999)).toBe(false);
  });

  it('does not include unrelated work, a different version, missing commits, or partial evidence', async () => {
    expect(await evidence({ objective: 'Fix the comparison chart for fable-5.3.' })).toBeNull();
    expect(await evidence({ diff: 'diff --git a/server/unrelated.js b/server/unrelated.js\n+fable-5.2' })).toBeNull();
    expect(await evidence({ diff: fixture.diff.replace(
      '+  const composites = [catalog?.currentComposite, catalog?.composite].filter(Boolean);',
      '+  const composites = [catalog?.composite].filter(Boolean);',
    ) })).toBeNull();
    expect(await evidence({ diff: fixture.diff.replace(
      '+    res.json({ ...catalog, inventory, composite, currentComposite });',
      '+    res.json({ ...catalog, inventory, composite });',
    ) })).toBeNull();
    expect(await evidence({ diff: fixture.diff.replace(
      "+      const taskRow = latest(modelRows.filter(row => effortKey(row.effort) === effort && row.benchmark === anchor), 'costPerTask');",
      '+      const taskRow = null;',
    ) })).toBeNull();
    expect(await evidence({ diff: fixture.diff.replace(
      "+    if (anchors.has(key)) return evidenceMetric(anchors.get(key), 'quality', anchor);",
      '+    if (anchors.has(key)) return null;',
    ) })).toBeNull();
    expect(await evidence({ diff: fixture.diff.replace(
      "+export const CURRENT_COMPARISON_ANCHOR = 'Artificial Analysis Intelligence Index v5.0.1';",
      "+export const CURRENT_COMPARISON_ANCHOR = 'Different benchmark';",
    ) })).toBeNull();
    expect(await evidence({ head: 'a'.repeat(40) })).toBeNull();
    expect(await evidence({ maxChars: 200 })).toBeNull();
  });
});
