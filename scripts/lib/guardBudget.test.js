import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAlwaysRunTests } from '../ci-test-plan.js';
import { GUARD_BUDGET_MS, hostTooBusyForBudget, OVER_BUDGET_CEILINGS_MS, overBudgetGuards, readGuardDurations } from './guardBudget.js';

describe('guard budget', () => {
  it('names each guard over budget, slowest first, and holds known-slow ones at their ceiling', () => {
    const slowKnown = 'server/deadExports.test.js';
    const over = overBudgetGuards({
      'docs/api-doc.test.js': GUARD_BUDGET_MS,
      'scripts/new-scanner.test.js': GUARD_BUDGET_MS + 1,
      [slowKnown]: OVER_BUDGET_CEILINGS_MS[slowKnown] - 1,
      'server/logLevelConventions.test.js': OVER_BUDGET_CEILINGS_MS['server/logLevelConventions.test.js'] + 500,
    });
    expect(over.map(({ file }) => file)).toEqual(['server/logLevelConventions.test.js', 'scripts/new-scanner.test.js']);
  });

  it('keeps ensure-deps out of the always-run list and only ceilings real always-run guards', () => {
    expect(getAlwaysRunTests()).not.toContain('scripts/ensure-deps.test.js');
    for (const file of Object.keys(OVER_BUDGET_CEILINGS_MS)) expect(getAlwaysRunTests(), file).toContain(file);
  });

  it('skips enforcement only while load exceeds the core count', () => {
    expect(hostTooBusyForBudget({ load: 20, cores: 8 })).toBe(true);
    expect(hostTooBusyForBudget({ load: 8, cores: 8 })).toBe(false);
    expect(hostTooBusyForBudget({ load: 0, cores: 8 })).toBe(false);
  });

  it('reads runner durations and treats a missing or malformed file as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-guard-budget-'));
    try {
      const path = join(dir, 'd.json');
      writeFileSync(path, '{"a.test.js":12}');
      expect(readGuardDurations(path)).toEqual({ 'a.test.js': 12 });
      writeFileSync(path, '[1]');
      expect(readGuardDurations(path)).toEqual({});
      expect(readGuardDurations(join(dir, 'missing.json'))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
