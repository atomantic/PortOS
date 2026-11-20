import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAlwaysRunTests } from '../ci-test-plan.js';
import { GUARD_BUDGET_MS, describeGuardDurations, overBudgetGuards, readGuardDurations } from './guardBudget.js';

describe('guard budget', () => {
  it('names each guard over budget, slowest first', () => {
    const over = overBudgetGuards({
      'server/test/guards/repo.guard.test.js': GUARD_BUDGET_MS,
      'scripts/new-scanner.test.js': GUARD_BUDGET_MS + 1,
      'server/slow-scanner.test.js': GUARD_BUDGET_MS + 500,
    });
    expect(over.map(({ file }) => file)).toEqual(['server/slow-scanner.test.js', 'scripts/new-scanner.test.js']);
    expect(describeGuardDurations(over)).toBe('server/slow-scanner.test.js 3.5s; scripts/new-scanner.test.js 3.0s');
  });

  it('keeps ensure-deps out of the always-run list', () => {
    expect(getAlwaysRunTests()).not.toContain('scripts/ensure-deps.test.js');
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
