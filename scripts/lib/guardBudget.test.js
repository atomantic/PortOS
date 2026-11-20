import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAlwaysRunTests } from '../ci-test-plan.js';
import { GUARD_BUDGET_MS, describeGuardDurations, guardDurations, overBudgetGuards, readGuardDurations, readGuardLoads } from './guardBudget.js';

describe('guard budget', () => {
  it('names each guard over budget, slowest first', () => {
    const over = overBudgetGuards({
      'server/test/guards/repo.guard.test.js': GUARD_BUDGET_MS,
      'scripts/new-scanner.test.js': GUARD_BUDGET_MS + 1,
      'server/slow-scanner.test.js': GUARD_BUDGET_MS + 500,
    });
    expect(over.map(({ file }) => file)).toEqual(['server/slow-scanner.test.js', 'scripts/new-scanner.test.js']);
    const seconds = (ms) => (ms / 1000).toFixed(1);
    expect(describeGuardDurations(over)).toBe(`server/slow-scanner.test.js ${seconds(GUARD_BUDGET_MS + 500)}s; scripts/new-scanner.test.js ${seconds(GUARD_BUDGET_MS + 1)}s`);
  });

  it("budgets a structural guard runner's checks, not the runner, and other files whole (#16996)", () => {
    const runner = 'server/test/guards/repo.guard.test.js';
    expect(guardDurations([
      { file: runner, durationMs: 9000, checks: { scriptReferences: 700, docsIndex: 20 } },
      { file: 'server/lib/importScoping.test.js', durationMs: 800, checks: { 'import growth': 790 } },
      { file: 'server/lib/crashed.test.js', durationMs: null, checks: {} },
    ])).toEqual({
      [`${runner} > scriptReferences`]: 700,
      [`${runner} > docsIndex`]: 20,
      'server/lib/importScoping.test.js': 800,
    });
    // A check's load (imports and module-scope work) is charged to it; a load from a runner this run did not include is not.
    expect(guardDurations([{ file: runner, durationMs: 50, checks: { scan: 10 } }], [
      { runner, check: 'scan', ms: 30 }, { runner, check: 'loadOnly', ms: 40 },
      { runner: 'server/test/guards/runtime.guard.test.js', check: 'other', ms: 99 },
    ])).toEqual({ [`${runner} > scan`]: 40, [`${runner} > loadOnly`]: 40 });
    // A slow check is named by its runner and check, never hidden in the runner's total.
    expect(overBudgetGuards(guardDurations([{ file: runner, durationMs: 1, checks: { slow: GUARD_BUDGET_MS + 1 } }])).map(({ file }) => file))
      .toEqual([`${runner} > slow`]);
  });

  it('keeps ensure-deps out of the always-run list', () => {
    expect(getAlwaysRunTests()).not.toContain('scripts/ensure-deps.test.js');
  });

  it('reads a runner load log, skipping malformed lines, and treats a missing log as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-guard-loads-'));
    try {
      const path = join(dir, 'loads.jsonl');
      writeFileSync(path, `${JSON.stringify({ runner: 'r', check: 'c', ms: 5 })}\nnot json\n${JSON.stringify({ runner: 'r', check: 'c' })}\n`);
      expect(readGuardLoads(path)).toEqual([{ runner: 'r', check: 'c', ms: 5 }]);
      expect(readGuardLoads(join(dir, 'missing.jsonl'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
