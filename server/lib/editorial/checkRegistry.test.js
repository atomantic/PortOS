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

  it('accepts a check with no configFields (optional)', () => {
    expect(() => assertValidChecks([{ ...valid, configFields: undefined }])).not.toThrow();
  });

  it('throws when configFields is not an array', () => {
    expect(() => assertValidChecks([{ ...valid, configFields: {} }])).toThrow(/configFields must be an array/);
  });

  it('throws on a malformed configField (missing key/label or bad type)', () => {
    expect(() => assertValidChecks([{ ...valid, configFields: [{ label: 'x', type: 'number' }] }])).toThrow(/malformed configField/);
    expect(() => assertValidChecks([{ ...valid, configFields: [{ key: 'k', label: 'x', type: 'galaxy' }] }])).toThrow(/malformed configField/);
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

  it('resolveCheckState surfaces each check\'s serializable configFields', () => {
    const rows = resolveCheckState({});
    const naming = rows.find((r) => r.id === NAMING);
    expect(Array.isArray(naming.configFields)).toBe(true);
    const field = naming.configFields.find((f) => f.key === 'minSharedSignals');
    expect(field).toMatchObject({ type: 'number', min: 1, max: 5 });
    expect(field.label).toBeTruthy();
    // Every declared config field is renderable (key + label + known type).
    for (const row of rows) {
      for (const f of row.configFields) {
        expect(f.key, `${row.id} field key`).toBeTruthy();
        expect(f.label, `${row.id} field label`).toBeTruthy();
        expect(['number', 'boolean', 'text'], `${row.id} field type`).toContain(f.type);
      }
    }
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

describe('prose.info-dumping — LLM check', () => {
  it('caps the manuscript sent to the model so a long corpus cannot overflow context', async () => {
    let sent = null;
    const ctx = {
      manuscript: 'x'.repeat(100_000),
      config: { maxManuscriptChars: 10_000, maxFindings: 12 },
      severityDefault: 'medium',
      callStagedLLM: async (_stage, vars) => { sent = vars.manuscript; return { content: { findings: [] } }; },
    };
    await getCheck(INFODUMP).run(ctx);
    expect(sent.length).toBeLessThan(11_000); // 10k cap + a short truncation note
    expect(sent).toContain('truncated');
  });

  it('passes a short manuscript through untruncated and shapes findings', async () => {
    const ctx = {
      manuscript: 'As you know, Bob, the kingdom fell.',
      config: { maxManuscriptChars: 48_000, maxFindings: 12 },
      severityDefault: 'medium',
      callStagedLLM: async (_stage, vars) => {
        expect(vars.manuscript).not.toContain('truncated');
        return { content: { findings: [{ severity: 'high', issueNumber: 1, problem: 'dump', anchorQuote: 'As you know', suggestion: 'cut' }] } };
      },
    };
    const findings = await getCheck(INFODUMP).run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('exposition');
    expect(findings[0].issueNumber).toBe(1);
  });

  it('respects maxFindings', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ severity: 'low', problem: `p${i}`, anchorQuote: `a${i}` }));
    const ctx = {
      manuscript: 'short',
      config: { maxManuscriptChars: 48_000, maxFindings: 5 },
      severityDefault: 'medium',
      callStagedLLM: async () => ({ content: { findings: many } }),
    };
    const findings = await getCheck(INFODUMP).run(ctx);
    expect(findings).toHaveLength(5);
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

describe('relationships.reciprocity — deterministic check', () => {
  const run = (characters) =>
    getCheck('relationships.reciprocity').run({ canon: { characters }, config: {}, severityDefault: 'low' });

  it('flags a one-sided link', () => {
    const findings = run([
      { id: 'a', name: 'Aria', relationshipLinks: [{ targetCharacterId: 'b', type: 'ally' }] },
      { id: 'b', name: 'Bram', relationshipLinks: [] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('continuity');
    expect(findings[0].problem).toMatch(/no link back/i);
  });

  it('does not flag a reciprocated pair', () => {
    const findings = run([
      { id: 'a', name: 'Aria', relationshipLinks: [{ targetCharacterId: 'b' }] },
      { id: 'b', name: 'Bram', relationshipLinks: [{ targetCharacterId: 'a' }] },
    ]);
    expect(findings).toEqual([]);
  });

  it('ignores links to nonexistent characters (the dangling-target check owns those)', () => {
    const findings = run([
      { id: 'a', name: 'Aria', relationshipLinks: [{ targetCharacterId: 'ghost' }] },
    ]);
    expect(findings).toEqual([]);
  });

  it('tolerates empty / link-less canon', () => {
    expect(run([])).toEqual([]);
    expect(run([{ id: 'a', name: 'Aria' }])).toEqual([]);
  });
});

describe('relationships.dangling-target — deterministic check', () => {
  const run = (characters) =>
    getCheck('relationships.dangling-target').run({ canon: { characters }, config: {}, severityDefault: 'medium' });

  it('flags a link pointing at a missing character id', () => {
    const findings = run([
      { id: 'a', name: 'Aria', relationshipLinks: [{ targetCharacterId: 'deleted-id', type: 'rival' }] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toMatch(/no longer exists/i);
    expect(findings[0].problem).toContain('deleted-id');
  });

  it('does not flag a link to an existing character', () => {
    const findings = run([
      { id: 'a', name: 'Aria', relationshipLinks: [{ targetCharacterId: 'b' }] },
      { id: 'b', name: 'Bram' },
    ]);
    expect(findings).toEqual([]);
  });

  it('tolerates empty canon', () => {
    expect(run([])).toEqual([]);
  });
});

describe('relationships.opposition-reversal — deterministic advisory', () => {
  const run = (characters) =>
    getCheck('relationships.opposition-reversal').run({ canon: { characters }, config: {}, severityDefault: 'low' });

  it('surfaces a tagged opposition pair once (deduped across reciprocal links)', () => {
    const findings = run([
      { id: 'a', name: 'Aria', relationshipLinks: [{ targetCharacterId: 'b', opposition: { axis: 'hunter/prey', thisRole: 'hunter', targetRole: 'prey' } }] },
      { id: 'b', name: 'Bram', relationshipLinks: [{ targetCharacterId: 'a', opposition: { axis: 'hunter/prey', thisRole: 'prey', targetRole: 'hunter' } }] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('arc');
    expect(findings[0].problem).toMatch(/hunter\/prey/);
  });

  it('surfaces two DIFFERENT axes on the same pair separately', () => {
    const findings = run([
      {
        id: 'a',
        name: 'Aria',
        relationshipLinks: [
          { id: 'r1', targetCharacterId: 'b', opposition: { axis: 'hunter/prey' } },
          { id: 'r2', targetCharacterId: 'b', opposition: { axis: 'winner/loser' } },
        ],
      },
      { id: 'b', name: 'Bram' },
    ]);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.problem.match(/axis "([^"]+)"/)[1]).sort())
      .toEqual(['hunter/prey', 'winner/loser']);
  });

  it('does not surface links without an opposition tag', () => {
    const findings = run([
      { id: 'a', name: 'Aria', relationshipLinks: [{ targetCharacterId: 'b', type: 'ally' }] },
      { id: 'b', name: 'Bram' },
    ]);
    expect(findings).toEqual([]);
  });

  it('is disabled by default (advisory)', () => {
    expect(getCheck('relationships.opposition-reversal').defaultEnabled).toBe(false);
  });
});

describe('objects.unattached-significant — deterministic check (#1288)', () => {
  const run = (objects, characters = []) =>
    getCheck('objects.unattached-significant').run({ canon: { objects, characters }, config: {}, severityDefault: 'low' });

  it('flags an object with significance but no attachments', () => {
    const findings = run([
      { id: 'o1', name: 'Pocket Watch', significance: 'her father gave it to her' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('continuity');
    expect(findings[0].location).toContain('Pocket Watch');
    expect(findings[0].problem).toMatch(/mean to anyone/i);
  });

  it('does not flag an object whose attachment resolves to a live character', () => {
    const findings = run(
      [{ id: 'o1', name: 'Pocket Watch', significance: 'matters', attachments: [{ characterId: 'c1' }] }],
      [{ id: 'c1', name: 'Mara' }],
    );
    expect(findings).toEqual([]);
  });

  it('flags an object whose only attachment dangles at a deleted character', () => {
    // The character was deleted, leaving a "(missing)" attachment — the object
    // is effectively unattached, so it must still surface.
    const findings = run(
      [{ id: 'o1', name: 'Pocket Watch', significance: 'matters', attachments: [{ characterId: 'gone' }] }],
      [{ id: 'c1', name: 'Mara' }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toContain('Pocket Watch');
  });

  it('does not flag an object with no significance (pure set dressing)', () => {
    const findings = run([{ id: 'o1', name: 'A Chair' }]);
    expect(findings).toEqual([]);
  });

  it('tolerates empty / id-less canon', () => {
    expect(run([])).toEqual([]);
    expect(run([{ significance: 'orphan, no id' }])).toEqual([]);
  });
});

describe('objects.unmotivated-interaction — LLM check (#1288)', () => {
  const baseCtx = (overrides = {}) => ({
    manuscript: 'She clutched the watch as if it meant everything.',
    canon: {
      objects: [{ id: 'o1', name: 'Watch', significance: 'heirloom', attachments: [{ characterId: 'c1', emotion: 'grief' }] }],
      characters: [{ id: 'c1', name: 'Mara' }],
    },
    config: { maxManuscriptChars: 48_000, maxFindings: 12 },
    severityDefault: 'low',
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('passes the manuscript AND an objects-attachment summary to the model', async () => {
    let vars = null;
    await getCheck('objects.unmotivated-interaction').run(baseCtx({
      callStagedLLM: async (_stage, v) => { vars = v; return { content: { findings: [] } }; },
    }));
    expect(vars.manuscript).toContain('clutched the watch');
    expect(vars.objects).toContain('Watch');
    expect(vars.objects).toContain('Mara'); // resolved character name, not the id
  });

  it('caps the manuscript so a long corpus cannot overflow context', async () => {
    let sent = null;
    await getCheck('objects.unmotivated-interaction').run(baseCtx({
      manuscript: 'x'.repeat(100_000),
      config: { maxManuscriptChars: 10_000, maxFindings: 12 },
      callStagedLLM: async (_stage, v) => { sent = v.manuscript; return { content: { findings: [] } }; },
    }));
    expect(sent.length).toBeLessThan(11_000);
    expect(sent).toContain('truncated');
  });

  it('shapes findings into the continuity category and respects maxFindings', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ severity: 'low', problem: `p${i}`, anchorQuote: `a${i}` }));
    const findings = await getCheck('objects.unmotivated-interaction').run(baseCtx({
      config: { maxManuscriptChars: 48_000, maxFindings: 4 },
      callStagedLLM: async () => ({ content: { findings: many } }),
    }));
    expect(findings).toHaveLength(4);
    expect(findings.every((f) => f.category === 'continuity')).toBe(true);
  });

  it('gates off when the manuscript is empty', () => {
    expect(getCheck('objects.unmotivated-interaction').gate(baseCtx({ manuscript: '   ' }))).toBe(false);
  });
});

describe('objects.backstory-consistency — LLM check (#1288)', () => {
  const canonWithRow = () => ({
    objects: [{ id: 'o1', name: 'Watch', attachments: [{ characterId: 'c1', emotion: 'grief', origin: 'gift from her father in 1990' }] }],
    characters: [{ id: 'c1', name: 'Mara', background: 'orphaned at birth, never knew her parents' }],
  });

  it('gates on whether any attachment has both an origin and a character with a background', () => {
    const check = getCheck('objects.backstory-consistency');
    expect(check.gate({ canon: canonWithRow() })).toBe(true);
    // origin present but no background → nothing to contradict
    expect(check.gate({ canon: {
      objects: [{ id: 'o1', name: 'Watch', attachments: [{ characterId: 'c1', origin: 'x' }] }],
      characters: [{ id: 'c1', name: 'Mara' }],
    } })).toBe(false);
    // origin missing → skip
    expect(check.gate({ canon: {
      objects: [{ id: 'o1', name: 'Watch', attachments: [{ characterId: 'c1' }] }],
      characters: [{ id: 'c1', name: 'Mara', background: 'x' }],
    } })).toBe(false);
    // dangling characterId → not this check's job
    expect(check.gate({ canon: {
      objects: [{ id: 'o1', name: 'Watch', attachments: [{ characterId: 'ghost', origin: 'x' }] }],
      characters: [{ id: 'c1', name: 'Mara', background: 'x' }],
    } })).toBe(false);
  });

  it('feeds origin + background rows to the model and shapes findings', async () => {
    let vars = null;
    const findings = await getCheck('objects.backstory-consistency').run({
      canon: canonWithRow(),
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      callStagedLLM: async (_stage, v) => {
        vars = v;
        return { content: { findings: [{ severity: 'high', problem: 'orphan cannot receive a gift from her father', suggestion: 'fix', location: 'Object "Watch" — Mara\'s attachment' }] } };
      },
    });
    expect(vars.attachments).toContain('Watch');
    expect(vars.attachments).toContain('Mara');
    expect(vars.attachments).toContain('orphaned at birth'); // the background side
    expect(vars.attachments).toContain('gift from her father'); // the origin side
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('continuity');
    expect(findings[0].issueNumber).toBeNull();
  });

  it('returns no findings (and never calls the model) when no row qualifies', async () => {
    let called = false;
    const findings = await getCheck('objects.backstory-consistency').run({
      canon: { objects: [{ id: 'o1', name: 'Watch' }], characters: [] },
      config: {},
      severityDefault: 'medium',
      callStagedLLM: async () => { called = true; return { content: { findings: [] } }; },
    });
    expect(findings).toEqual([]);
    expect(called).toBe(false);
  });
});
