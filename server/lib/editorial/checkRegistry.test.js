import { NAMING, INFODUMP } from './checkRegistry.test.fixture.js';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { FINDING_CATEGORY_LABELS } from './findingCategories.js';
import { hasManuscript } from './checkInfra/gates.js';
import {
  EDITORIAL_CHECKS,
  EDITORIAL_SOURCES,
  CHECK_SCOPES,
  CHECK_KINDS,
  normalizeCheckScopes,
  primaryCheckScope,
  getCheck,
  listChecks,
  assertValidChecks,
  resolveCheckConfig,
  resolveCheckState,
  resolveCheckSeverity,
  getEnabledChecks,
  applySeriesCheckConfig,
  orderChecksByDependencies,
  buildCustomCheck,
  buildCustomCheckPrompt,
  isValidCustomCheckDef,
  isCustomCheckId,
  getCheckById,
  getAllChecks,
  CUSTOM_CHECK_ID_PREFIX,
  CUSTOM_CHECK_MAX_FINDINGS_DEFAULT,
} from './checkRegistry.js';

// A minimal valid stored custom-check definition.
const customDef = (over = {}) => ({
  id: `${CUSTOM_CHECK_ID_PREFIX}abc`,
  label: 'Anachronisms',
  prompt: 'Flag modern technology in a period setting.',
  scope: 'issue',
  category: 'continuity',
  severityDefault: 'medium',
  ...over,
});

const settingsWith = (defs) => ({ pipelineEditorialChecks: { customChecks: defs } });

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
      // Every check declares a non-empty source set drawn from EDITORIAL_SOURCES,
      // and a manuscript source pairs with needsManuscript (#1387).
      expect(Array.isArray(check.sources) && check.sources.length, `${check.id} sources`).toBeTruthy();
      for (const source of check.sources) {
        expect(EDITORIAL_SOURCES, `${check.id} source "${source}"`).toContain(source);
      }
      if (check.sources.includes('manuscript')) {
        expect(check.needsManuscript, `${check.id} manuscript source ⇒ needsManuscript`).toBe(true);
      }
    }
  });

  it('gives every built-in finding category a manuscript display label', () => {
    for (const check of EDITORIAL_CHECKS) {
      expect(
        Object.hasOwn(FINDING_CATEGORY_LABELS, check.category),
        `${check.id} category "${check.category}"`,
      ).toBe(true);
    }
  });

  // The one place the shared 'needs drafted prose' gate (checkInfra/gates.js) is
  // pinned; also catches a manuscript-consuming check added without any gate.
  it('every needsManuscript check is gated off without prose, and the shared gate is a strict boolean', () => {
    for (const check of EDITORIAL_CHECKS.filter((c) => c.needsManuscript)) {
      expect(typeof check.gate, `${check.id} gate`).toBe('function');
      for (const manuscript of ['', '   ', undefined]) {
        expect(check.gate({ manuscript }), `${check.id} blank ${JSON.stringify(manuscript)}`).toBeFalsy();
      }
      if (check.gate === hasManuscript) {
        expect(check.gate({ manuscript: '' })).toBe(false);
        expect(check.gate({ manuscript: '   ' })).toBe(false);
        expect(check.gate({})).toBe(false);
        expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBe(true);
      }
    }
    expect(EDITORIAL_CHECKS.some((c) => c.gate === hasManuscript)).toBe(true);
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

  it('fact-accuracy check is opt-in and gated on factCritical + a reference + manuscript (#1588)', () => {
    const check = getCheck('research.fact-accuracy');
    expect(check).toBeTruthy();
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    // Registry-enabled like the other content-gated checks (comic/visual) — the
    // GATE is the opt-in, not the enabled flag. A disabled check would be filtered
    // out before the per-series gate ran, so the series fact-critical flag alone
    // would never trigger it.
    expect(check.defaultEnabled).toBe(true);
    expect(check.sources).toContain('series.factReference');

    const manuscript = 'Some prose.';
    // All three preconditions present → gate opens.
    expect(check.gate({ manuscript, series: { factCritical: true, factReference: 'Paris is in France.' } })).toBe(true);
    // Missing any one → gate stays closed.
    expect(check.gate({ manuscript, series: { factCritical: false, factReference: 'Paris is in France.' } })).toBe(false);
    expect(check.gate({ manuscript, series: { factCritical: true, factReference: '   ' } })).toBe(false);
    expect(check.gate({ manuscript: '', series: { factCritical: true, factReference: 'Paris is in France.' } })).toBe(false);
    expect(check.gate({ manuscript, series: null })).toBe(false);
  });
});

describe('editorial check registry — fail-fast guards', () => {
  const valid = {
    id: 'x.ok', label: 'ok', scope: 'series', kind: 'deterministic',
    category: 'naming', severityDefault: 'low', sources: ['canon'],
    configSchema: z.object({}), run: () => [],
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

  it('accepts an array scope of valid members (#1628)', () => {
    expect(() => assertValidChecks([{ ...valid, scope: ['series', 'issue'] }])).not.toThrow();
  });

  it('throws on an empty array scope (#1628)', () => {
    expect(() => assertValidChecks([{ ...valid, scope: [] }])).toThrow(/invalid scope/);
  });

  it('throws when an array scope has an unknown member (#1628)', () => {
    expect(() => assertValidChecks([{ ...valid, scope: ['series', 'galaxy'] }])).toThrow(/invalid scope/);
  });

  it('throws on duplicate scopes in an array (#1628)', () => {
    expect(() => assertValidChecks([{ ...valid, scope: ['series', 'series'] }])).toThrow(/duplicate scopes/);
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

  it('throws on a missing or empty sources array (#1387)', () => {
    expect(() => assertValidChecks([{ ...valid, sources: undefined }])).toThrow(/non-empty sources array/);
    expect(() => assertValidChecks([{ ...valid, sources: [] }])).toThrow(/non-empty sources array/);
  });

  it('throws on an unknown source token (#1387)', () => {
    expect(() => assertValidChecks([{ ...valid, sources: ['series.readerMap'] }])).toThrow(/unknown source/);
  });

  it('throws when a manuscript source is not paired with needsManuscript (#1387)', () => {
    expect(() => assertValidChecks([{ ...valid, sources: ['manuscript'] }])).toThrow(/not marked needsManuscript/);
    // Pairing them is accepted.
    expect(() => assertValidChecks([{ ...valid, sources: ['manuscript'], needsManuscript: true }])).not.toThrow();
  });
});

describe('editorial check registry — scope normalization (#1628)', () => {
  it('normalizeCheckScopes wraps a string in a single-element array', () => {
    expect(normalizeCheckScopes('series')).toEqual(['series']);
  });

  it('normalizeCheckScopes returns array scopes in canonical CHECK_SCOPES order', () => {
    // Declared issue-before-series, but canonical order is series→issue.
    expect(normalizeCheckScopes(['issue', 'series'])).toEqual(['series', 'issue']);
  });

  it('normalizeCheckScopes drops unknown members and empty/absent input returns []', () => {
    expect(normalizeCheckScopes(['series', 'galaxy'])).toEqual(['series']);
    expect(normalizeCheckScopes('galaxy')).toEqual([]);
    expect(normalizeCheckScopes([])).toEqual([]);
    expect(normalizeCheckScopes(null)).toEqual([]);
    expect(normalizeCheckScopes(undefined)).toEqual([]);
  });

  it('primaryCheckScope returns the first canonical scope (or null)', () => {
    expect(primaryCheckScope('issue')).toBe('issue');
    expect(primaryCheckScope(['issue', 'series'])).toBe('series');
    expect(primaryCheckScope([])).toBe(null);
    expect(primaryCheckScope('galaxy')).toBe(null);
  });

  it('every built-in check normalizes to a non-empty scope set', () => {
    for (const check of EDITORIAL_CHECKS) {
      expect(normalizeCheckScopes(check.scope).length).toBeGreaterThan(0);
    }
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

  it('resolveCheckState exposes a primary scope string + a scopes array (#1628)', () => {
    const rows = resolveCheckState({});
    for (const row of rows) {
      expect(typeof row.scope).toBe('string');
      expect(Array.isArray(row.scopes)).toBe(true);
      expect(row.scopes.length).toBeGreaterThan(0);
      // The primary scope is the first entry of the normalized set.
      expect(row.scope).toBe(row.scopes[0]);
    }
  });

  it('resolveCheckState surfaces each check\'s serializable configFields', () => {
    const rows = resolveCheckState({});
    const naming = rows.find((r) => r.id === NAMING);
    expect(Array.isArray(naming.configFields)).toBe(true);
    const field = naming.configFields.find((f) => f.key === 'minSharedSignals');
    expect(field).toMatchObject({ type: 'number', min: 1, max: 7 });
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

describe('applySeriesCheckConfig — per-series config overrides (#1591)', () => {
  const LETTERING = 'comic.lettering-density';
  const enabledFor = (id) => getEnabledChecks({}, [id]);

  it('returns the input unchanged when there are no overrides', () => {
    const enabled = enabledFor(NAMING);
    expect(applySeriesCheckConfig(enabled, null)).toBe(enabled);
    expect(applySeriesCheckConfig(enabled, undefined)).toBe(enabled);
    expect(applySeriesCheckConfig(enabled, [])).toBe(enabled); // non-plain-object → ignored
    expect(applySeriesCheckConfig(enabled, {})).toBe(enabled); // empty map, no matching id
  });

  it('overlays a per-series threshold over the global config (override key wins)', () => {
    const enabled = enabledFor(LETTERING);
    const globalBalloon = enabled[0].config.maxWordsPerBalloon;
    const out = applySeriesCheckConfig(enabled, { [LETTERING]: { maxWordsPerBalloon: 12 } });
    expect(out[0].config.maxWordsPerBalloon).toBe(12);
    // Untouched keys still resolve from the global config (merge, not replace).
    expect(out[0].config.maxWordsPerPanel).toBe(enabled[0].config.maxWordsPerPanel);
    // The input pair is not mutated.
    expect(enabled[0].config.maxWordsPerBalloon).toBe(globalBalloon);
  });

  it('keeps the global config when a per-series override is out of range (no reset to defaults)', () => {
    const enabled = enabledFor(LETTERING).map((p) => ({
      ...p,
      // Pretend the global config itself was tuned, to prove an invalid override
      // falls back to THAT (not the schema defaults).
      config: { ...p.config, maxWordsPerBalloon: 40 },
    }));
    const out = applySeriesCheckConfig(enabled, { [LETTERING]: { maxWordsPerBalloon: 99999 } });
    expect(out[0].config.maxWordsPerBalloon).toBe(40);
  });

  it('ignores an override keyed to a different check / non-object override', () => {
    const enabled = enabledFor(LETTERING);
    const base = enabled[0].config.maxWordsPerBalloon;
    expect(applySeriesCheckConfig(enabled, { [NAMING]: { minSharedSignals: 5 } })[0].config.maxWordsPerBalloon).toBe(base);
    expect(applySeriesCheckConfig(enabled, { [LETTERING]: 'nope' })[0].config.maxWordsPerBalloon).toBe(base);
    expect(applySeriesCheckConfig(enabled, { [LETTERING]: [1, 2] })[0].config.maxWordsPerBalloon).toBe(base);
  });
});

describe('per-check severity override (#1596)', () => {
  const LETTERING = 'comic.lettering-density';
  const checksSettings = (id, severity) => ({ pipelineEditorialChecks: { checks: { [id]: { severity } } } });
  // The opposite of a check's default so an override is observably different.
  const flip = (id) => (getCheck(id).severityDefault === 'high' ? 'low' : 'high');

  it('falls through to the registry default when no override is stored', () => {
    const row = resolveCheckState({}).find((r) => r.id === NAMING);
    expect(row.severity).toBe(getCheck(NAMING).severityDefault);
    expect(row.severityOverride).toBeNull();
  });

  it('applies a valid stored override as the effective severity (baseline preserved)', () => {
    const target = flip(NAMING);
    const row = resolveCheckState(checksSettings(NAMING, target)).find((r) => r.id === NAMING);
    expect(row.severity).toBe(target);
    expect(row.severityOverride).toBe(target);
    expect(row.severityDefault).toBe(getCheck(NAMING).severityDefault);
  });

  it('ignores an invalid stored override (falls back to the default, no phantom override)', () => {
    const row = resolveCheckState(checksSettings(NAMING, 'critical')).find((r) => r.id === NAMING);
    expect(row.severity).toBe(getCheck(NAMING).severityDefault);
    expect(row.severityOverride).toBeNull();
  });

  it('resolveCheckSeverity is the shared fallback helper', () => {
    const check = getCheck(NAMING);
    expect(resolveCheckSeverity(check, { severity: 'medium' })).toBe('medium');
    expect(resolveCheckSeverity(check, { severity: 'nope' })).toBe(check.severityDefault);
    expect(resolveCheckSeverity(check, {})).toBe(check.severityDefault);
    expect(resolveCheckSeverity(check, undefined)).toBe(check.severityDefault);
  });

  it('getEnabledChecks threads the effective severity AND the raw override for the runner', () => {
    const target = flip(NAMING);
    const pinned = getEnabledChecks(checksSettings(NAMING, target), [NAMING])[0];
    expect(pinned.severity).toBe(target); // effective level (used by the catalog UI)
    expect(pinned.severityOverride).toBe(target); // raw → authoritative force-stamp in the runner
    const unpinned = getEnabledChecks({}, [NAMING])[0];
    expect(unpinned.severity).toBe(getCheck(NAMING).severityDefault);
    expect(unpinned.severityOverride).toBeNull(); // no override → no force-stamp
  });

  it('applySeriesCheckConfig preserves the severity fields through a config overlay', () => {
    const target = flip(LETTERING);
    const enabled = getEnabledChecks(checksSettings(LETTERING, target), [LETTERING]);
    const out = applySeriesCheckConfig(enabled, { [LETTERING]: { maxWordsPerBalloon: 12 } });
    expect(out[0].severity).toBe(target); // effective severity rides through untouched
    expect(out[0].severityOverride).toBe(target); // raw override preserved for force-stamp
    expect(out[0].config.maxWordsPerBalloon).toBe(12); // config still overlaid
  });
});

// ---------------------------------------------------------------------------
// User-defined checks (#1346)
// ---------------------------------------------------------------------------

describe('custom checks (#1346)', () => {
  describe('isValidCustomCheckDef', () => {
    it('accepts a well-formed definition', () => {
      expect(isValidCustomCheckDef(customDef())).toBe(true);
    });
    it('rejects missing/blank required fields and bad enums', () => {
      expect(isValidCustomCheckDef(null)).toBe(false);
      expect(isValidCustomCheckDef(customDef({ id: 'naming.x' }))).toBe(false); // not a custom id
      expect(isValidCustomCheckDef(customDef({ label: '   ' }))).toBe(false);
      expect(isValidCustomCheckDef(customDef({ prompt: '' }))).toBe(false);
      expect(isValidCustomCheckDef(customDef({ scope: 'bogus' }))).toBe(false);
      expect(isValidCustomCheckDef(customDef({ severityDefault: 'urgent' }))).toBe(false);
    });
  });

  describe('isCustomCheckId', () => {
    it('matches the custom prefix only', () => {
      expect(isCustomCheckId('custom.abc')).toBe(true);
      expect(isCustomCheckId('prose.info-dumping')).toBe(false);
      expect(isCustomCheckId(null)).toBe(false);
    });
  });

  describe('buildCustomCheck', () => {
    it('synthesizes a runnable LLM check matching the built-in shape', () => {
      const check = buildCustomCheck(customDef());
      expect(check).toBeTruthy();
      expect(check.kind).toBe('llm');
      expect(check.isCustom).toBe(true);
      expect(check.needsManuscript).toBe(true);
      expect(check.defaultEnabled).toBe(true);
      expect(check.scope).toBe('issue');
      expect(check.category).toBe('continuity');
      expect(typeof check.run).toBe('function');
      expect(typeof check.gate).toBe('function');
      // Passes the registry's own structural guards.
      expect(() => assertValidChecks([check])).not.toThrow();
    });
    it('defaults category to "custom" and returns null for a bad def', () => {
      expect(buildCustomCheck(customDef({ category: '  ' })).category).toBe('custom');
      expect(buildCustomCheck(customDef({ id: 'x' }))).toBeNull();
    });
    it('gate skips when there is no manuscript', () => {
      const check = buildCustomCheck(customDef());
      expect(check.gate({ manuscript: '' })).toBe(false);
      expect(check.gate({ manuscript: 'Chapter 1...' })).toBe(true);
    });
  });

  describe('buildCustomCheckPrompt', () => {
    it('wraps instructions + manuscript in the findings JSON contract', () => {
      const prompt = buildCustomCheckPrompt({ instructions: 'Find anachronisms', manuscript: 'A knight checks his phone.', maxFindings: 7 });
      expect(prompt).toContain('Find anachronisms');
      expect(prompt).toContain('A knight checks his phone.');
      expect(prompt).toContain('"findings"');
      expect(prompt).toContain('at most 7 findings');
      expect(prompt).toContain('{"findings": []}');
    });
    it('falls back to the default cap on a bad maxFindings', () => {
      const prompt = buildCustomCheckPrompt({ instructions: 'x', manuscript: 'y', maxFindings: 0 });
      expect(prompt).toContain(`at most ${CUSTOM_CHECK_MAX_FINDINGS_DEFAULT} findings`);
    });
  });

  describe('integration with the resolver/runner helpers', () => {
    it('getAllChecks / getCheckById include valid custom checks and skip invalid ones', () => {
      const settings = settingsWith([customDef(), customDef({ id: 'custom.bad', scope: 'nope' })]);
      const ids = getAllChecks(settings).map((c) => c.id);
      expect(ids).toContain('custom.abc');
      expect(ids).not.toContain('custom.bad');
      expect(getCheckById(settings, 'custom.abc')?.label).toBe('Anachronisms');
      expect(getCheckById(settings, 'custom.bad')).toBeNull();
      expect(getCheckById(settings, NAMING)?.id).toBe(NAMING); // built-ins still resolve
    });

    it('resolveCheckState surfaces a custom check with isCustom + prompt + default-enabled', () => {
      const row = resolveCheckState(settingsWith([customDef()])).find((r) => r.id === 'custom.abc');
      expect(row).toBeTruthy();
      expect(row.isCustom).toBe(true);
      expect(row.prompt).toContain('modern technology');
      expect(row.enabled).toBe(true);
      expect(row.config.maxFindings).toBe(CUSTOM_CHECK_MAX_FINDINGS_DEFAULT);
    });

    it('the shared checks[id] override toggles a custom check off', () => {
      const settings = {
        pipelineEditorialChecks: {
          customChecks: [customDef()],
          checks: { 'custom.abc': { enabled: false } },
        },
      };
      const row = resolveCheckState(settings).find((r) => r.id === 'custom.abc');
      expect(row.enabled).toBe(false);
      expect(getEnabledChecks(settings).some((x) => x.check.id === 'custom.abc')).toBe(false);
    });

    it('getEnabledChecks resolves the synthesized custom check for execution', () => {
      const enabled = getEnabledChecks(settingsWith([customDef()]));
      const entry = enabled.find((x) => x.check.id === 'custom.abc');
      expect(entry).toBeTruthy();
      expect(entry.check.kind).toBe('llm');
      expect(entry.config.maxFindings).toBe(CUSTOM_CHECK_MAX_FINDINGS_DEFAULT);
    });

    it('a custom check run calls callInlineLLM per chunk and maps findings', async () => {
      const check = buildCustomCheck(customDef());
      let sentPrompt;
      const findings = await check.run({
        config: { maxFindings: 5 },
        severityDefault: 'medium',
        manuscript: 'Chapter 1. A knight checks his phone.',
        planManuscriptChunks: async () => ['Chapter 1. A knight checks his phone.'],
        callInlineLLM: async (prompt) => {
          sentPrompt = prompt;
          return { content: { findings: [{ severity: 'high', issueNumber: 1, problem: 'anachronistic phone', anchorQuote: 'his phone' }] } };
        },
      });
      expect(sentPrompt).toContain('modern technology');
      expect(sentPrompt).toContain('A knight checks his phone.');
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('continuity');
      expect(findings[0].severity).toBe('high');
      expect(findings[0].issueNumber).toBe(1);
    });
  });
});

describe('cast.representation-balance — deterministic check (#1312)', () => {
  const REP = 'cast.representation-balance';
  const sec = (number, content) => ({ number, content });
  const runRep = (canon, { sections = [], reverseOutline = [], config = {} } = {}) =>
    getCheck(REP).run({
      canon,
      sections,
      // The runner injects the stitched corpus as ctx.manuscript; mirror it here.
      manuscript: sections.map((s) => s.content || '').join('\n\n'),
      reverseOutline,
      config,
      severityDefault: 'low',
    });
  const dialogue = (findings) => findings.find((f) => /speaking characters\)/.test(f.problem));
  const minorDom = (findings) => findings.find((f) => /reads as a minor character/.test(f.problem));
  const silentMajor = (findings) => findings.find((f) => /reads as a major character/.test(f.problem));
  const bechdel = (findings) => findings.find((f) => /Bechdel/.test(f.problem));
  const screenTime = (findings) => findings.find((f) => /strongly skewed cast/.test(f.problem));
  // Config that silences every OTHER signal so a test can isolate one.
  const only = (over) => ({
    maxDialogueShare: 1, maxMinorShare: 1, minMajorShare: 0, maxGenderShare: 1, bechdelSignal: false, ...over,
  });

  it('declares the expected scope / kind / sources', () => {
    const c = getCheck(REP);
    expect(c.kind).toBe('deterministic');
    expect(c.scope).toBe('series');
    expect(c.category).toBe('casting');
    expect(c.needsManuscript).toBe(true);
    expect(c.sources).toEqual(expect.arrayContaining(['manuscript', 'canon', 'reverseOutline']));
  });

  it('flags a dominating speaker by dialogue share', () => {
    const canon = { characters: [{ name: 'Aria', pronouns: 'she/her' }, { name: 'Bram', pronouns: 'he/him' }] };
    // 4 Aria lines, 1 Bram line → Aria = 80% of 5 attributed lines.
    const content = [
      '"One," said Aria.',
      '"Two," said Aria.',
      '"Three," said Aria.',
      '"Four," said Aria.',
      '"Five," said Bram.',
    ].join('\n');
    const findings = runRep(canon, {
      sections: [sec(1, content)],
      config: only({ maxDialogueShare: 0.6, minDialogueLines: 5 }),
    });
    const f = dialogue(findings);
    expect(f).toBeTruthy();
    expect(f.category).toBe('casting');
    expect(f.severity).toBe('medium'); // 80% → escalated above the low floor
    expect(f.problem).toMatch(/"Aria" speaks about 80%/);
  });

  it('skips the dialogue-share check below the minimum line floor', () => {
    const canon = { characters: [{ name: 'Aria' }, { name: 'Bram' }] };
    const content = '"Hi," said Aria.\n"Hey," said Bram.';
    const findings = runRep(canon, {
      sections: [sec(1, content)],
      config: only({ maxDialogueShare: 0.4, minDialogueLines: 12 }),
    });
    expect(dialogue(findings)).toBeUndefined();
  });

  it('flags a minor-role character who dominates the dialogue (#1594)', () => {
    const canon = {
      characters: [
        { name: 'Aria', role: 'protagonist' },
        { name: 'Bram', role: 'minor background character' },
      ],
    };
    // Bram (a minor) speaks 4 of 5 lines → 80% → minor dominating.
    const content = [
      '"One," said Bram.',
      '"Two," said Bram.',
      '"Three," said Bram.',
      '"Four," said Bram.',
      '"Five," said Aria.',
    ].join('\n');
    const findings = runRep(canon, {
      sections: [sec(1, content)],
      config: only({ maxMinorShare: 0.35, minDialogueLines: 5 }),
    });
    const f = minorDom(findings);
    expect(f).toBeTruthy();
    expect(f.category).toBe('casting');
    expect(f.severity).toBe('medium'); // 80% ≥ 50% → escalated above the low floor
    expect(f.problem).toMatch(/"Bram" reads as a minor character/);
    expect(f.problem).toMatch(/80%/);
    // Aria (protagonist) speaks 20% > the silent-major floor → not silent.
    expect(silentMajor(findings)).toBeUndefined();
  });

  it('fires the role-relative signal even when one speaker holds all the dialogue (#1594)', () => {
    // The top-speaker share signal needs 2+ speakers, but a lone minor speaking
    // every line is the STRONGEST minor-dominating case — it must not be gated out.
    const canon = {
      characters: [
        { name: 'Bram', role: 'cameo' },
        { name: 'Aria', role: 'protagonist' },
      ],
    };
    const content = [
      '"One," said Bram.',
      '"Two," said Bram.',
      '"Three," said Bram.',
      '"Four," said Bram.',
      '"Five," said Bram.',
    ].join('\n');
    const findings = runRep(canon, {
      sections: [sec(1, content)],
      config: only({ maxMinorShare: 0.35, minDialogueLines: 5 }),
    });
    const f = minorDom(findings);
    expect(f).toBeTruthy();
    expect(f.problem).toMatch(/100%/);
    expect(f.severity).toBe('medium'); // 100% ≥ 50% → escalated
  });

  it('flags a major-role character who appears yet is oddly silent (#1594)', () => {
    const canon = {
      characters: [
        { name: 'Aria', role: 'lead' },
        { name: 'Bram' },
        { name: 'Cara' },
      ],
    };
    // Aria appears in the prose but never speaks; Bram + Cara carry all dialogue.
    const content = [
      'Aria watched from the doorway, saying nothing.',
      '"One," said Bram.',
      '"Two," said Bram.',
      '"Three," said Bram.',
      '"Four," said Bram.',
      '"Five," said Cara.',
    ].join('\n');
    const findings = runRep(canon, {
      sections: [sec(1, content)],
      config: only({ minMajorShare: 0.05, minDialogueLines: 5 }),
    });
    const f = silentMajor(findings);
    expect(f).toBeTruthy();
    expect(f.category).toBe('casting');
    expect(f.severity).toBe('medium'); // 0 lines → escalated above the low floor
    expect(f.problem).toMatch(/"Aria" reads as a major character/);
  });

  it('stays silent on the silent-major signal when the major never appears in the prose (#1594)', () => {
    const canon = {
      characters: [
        { name: 'Aria', role: 'lead' }, // never named in the prose below
        { name: 'Bram' },
        { name: 'Cara' },
      ],
    };
    const content = [
      '"One," said Bram.',
      '"Two," said Bram.',
      '"Three," said Bram.',
      '"Four," said Bram.',
      '"Five," said Cara.',
    ].join('\n');
    const findings = runRep(canon, {
      sections: [sec(1, content)],
      config: only({ minMajorShare: 0.05, minDialogueLines: 5 }),
    });
    expect(silentMajor(findings)).toBeUndefined();
  });

  it('leaves unknown / ambiguous-role characters out of the distribution signals (#1594)', () => {
    const canon = {
      characters: [
        // "minor antagonist" mixes a major AND a minor word → unknown tier → opt out.
        { name: 'Bram', role: 'minor antagonist' },
        { name: 'Aria', role: 'protagonist' },
        { name: 'Cara' }, // no role → unknown
      ],
    };
    // Bram dominates, but his contradictory role means the minor signal opts out.
    const content = [
      '"One," said Bram.',
      '"Two," said Bram.',
      '"Three," said Bram.',
      '"Four," said Bram.',
      '"Five," said Cara.',
    ].join('\n');
    const findings = runRep(canon, {
      sections: [sec(1, content)],
      config: only({ maxMinorShare: 0.35, minMajorShare: 0.05, minDialogueLines: 5 }),
    });
    expect(minorDom(findings)).toBeUndefined();
    // Aria (protagonist) doesn't appear in the prose, so the silent-major signal
    // also stays quiet rather than firing on canon-only presence.
    expect(silentMajor(findings)).toBeUndefined();
  });

  it('flags a missing Bechdel co-presence signal when no scene pairs non-male characters', () => {
    const canon = {
      characters: [
        { name: 'Aria', pronouns: 'she/her' },
        { name: 'Mara', pronouns: 'she/her' },
        { name: 'Bram', pronouns: 'he/him' },
      ],
    };
    // Aria only ever shares the page with Bram; Aria + Mara never co-present.
    const reverseOutline = [
      { heading: 'S1', charactersPresent: ['Aria', 'Bram'] },
      { heading: 'S2', charactersPresent: ['Mara', 'Bram'] },
    ];
    const findings = runRep(canon, { reverseOutline, config: only({ bechdelSignal: true }) });
    expect(bechdel(findings)).toBeTruthy();
  });

  it('passes the Bechdel signal when two non-male characters share a scene', () => {
    const canon = {
      characters: [
        { name: 'Aria', pronouns: 'she/her' },
        { name: 'Mara', pronouns: 'they/them' },
      ],
    };
    const reverseOutline = [{ heading: 'S1', charactersPresent: ['Aria', 'Mara'] }];
    const findings = runRep(canon, { reverseOutline, config: only({ bechdelSignal: true }) });
    expect(bechdel(findings)).toBeUndefined();
  });

  it('stays silent on Bechdel when no scene presence is recorded', () => {
    const canon = { characters: [{ name: 'Aria', pronouns: 'she/her' }, { name: 'Mara', pronouns: 'she/her' }] };
    const findings = runRep(canon, { reverseOutline: [], config: only({ bechdelSignal: true }) });
    expect(bechdel(findings)).toBeUndefined();
  });

  it('flags a strongly gender-skewed appearing cast', () => {
    const canon = {
      characters: [
        { name: 'Al', pronouns: 'he/him' },
        { name: 'Bo', pronouns: 'he/him' },
        { name: 'Cy', pronouns: 'he/him' },
        { name: 'Di', pronouns: 'he/him' },
        { name: 'Eve', pronouns: 'she/her' },
      ],
    };
    // All five appear; 4/5 = 80% male → over an 80%? No, must EXCEED. Use 0.7.
    const content = 'Al, Bo, Cy, Di, and Eve all gathered at dawn.';
    const findings = runRep(canon, {
      sections: [sec(1, content)],
      config: only({ maxGenderShare: 0.7 }),
    });
    const f = screenTime(findings);
    expect(f).toBeTruthy();
    expect(f.problem).toMatch(/80% are male/);
  });

  it('leaves unknown/ambiguous-pronoun characters out of the gender signals', () => {
    const canon = {
      characters: [
        { name: 'Al', pronouns: 'he/him' },
        { name: 'Bo' }, // no pronouns → unknown
        { name: 'Cy', pronouns: 'she/he' }, // ambiguous → unknown
      ],
    };
    const content = 'Al, Bo, and Cy gathered.';
    // Only Al is gender-known → known < 2 → no screen-time finding.
    const findings = runRep(canon, { sections: [sec(1, content)], config: only({ maxGenderShare: 0.5 }) });
    expect(screenTime(findings)).toBeUndefined();
  });

  it('treats a primary+secondary set (she/they) as the primary gender, not ambiguous', () => {
    // inferGender resolves "she/they" to female (a definite identity with a
    // secondary set), unlike "she/he" which is genuinely ambiguous → unknown.
    // Pin that contract via the screen-time signal: two she/they characters
    // count as 2 known-female, so an all-female roster trips the skew.
    const canon = {
      characters: [
        { name: 'Aria', pronouns: 'she/they' },
        { name: 'Mara', pronouns: 'she/her' },
      ],
    };
    const findings = runRep(canon, {
      sections: [sec(1, 'Aria and Mara spoke at dawn.')],
      config: only({ maxGenderShare: 0.7 }),
    });
    const f = screenTime(findings);
    expect(f).toBeTruthy();
    expect(f.problem).toMatch(/100% are female/);
  });

  it('gate requires at least one named canon character', () => {
    const c = getCheck(REP);
    expect(c.gate({ canon: { characters: [] } })).toBeFalsy();
    expect(c.gate({ canon: { characters: [{ name: 'Aria' }] } })).toBe(true);
  });

  it('tolerates empty canon / sections / outline without throwing', () => {
    expect(() => runRep({ characters: [] })).not.toThrow();
    expect(runRep({ characters: [{}, { name: '' }] }, { sections: [sec(1, 'x')] })).toEqual([]);
  });
});

// Inter-check context sharing — dependency ordering (#1627).
describe('orderChecksByDependencies (#1627)', () => {
  // A pair is just `{ check: { id, dependsOn? } }` here — ordering reads only those.
  const pair = (id, dependsOn) => ({ check: dependsOn ? { id, dependsOn } : { id } });
  const ids = (pairs) => pairs.map((p) => p.check.id);

  it('keeps registry order when no check declares a dependency (stable, identity)', () => {
    const input = [pair('a'), pair('b'), pair('c')];
    expect(ids(orderChecksByDependencies(input))).toEqual(['a', 'b', 'c']);
  });

  it('emits a declared dependency BEFORE the dependent even when registry order is reversed', () => {
    // b depends on a, but is listed first — a must be pulled ahead of b.
    const out = orderChecksByDependencies([pair('b', ['a']), pair('a'), pair('c')]);
    expect(ids(out).indexOf('a')).toBeLessThan(ids(out).indexOf('b'));
    // c (independent) stays in its relative slot — only b waited on something.
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });

  it('orders a transitive chain c→b→a so every dependency precedes its dependent', () => {
    const out = ids(orderChecksByDependencies([pair('c', ['b']), pair('b', ['a']), pair('a')]));
    expect(out.indexOf('a')).toBeLessThan(out.indexOf('b'));
    expect(out.indexOf('b')).toBeLessThan(out.indexOf('c'));
  });

  it('ignores a dependency that is absent from the run (disabled / subset) and still runs the dependent', () => {
    // b depends on z, which isn't in the enabled set — b still runs, order preserved.
    const out = orderChecksByDependencies([pair('a'), pair('b', ['z'])]);
    expect(ids(out)).toEqual(['a', 'b']);
  });

  it('breaks a dependency cycle by falling back to registry order without throwing or spinning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = orderChecksByDependencies([pair('a', ['b']), pair('b', ['a']), pair('c')]);
    // c (independent) is placed; the cyclic a/b are flushed in registry order.
    expect(ids(out).sort()).toEqual(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns a copy for trivial inputs and never mutates the caller array', () => {
    expect(orderChecksByDependencies([])).toEqual([]);
    const one = [pair('a')];
    const out = orderChecksByDependencies(one);
    expect(out).not.toBe(one);
    expect(ids(out)).toEqual(['a']);
    expect(orderChecksByDependencies(null)).toEqual([]);
  });
});

// dependsOn shape is validated at registry load (#1627).
describe('assertValidChecks — dependsOn shape (#1627)', () => {
  const base = {
    id: 'x.test', label: 'X', scope: 'series', kind: 'deterministic', category: 'c',
    severityDefault: 'low', run: () => [], configSchema: z.object({}), sources: ['canon'],
  };
  it('accepts an absent or string-array dependsOn', () => {
    expect(() => assertValidChecks([base])).not.toThrow();
    expect(() => assertValidChecks([{ ...base, dependsOn: ['naming.dissimilar-names'] }])).not.toThrow();
  });
  it('rejects a non-array or non-string-element dependsOn', () => {
    expect(() => assertValidChecks([{ ...base, dependsOn: 'a' }])).toThrow(/dependsOn must be an array/);
    expect(() => assertValidChecks([{ ...base, dependsOn: [1] }])).toThrow(/dependsOn must be an array/);
    expect(() => assertValidChecks([{ ...base, dependsOn: [''] }])).toThrow(/dependsOn must be an array/);
  });
  it('rejects a self-reference', () => {
    expect(() => assertValidChecks([{ ...base, dependsOn: ['x.test'] }])).toThrow(/cannot depend on itself/);
  });
});
