import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNativeGrokUsageCoverage } from './nativeGrokUsageCoverage.js';
import { getNativeTranscriptCoverage } from './nativeTranscriptCoverage.js';

// The attribution corpus's hand-authored outcomes, run through the production readers from
// raw files. Scenarios mixing report capabilities describe a record union across machines,
// which the Usage view no longer performs, so they stay in the corpus's own reference test.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../lib/fixtures/nativeUsageModelAttribution/v1');
const load = name => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const readable = ({ reports }) => reports.every(({ capability }) => capability === 'model-attribution-v1');

let home;
const save = async (path, text) => {
  const target = join(home, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
};
const outcome = ({ modelUsage, totals }) => {
  const groups = { model: {}, unknown: {}, unallocated: {} };
  for (const { kind, key, counters } of modelUsage.buckets) {
    const prior = groups[kind][key];
    groups[kind][key] = prior ? Object.fromEntries(Object.entries(counters).map(([field, value]) => [field, prior[field] + value])) : counters;
  }
  return { providerTotals: totals, models: groups.model, unknown: groups.unknown, unallocated: groups.unallocated };
};

beforeEach(async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  home = await mkdtemp(join(tmpdir(), 'native-attribution-'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

describe('production readers match the attribution corpus', () => {
  it.each(load('claude.json').scenarios.filter(readable).map(scenario => [scenario.name, scenario]))('claude: %s', async (_name, scenario) => {
    const entries = scenario.reports.flatMap(report => report.entries);
    await Promise.all(entries.map((entry, index) => save(`.claude/projects/p/${index}.jsonl`, `${JSON.stringify(entry)}\n`)));
    const scan = await getNativeTranscriptCoverage('claude', { home, includeRecords: true, modelLimits: scenario.limits });
    const { providerTotals, models, unknown, unallocated } = scenario.expect;
    expect(outcome(scan.rollup)).toEqual({ providerTotals, models, unknown, unallocated });
  });

  it.each(load('grok.json').scenarios.filter(readable).map(scenario => [scenario.name, scenario]))('grok: %s', async (_name, scenario) => {
    const snapshots = scenario.reports.flatMap(report => report.snapshots);
    await Promise.all(snapshots.map((snapshot, index) => save(`.grok/sessions/p/${index}/usage.json`, JSON.stringify(snapshot))));
    const scan = await getNativeGrokUsageCoverage({ home, modelLimits: scenario.limits });
    const { providerTotals, models, unknown, unallocated, incompleteRecords } = scenario.expect;
    expect(outcome(scan.rollup)).toEqual({ providerTotals, models, unknown, unallocated });
    expect(scan.rollup.modelUsage.buckets.some(bucket => bucket.incompleteRecords > 0)).toBe(incompleteRecords > 0);
  });
});
