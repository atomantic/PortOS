import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAlwaysRunTests } from '../ci-test-plan.js';
import { GUARD_BUDGET_MS, CALIBRATION_REFERENCE_MS, MAX_BUDGET_SCALE, calibrateBudgetScale, hostTooBusyForBudget, overBudgetGuards, readGuardDurations, settleOverBudget } from './guardBudget.js';

describe('guard budget', () => {
  it('names each guard over budget, slowest first', () => {
    const over = overBudgetGuards({
      'docs/api-doc.test.js': GUARD_BUDGET_MS,
      'scripts/new-scanner.test.js': GUARD_BUDGET_MS + 1,
      'server/slow-scanner.test.js': GUARD_BUDGET_MS + 500,
    });
    expect(over.map(({ file }) => file)).toEqual(['server/slow-scanner.test.js', 'scripts/new-scanner.test.js']);
  });

  it('scales the budget on a 2x slower machine yet still fails a guard 2x slower than its base', () => {
    const base = 2000; // a guard comfortably inside the reference budget
    for (const slowdown of [1, 2]) {
      const scale = calibrateBudgetScale({ measure: () => CALIBRATION_REFERENCE_MS * slowdown });
      const budgetMs = GUARD_BUDGET_MS * scale;
      // Unrelated guard at its normal cost on this machine passes.
      expect(overBudgetGuards({ 'ok.test.js': base * slowdown }, budgetMs)).toEqual([]);
      // The same guard made 2x slower than its base fails on fast and slow machines.
      expect(overBudgetGuards({ 'regressed.test.js': base * slowdown * 2 }, budgetMs).map(({ file }) => file)).toEqual(['regressed.test.js']);
    }
    // 4.2s is over the fixed budget but within the budget scaled for a 2x slower machine.
    expect(overBudgetGuards({ 'g.test.js': 4200 })).toHaveLength(1);
    expect(overBudgetGuards({ 'g.test.js': 4200 }, GUARD_BUDGET_MS * 2)).toEqual([]);
  });

  it('never scales below 1, above the cap, or off a bad reading', () => {
    expect(calibrateBudgetScale({ measure: () => CALIBRATION_REFERENCE_MS / 4 })).toBe(1);
    expect(calibrateBudgetScale({ measure: () => CALIBRATION_REFERENCE_MS * 100 })).toBe(MAX_BUDGET_SCALE);
    expect(calibrateBudgetScale({ measure: () => Number.NaN })).toBe(1);
    // Fastest of the runs wins, so one hiccup does not inflate the scale.
    const readings = [CALIBRATION_REFERENCE_MS * 5, CALIBRATION_REFERENCE_MS, CALIBRATION_REFERENCE_MS * 3];
    expect(calibrateBudgetScale({ measure: () => readings.shift() })).toBe(1);
  });

  it('keeps ensure-deps out of the always-run list', () => {
    expect(getAlwaysRunTests()).not.toContain('scripts/ensure-deps.test.js');
  });

  it('skips enforcement only while load exceeds the core count', () => {
    expect(hostTooBusyForBudget({ load: 20, cores: 8 })).toBe(true);
    expect(hostTooBusyForBudget({ load: 8, cores: 8 })).toBe(false);
    expect(hostTooBusyForBudget({ load: 0, cores: 8 })).toBe(false);
  });

  it('clears a guard an isolated re-run fits in budget and keeps one still over', () => {
    const over = overBudgetGuards({ 'a.test.js': 5000, 'b.test.js': 4000, 'c.test.js': 4500 });
    const { cleared, stillOver } = settleOverBudget(over, { 'a.test.js': 900, 'b.test.js': GUARD_BUDGET_MS + 1 });
    expect(cleared.map(({ file }) => file)).toEqual(['a.test.js']);
    expect(cleared[0]).toMatchObject({ durationMs: 5000, isolatedMs: 900 });
    // b is over in both; c has no isolated reading, so it is never excused.
    expect(stillOver.map(({ file, durationMs, isolatedMs }) => [file, durationMs, isolatedMs])).toEqual([
      ['c.test.js', 4500, null],
      ['b.test.js', 4000, GUARD_BUDGET_MS + 1],
    ]);
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
