import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  EDITORIAL_CHECKS,
  CHECK_SCOPES,
  CHECK_KINDS,
  getCheck,
  listChecks,
  assertValidChecks,
  resolveCheckConfig,
  resolveCheckState,
  getEnabledChecks,
} from './checkRegistry.js';

const NAMING = 'naming.dissimilar-names';
const INFODUMP = 'prose.info-dumping';

describe('editorial check registry — shape invariants', () => {
  it('every entry has a valid shape', () => {
    for (const check of EDITORIAL_CHECKS) {
      expect(check.id, 'id').toBeTruthy();
      expect(check.label, `${check.id} label`).toBeTruthy();
      expect(CHECK_SCOPES, `${check.id} scope`).toContain(check.scope);
      expect(CHECK_KINDS, `${check.id} kind`).toContain(check.kind);
      expect(['high', 'medium', 'low'], `${check.id} severity`).toContain(check.severityDefault);
      expect(typeof check.run, `${check.id} run`).toBe('function');
      expect(typeof check.configSchema?.safeParse, `${check.id} configSchema`).toBe('function');
    }
  });

  it('ships both reference checks (one deterministic, one llm)', () => {
    const ids = listChecks().map((c) => c.id);
    expect(ids).toContain(NAMING);
    expect(ids).toContain(INFODUMP);
    expect(getCheck(NAMING).kind).toBe('deterministic');
    expect(getCheck(INFODUMP).kind).toBe('llm');
  });

  it('getCheck returns null for an unknown id', () => {
    expect(getCheck('does.not-exist')).toBeNull();
  });
});

describe('editorial check registry — fail-fast guards', () => {
  const valid = {
    id: 'x.ok', label: 'ok', scope: 'series', kind: 'deterministic',
    category: 'naming', severityDefault: 'low', configSchema: z.object({}), run: () => [],
  };

  it('accepts a valid set', () => {
    expect(() => assertValidChecks([valid])).not.toThrow();
  });

  it('throws on a missing required field', () => {
    expect(() => assertValidChecks([{ ...valid, label: '' }])).toThrow(/malformed/);
  });

  it('throws on an invalid scope', () => {
    expect(() => assertValidChecks([{ ...valid, scope: 'galaxy' }])).toThrow(/invalid scope/);
  });

  it('throws on an invalid kind', () => {
    expect(() => assertValidChecks([{ ...valid, kind: 'magic' }])).toThrow(/invalid kind/);
  });

  it('throws on an invalid severityDefault', () => {
    expect(() => assertValidChecks([{ ...valid, severityDefault: 'critical' }])).toThrow(/severityDefault/);
  });

  it('throws on a missing run()', () => {
    expect(() => assertValidChecks([{ ...valid, run: undefined }])).toThrow(/run\(\)/);
  });

  it('throws on a missing configSchema', () => {
    expect(() => assertValidChecks([{ ...valid, configSchema: undefined }])).toThrow(/configSchema/);
  });

  it('throws on a duplicate id', () => {
    expect(() => assertValidChecks([valid, { ...valid }])).toThrow(/duplicate id/);
  });
});

describe('editorial check registry — config + state resolution', () => {
  it('resolveCheckConfig fills schema defaults', () => {
    const cfg = resolveCheckConfig(getCheck(NAMING), undefined);
    expect(cfg.minSharedSignals).toBe(2);
  });

  it('resolveCheckConfig falls back to defaults on an invalid blob', () => {
    const cfg = resolveCheckConfig(getCheck(NAMING), { minSharedSignals: 'lots' });
    expect(cfg.minSharedSignals).toBe(2);
  });

  it('resolveCheckState merges persisted enable/config over defaults', () => {
    const rows = resolveCheckState({
      pipelineEditorialChecks: { checks: { [NAMING]: { enabled: false, config: { minSharedSignals: 3 } } } },
    });
    const naming = rows.find((r) => r.id === NAMING);
    expect(naming.enabled).toBe(false);
    expect(naming.config.minSharedSignals).toBe(3);
    // Unconfigured check keeps its default-enabled state.
    expect(rows.find((r) => r.id === INFODUMP).enabled).toBe(true);
  });

  it('getEnabledChecks honors disable + subset narrowing', () => {
    const settings = { pipelineEditorialChecks: { checks: { [INFODUMP]: { enabled: false } } } };
    const enabled = getEnabledChecks(settings).map((x) => x.check.id);
    expect(enabled).toContain(NAMING);
    expect(enabled).not.toContain(INFODUMP);

    const subset = getEnabledChecks({}, [NAMING]).map((x) => x.check.id);
    expect(subset).toEqual([NAMING]);
  });
});

describe('naming.dissimilar-names — deterministic check', () => {
  const run = (characters, config = { minSharedSignals: 2 }) =>
    getCheck(NAMING).run({ canon: { characters }, config, severityDefault: 'low' });

  it('flags confusable name pairs', () => {
    const findings = run([{ name: 'Alina' }, { name: 'Alana' }, { name: 'Zog' }]);
    expect(findings.length).toBeGreaterThan(0);
    const f = findings[0];
    expect(f.category).toBe('naming');
    expect(f.anchorQuote).toBeTruthy();
    expect(f.problem).toMatch(/confuse/i);
  });

  it('does not flag clearly distinct names', () => {
    const findings = run([{ name: 'Alina' }, { name: 'Zog' }, { name: 'Bree' }]);
    expect(findings).toEqual([]);
  });

  it('respects the minSharedSignals threshold', () => {
    const chars = [{ name: 'Sam' }, { name: 'Sun' }]; // share first letter + length
    expect(run(chars, { minSharedSignals: 2 }).length).toBe(1);
    expect(run(chars, { minSharedSignals: 4 }).length).toBe(0);
  });

  it('tolerates empty / nameless canon', () => {
    expect(run([])).toEqual([]);
    expect(run([{}, { name: '' }])).toEqual([]);
  });
});
