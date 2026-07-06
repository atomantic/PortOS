import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
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
  editorialPriorFindingsDigest,
  EDITORIAL_PRIOR_DIGEST_MAX,
  EDITORIAL_PRIOR_DIGEST_CHARS,
  editorialSetupDigest,
  buildSetupDigestPrompt,
  EDITORIAL_SETUP_DIGEST_BODY_CHARS,
  EDITORIAL_SETUP_DIGEST_CHARS,
  EDITORIAL_SETUP_DIGEST_SOURCE,
  authoredSetupPayoffSummary,
  authoredPayoffsSummary,
  authoredCliffhangerSummary,
  sceneGroundingSummary,
  characterVoiceProfiles,
  intendedVoiceSummary,
  plotlineCoverageSummary,
  conflictIntensityTally,
  scenePovSummary,
  secondaryCharacterPresenceSummary,
  declaredThemesSummary,
  canonRosterNamesSummary,
  canonCharacterStatesSummary,
  canonCharacterTraitsSummary,
  continuityLedgerSummary,
  proseStageIssues,
  renderComicForProseSync,
  proseSyncPairs,
  PROSE_SYNC_PROSE_CHAR_CAP,
  ON_THE_NOSE_SUBTYPES,
} from './checkRegistry.js';

const NAMING = 'naming.dissimilar-names';
const INFODUMP = 'prose.info-dumping';
const INTERIORITY = 'interiority.protagonist';
const CHEKHOV = 'chekhov.setups-payoffs';
const ENDINGS_CLIFF = 'endings.cliffhanger';
const POV_SWITCH = 'endings.pov-switch';
const SENSORY_BALANCE = 'sensory.balance';
const WHITE_ROOM = 'scene.white-room';
const INTERIORITY_BALANCE = 'scene.interiority-balance';
const PLOT_STRUCTURE = 'plot.structure-momentum';
const PACING_ESCALATION = 'pacing.escalation-curve';
const HEAD_HOPPING = 'pov.head-hopping';
const THEME_COHERENCE = 'theme.coherence';
const UNMODELED_NAMES = 'roster.unmodeled-names';
const TIMELINE_CONTRADICTION = 'continuity.timeline-contradiction';
const CHARACTER_CONSISTENCY = 'character.consistency';
const CLIMAX_AGENCY = 'arc.climax-agency';
const REACTION_PROPORTIONALITY = 'emotion.reaction-proportionality';
const SECONDARY_ARC = 'character.secondary-arc';

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

describe('prose.info-dumping — LLM check', () => {
  // Default ctx: the runner-injected chunker resolves to a single whole-corpus
  // chunk (the common "provider fits the book" case). Tests that exercise
  // chunking override `planManuscriptChunks`.
  const wholeCtx = (overrides = {}) => ({
    manuscript: 'As you know, Bob, the kingdom fell.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    planManuscriptChunks: async () => [overrides.manuscript ?? 'As you know, Bob, the kingdom fell.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('feeds each planned manuscript chunk to the model and merges findings across them', async () => {
    // A long series the provider can't hold in one call → chunked into two.
    const seen = [];
    const ctx = wholeCtx({
      config: { maxFindings: 12 },
      planManuscriptChunks: async (_stage, opts) => {
        // The check passes a fixed prompt-overhead budget so the chunker leaves
        // room for the template.
        expect(opts.overheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nchunk one', '# Issue 2\n\nchunk two'];
      },
      callStagedLLM: async (_stage, vars) => {
        seen.push(vars.manuscript);
        const n = seen.length;
        return { content: { findings: [{ severity: 'medium', issueNumber: n, problem: `dump ${n}`, anchorQuote: `a${n}` }] } };
      },
    });
    const findings = await getCheck(INFODUMP).run(ctx);
    expect(seen).toEqual(['# Issue 1\n\nchunk one', '# Issue 2\n\nchunk two']);
    // One finding per chunk, merged across both.
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.issueNumber).sort()).toEqual([1, 2]);
    expect(findings.every((f) => f.category === 'exposition')).toBe(true);
  });

  it('dedups a finding surfaced in more than one chunk (first-wins)', async () => {
    const dup = { severity: 'high', issueNumber: 1, problem: 'same dump', anchorQuote: 'As you know' };
    const ctx = wholeCtx({
      planManuscriptChunks: async () => ['chunk a', 'chunk b'],
      callStagedLLM: async () => ({ content: { findings: [dup] } }),
    });
    const findings = await getCheck(INFODUMP).run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toBe('same dump');
  });

  it('passes the whole corpus through in one call when the provider fits it', async () => {
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => {
        expect(vars.manuscript).toBe('As you know, Bob, the kingdom fell.');
        return { content: { findings: [{ severity: 'high', issueNumber: 1, problem: 'dump', anchorQuote: 'As you know', suggestion: 'cut' }] } };
      },
    });
    const findings = await getCheck(INFODUMP).run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('exposition');
    expect(findings[0].issueNumber).toBe(1);
  });

  it('respects maxFindings as a whole-run cap (across chunks)', async () => {
    // Two chunks each return 30 distinct findings; the run cap of 5 bounds the merged total.
    const many = (tag) => Array.from({ length: 30 }, (_, i) => ({ severity: 'low', problem: `${tag}-p${i}`, anchorQuote: `${tag}-a${i}` }));
    let call = 0;
    const ctx = wholeCtx({
      config: { maxFindings: 5 },
      planManuscriptChunks: async () => ['c1', 'c2'],
      callStagedLLM: async () => ({ content: { findings: many(call++ === 0 ? 'x' : 'y') } }),
    });
    const findings = await getCheck(INFODUMP).run(ctx);
    expect(findings).toHaveLength(5);
  });
});

describe('sceneGroundingSummary (#1309)', () => {
  it('renders each scene with its setting and characters present', () => {
    const summary = sceneGroundingSummary([
      { sequence: 0, issueNumber: 1, heading: 'The kitchen', setting: 'a cramped galley kitchen', charactersPresent: ['Mara', 'Joss'] },
      { sequence: 1, issueNumber: 2, heading: 'On the call', setting: '', charactersPresent: ['Mara'] },
    ]);
    expect(summary).toContain('Scenes (from the reverse outline):');
    expect(summary).toContain('Issue 1: The kitchen — setting: a cramped galley kitchen — present: Mara, Joss');
    // A blank setting renders the explicit "(none recorded)" marker (the white-room signal).
    expect(summary).toContain('Issue 2: On the call — setting: (none recorded) — present: Mara');
  });

  it('returns "" for an empty / non-array outline so the prompt section renders nothing', () => {
    expect(sceneGroundingSummary([])).toBe('');
    expect(sceneGroundingSummary(null)).toBe('');
    expect(sceneGroundingSummary(undefined)).toBe('');
  });

  it('tolerates malformed scenes (peer-sync resilience) without throwing', () => {
    const summary = sceneGroundingSummary([
      null,
      { sequence: 2, heading: 42, setting: 99, charactersPresent: 'not-an-array' },
      { sequence: 3, summary: 'falls back to summary label' },
    ]);
    // Non-string heading falls back to the sequence label; bad setting → "(none recorded)".
    expect(summary).toContain('scene 3 — setting: (none recorded)');
    expect(summary).toContain('falls back to summary label');
    expect(() => sceneGroundingSummary([{ charactersPresent: [1, 2, null] }])).not.toThrow();
  });
});

describe('scenePovSummary (#1311)', () => {
  it('renders each POV-tagged scene with its POV holder and the OTHER characters present', () => {
    const summary = scenePovSummary([
      { sequence: 0, issueNumber: 1, heading: 'The kitchen', povCharacter: 'Mara', charactersPresent: ['Mara', 'Joss'] },
      { sequence: 1, issueNumber: 2, heading: 'Alone', povCharacter: 'Joss', charactersPresent: ['Joss'] },
    ]);
    expect(summary).toContain('POV per scene (from the reverse outline):');
    // The POV holder is excluded from "others present" — only candidate other heads remain.
    expect(summary).toContain('Issue 1: The kitchen — POV: Mara — others present: Joss');
    // A scene where only the POV holder is present lists no others.
    expect(summary).toContain('Issue 2: Alone — POV: Joss');
    expect(summary).not.toContain('Issue 2: Alone — POV: Joss — others present');
  });

  it('renders an untagged scene as "infer from the prose" instead of dropping it (partial-outline coverage)', () => {
    const summary = scenePovSummary([{ sequence: 0, issueNumber: 1, heading: 'Untagged', charactersPresent: ['Mara', 'Joss'] }]);
    expect(summary).toContain('Issue 1: Untagged — POV: (not recorded — infer from the prose) — others present: Mara, Joss');
  });

  it('returns "" only when there are no scenes at all', () => {
    expect(scenePovSummary([])).toBe('');
    expect(scenePovSummary(null)).toBe('');
    expect(scenePovSummary(undefined)).toBe('');
  });

  it('tolerates malformed scenes (peer-sync resilience) without throwing', () => {
    expect(() => scenePovSummary([
      null,
      { sequence: 2, povCharacter: 99, charactersPresent: 'not-an-array' },
      { sequence: 3, povCharacter: 'Mara', charactersPresent: [1, 2, null, 'Joss'] },
    ])).not.toThrow();
    const summary = scenePovSummary([{ sequence: 3, povCharacter: 'Mara', charactersPresent: [1, 2, null, 'Joss'] }]);
    // Non-string entries in charactersPresent are filtered out; the real other head survives.
    expect(summary).toContain('POV: Mara — others present: Joss');
  });
});

describe('pov.head-hopping — LLM check (#1311)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nShe watched him. He was secretly relieved, though he hid it.',
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'The room', povCharacter: 'Mara', charactersPresent: ['Mara', 'Joss'] }],
    series: { styleGuide: { povPerson: 'third-limited' } },
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    planManuscriptChunks: async () => [overrides.manuscript ?? '# Issue 1\n\nprose'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a manuscript+reverseOutline+styleGuide LLM check with category style', () => {
    const check = getCheck(HEAD_HOPPING);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('scene');
    expect(check.category).toBe('style');
    expect(check.needsManuscript).toBe(true);
    expect(check.sources).toEqual(expect.arrayContaining(['manuscript', 'reverseOutline', 'series.styleGuide']));
    expect(check.severityDefault).toBe('medium');
  });

  it('gates on a non-empty manuscript', () => {
    const check = getCheck(HEAD_HOPPING);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('no-ops (gate false) when the style guide is third-person omniscient', () => {
    const check = getCheck(HEAD_HOPPING);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose', series: { styleGuide: { povPerson: 'third-omniscient' } } })).toBe(false);
    // Any other (limited) POV person — or none — still runs.
    expect(check.gate({ manuscript: '# Issue 1\n\nprose', series: { styleGuide: { povPerson: 'first' } } })).toBeTruthy();
    expect(check.gate({ manuscript: '# Issue 1\n\nprose', series: {} })).toBeTruthy();
  });

  it('injects the POV map + POV person into the prompt vars and counts them into the chunk overhead', async () => {
    let seenVars = null;
    let seenOverhead = 0;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // The trimmable context blocks ride alongside the manuscript as overhead;
        // the fixed template reserve is passed separately (#1459).
        seenOverhead = opts.fixedOverheadTokens;
        expect(opts.context).toHaveProperty('povMap');
        return ['# Issue 1\n\nchunk'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'high', issueNumber: 1, problem: "entered Joss's head", anchorQuote: 'secretly relieved' }] } };
      },
    });
    const findings = await getCheck(HEAD_HOPPING).run(ctx);
    expect(seenVars.povMap).toContain('Issue 1: The room — POV: Mara — others present: Joss');
    expect(seenVars.povPerson).toBe('third-person limited');
    expect(seenOverhead).toBeGreaterThan(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('style');
    expect(findings[0].issueNumber).toBe(1);
  });

  it('degrades to a whole-issue scan (empty POV map) and a neutral POV label when no outline / style guide exists', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      reverseOutline: undefined,
      series: {},
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [] } };
      },
    });
    await getCheck(HEAD_HOPPING).run(ctx);
    expect(seenVars.povMap).toBe('');
    expect(seenVars.povPerson).toBe('a limited point of view');
  });

  it('respects maxFindings as a whole-run cap', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ severity: 'medium', problem: `p${i}`, anchorQuote: `a${i}` }));
    const ctx = wholeCtx({
      config: { maxFindings: 4 },
      callStagedLLM: async () => ({ content: { findings: many } }),
    });
    const findings = await getCheck(HEAD_HOPPING).run(ctx);
    expect(findings).toHaveLength(4);
  });
});

describe.each([
  { id: SENSORY_BALANCE, severityDefault: 'low', label: 'sensory.balance' },
  { id: WHITE_ROOM, severityDefault: 'medium', label: 'scene.white-room' },
  { id: INTERIORITY_BALANCE, severityDefault: 'medium', label: 'scene.interiority-balance' },
])('$label — scene-grounding LLM check (#1309 / #1623)', ({ id, severityDefault }) => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\n"We have to go," she said.',
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'The void', setting: '', charactersPresent: ['Mara'] }],
    config: { maxFindings: 12 },
    severityDefault,
    planManuscriptChunks: async () => [overrides.manuscript ?? '# Issue 1\n\n"We have to go," she said.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a manuscript+reverseOutline LLM check with category style', () => {
    const check = getCheck(id);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('scene');
    expect(check.category).toBe('style');
    expect(check.needsManuscript).toBe(true);
    expect(check.sources).toEqual(expect.arrayContaining(['manuscript', 'reverseOutline']));
    expect(check.severityDefault).toBe(severityDefault);
  });

  it('gates on a non-empty manuscript', () => {
    const check = getCheck(id);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('injects the scene map into the prompt vars and counts it into the chunk overhead', async () => {
    let seenVars = null;
    let seenOverhead = 0;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // The scene map rides as trimmable context (#1459); the fixed template
        // reserve is passed separately.
        seenOverhead = opts.fixedOverheadTokens;
        expect(opts.context).toHaveProperty('sceneMap');
        return ['# Issue 1\n\nchunk'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: severityDefault, issueNumber: 1, problem: 'flat scene', anchorQuote: 'go' }] } };
      },
    });
    const findings = await getCheck(id).run(ctx);
    // The scene map rode along as a prompt var (and was budgeted as context overhead).
    expect(seenVars.sceneMap).toContain('Issue 1: The void');
    expect(seenOverhead).toBeGreaterThan(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('style');
    expect(findings[0].issueNumber).toBe(1);
  });

  it('degrades to a whole-issue scan (empty scene map) when no reverse outline exists', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [] } };
      },
    });
    await getCheck(id).run(ctx);
    expect(seenVars.sceneMap).toBe('');
  });

  it('respects maxFindings as a whole-run cap', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ severity: 'low', problem: `p${i}`, anchorQuote: `a${i}` }));
    const ctx = wholeCtx({
      config: { maxFindings: 4 },
      callStagedLLM: async () => ({ content: { findings: many } }),
    });
    const findings = await getCheck(id).run(ctx);
    expect(findings).toHaveLength(4);
  });
});

describe('interiority.protagonist — LLM check (#1294)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nShe walked into the room and sat down.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    planManuscriptChunks: async () => [overrides.manuscript ?? '# Issue 1\n\nShe walked into the room and sat down.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a manuscript-scoped LLM check', () => {
    const check = getCheck(INTERIORITY);
    expect(check.kind).toBe('llm');
    expect(check.category).toBe('character');
    expect(check.sources).toEqual(['manuscript']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(INTERIORITY);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the planned manuscript chunk to the model and forces the character category', async () => {
    let seen = null;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // The check reserves prompt-overhead budget so the chunker leaves room for the template.
        expect(opts.overheadTokens).toBeGreaterThan(0);
        return ['# Issue 2\n\nHe nodded and left.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seen = vars.manuscript;
        return { content: { findings: [{ severity: 'high', issueNumber: 2, location: 'Issue 2 — Objective', problem: 'No want', anchorQuote: 'He nodded' }] } };
      },
    });
    const findings = await getCheck(INTERIORITY).run(ctx);
    expect(seen).toBe('# Issue 2\n\nHe nodded and left.');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('character');
    expect(findings[0].issueNumber).toBe(2);
    expect(findings[0].location).toBe('Issue 2 — Objective');
  });

  it('merges findings across chunks and respects maxFindings as a whole-run cap', async () => {
    const many = (tag) => Array.from({ length: 30 }, (_, i) => ({ severity: 'low', problem: `${tag}-p${i}`, anchorQuote: `${tag}-a${i}` }));
    let call = 0;
    const ctx = wholeCtx({
      config: { maxFindings: 4 },
      planManuscriptChunks: async () => ['c1', 'c2'],
      callStagedLLM: async () => ({ content: { findings: many(call++ === 0 ? 'x' : 'y') } }),
    });
    const findings = await getCheck(INTERIORITY).run(ctx);
    expect(findings).toHaveLength(4);
  });
});

describe('chekhov.setups-payoffs — LLM check (#1299)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nHe slid the loaded revolver into the drawer and locked it.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    series: {},
    planManuscriptChunks: async () => [overrides.manuscript ?? '# Issue 1\n\nHe slid the loaded revolver into the drawer and locked it.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + canon + reader-map + foreshadowing ledger', () => {
    const check = getCheck(CHEKHOV);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('continuity');
    // `canon` is a source since #2178 — reveal-gated canon folds into the
    // authored-payoffs block, so a canon edit must re-fingerprint this check.
    expect(check.sources).toEqual(['manuscript', 'canon', 'series.arc.readerMap', 'series.arc.foreshadowing']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(CHEKHOV);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript + authored reader-map setups to the model and forces the continuity category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      series: { arc: { readerMap: { hooks: [{ label: 'The locked drawer', note: 'planted in Issue 1' }], payoffs: [] } } },
      planManuscriptChunks: async (_stage, opts) => {
        // Authored hooks/payoffs ride alongside the manuscript as trimmable context (#1459).
        expect(opts.context).toHaveProperty('authoredSetups');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nThe drawer stayed locked forever.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'high', issueNumber: 1, location: 'Issue 1 — planted, never fired', problem: 'The drawer never opens', anchorQuote: 'locked drawer' }] } };
      },
    });
    const findings = await getCheck(CHEKHOV).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 1\n\nThe drawer stayed locked forever.');
    expect(seenVars.authoredSetups).toContain('The locked drawer');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('continuity');
    expect(findings[0].location).toBe('Issue 1 — planted, never fired');
  });

  it('passes an empty authoredSetups var when the series has no reader-map', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(CHEKHOV).run(ctx);
    expect(seenVars.authoredSetups).toBe('');
  });

  it('passes the configured distant-payoff issue gap as a string var (#1595)', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      config: { maxFindings: 12, distantGap: 6 },
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(CHEKHOV).run(ctx);
    expect(seenVars.distantGap).toBe('6');
  });

  it('defaults the distant-payoff gap to 4 when the series omits it (#1595)', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(CHEKHOV).run(ctx);
    expect(seenVars.distantGap).toBe('4');
  });

  it('disables the distant-payoff section by passing an empty var when distantGap is 0 (#1595)', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      config: { maxFindings: 12, distantGap: 0 },
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(CHEKHOV).run(ctx);
    expect(seenVars.distantGap).toBe('');
  });

  it('accepts distantGap through the config schema and rejects out-of-range values (#1595)', () => {
    const { configSchema } = getCheck(CHEKHOV);
    expect(configSchema.parse({}).distantGap).toBe(4);
    expect(configSchema.parse({ distantGap: 0 }).distantGap).toBe(0);
    expect(configSchema.parse({ distantGap: 20 }).distantGap).toBe(20);
    expect(() => configSchema.parse({ distantGap: 21 })).toThrow();
    expect(() => configSchema.parse({ distantGap: -1 })).toThrow();
  });

  it('marks a single-chunk run as the final part so whole-corpus "never fired" judgments are enabled', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(CHEKHOV).run(ctx);
    expect(seenVars.finalPart).toBe('true');
  });

  it('flags only the LAST part as final across a chunked manuscript (#1299)', async () => {
    const finals = [];
    const ctx = wholeCtx({
      planManuscriptChunks: async () => ['# Issue 1\n\npart one', '# Issue 2\n\npart two', '# Issue 3\n\npart three'],
      callStagedLLM: async (_stage, vars) => { finals.push(vars.finalPart); return { content: { findings: [] } }; },
    });
    await getCheck(CHEKHOV).run(ctx);
    // Earlier parts can't know a setup pays off later → not final; only the last is.
    expect(finals).toEqual(['', '', 'true']);
  });
});

describe('authoredSetupPayoffSummary (#1299)', () => {
  it('returns an empty string when there are no authored hooks or payoffs', () => {
    expect(authoredSetupPayoffSummary(null)).toBe('');
    expect(authoredSetupPayoffSummary({})).toBe('');
    expect(authoredSetupPayoffSummary({ hooks: [], payoffs: [] })).toBe('');
  });

  it('renders authored hooks and payoffs as labelled bullet lists, with an arc-position hint when present', () => {
    const out = authoredSetupPayoffSummary({
      hooks: [{ label: 'Who killed the duke?', note: 'planted Issue 1', atArcPosition: 2 }, { label: 'The hidden heir' }],
      payoffs: [{ label: 'The butler confesses', note: 'Issue 8' }],
    });
    expect(out).toContain('Authored hooks');
    expect(out).toContain('- Who killed the duke? — planted Issue 1 (arc position 2)');
    // No position hint when atArcPosition is absent.
    expect(out).toContain('- The hidden heir');
    expect(out).not.toContain('The hidden heir (arc position');
    expect(out).toContain('Authored payoffs');
    expect(out).toContain('- The butler confesses — Issue 8');
  });

  it('drops entries with neither label nor note and falls back to note-only', () => {
    const out = authoredSetupPayoffSummary({
      hooks: [{ atArcPosition: 3 }, { note: 'a wordless dread' }],
      payoffs: [],
    });
    expect(out).toContain('- a wordless dread');
    expect(out).not.toContain('Authored payoffs');
  });
});

describe('authoredPayoffsSummary (#1583)', () => {
  it('returns an empty string when there are no authored payoffs', () => {
    expect(authoredPayoffsSummary(null)).toBe('');
    expect(authoredPayoffsSummary({})).toBe('');
    expect(authoredPayoffsSummary({ payoffs: [] })).toBe('');
    // Hooks alone do NOT produce a payoffs block — a hook is not a climax obligation.
    expect(authoredPayoffsSummary({ hooks: [{ label: 'Who killed the duke?' }] })).toBe('');
  });

  it('renders ONLY the payoffs (never the hooks), with an arc-position hint when present', () => {
    const out = authoredPayoffsSummary({
      hooks: [{ label: 'Who killed the duke?' }],
      payoffs: [{ label: 'The butler confesses', note: 'Issue 8', atArcPosition: 9 }, { label: 'The heir returns' }],
    });
    expect(out).toContain('Authored payoffs');
    expect(out).toContain('- The butler confesses — Issue 8 (arc position 9)');
    expect(out).toContain('- The heir returns');
    // The hook must never leak into the payoffs block.
    expect(out).not.toContain('Who killed the duke?');
    expect(out).not.toContain('Authored hooks');
  });

  it('drops entries with neither label nor note and falls back to note-only', () => {
    const out = authoredPayoffsSummary({ payoffs: [{ atArcPosition: 3 }, { note: 'a quiet reckoning' }] });
    expect(out).toContain('- a quiet reckoning');
  });
});

describe('plot.structure-momentum — LLM check (#1310)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nThings happened to her, and then more things happened.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    series: {},
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'Opening', setting: 'a dock', plotlineId: 'a' }],
    reverseOutlinePlotlines: [{ id: 'a', label: 'A-plot', kind: 'main' }, { id: 'b', label: 'The missing brother', kind: 'subplot' }],
    planManuscriptChunks: async () => [overrides.manuscript ?? '# Issue 1\n\nThings happened to her.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + outline + plotlines + reader-map', () => {
    const check = getCheck(PLOT_STRUCTURE);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('plot');
    expect(check.sources).toEqual(['manuscript', 'reverseOutline', 'reverseOutline.plotlines', 'series.arc.readerMap']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(PLOT_STRUCTURE);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript, scene map, plotline coverage, and authored setups to the model and forces the plot category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      series: { arc: { readerMap: { hooks: [{ label: 'Where is the brother?', note: 'planted Issue 1' }], payoffs: [] } } },
      planManuscriptChunks: async (_stage, opts) => {
        // Scene map + plotline coverage + authored setups all ride as trimmable context (#1459).
        expect(opts.context).toHaveProperty('sceneMap');
        expect(opts.context).toHaveProperty('plotlineMap');
        expect(opts.context).toHaveProperty('authoredSetups');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nThe brother thread is never mentioned again.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'high', issueNumber: 1, location: 'Dropped subplot — the missing brother', problem: 'The thread fizzles' }] } };
      },
    });
    const findings = await getCheck(PLOT_STRUCTURE).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 1\n\nThe brother thread is never mentioned again.');
    expect(seenVars.sceneMap).toContain('Issue 1: Opening');
    expect(seenVars.plotlineMap).toContain('The missing brother');
    expect(seenVars.authoredSetups).toContain('Where is the brother?');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('plot');
    expect(findings[0].location).toBe('Dropped subplot — the missing brother');
  });

  it('passes empty context vars when the series has no outline or reader-map', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      reverseOutline: undefined,
      reverseOutlinePlotlines: undefined,
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(PLOT_STRUCTURE).run(ctx);
    expect(seenVars.sceneMap).toBe('');
    expect(seenVars.plotlineMap).toBe('');
    expect(seenVars.authoredSetups).toBe('');
  });

  it('marks a single-chunk run as the final part so whole-arc judgments are enabled', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(PLOT_STRUCTURE).run(ctx);
    expect(seenVars.finalPart).toBe('true');
  });

  it('flags only the LAST part as final across a chunked manuscript', async () => {
    const finals = [];
    const ctx = wholeCtx({
      planManuscriptChunks: async () => ['# Issue 1\n\np1', '# Issue 2\n\np2', '# Issue 3\n\np3'],
      callStagedLLM: async (_stage, vars) => { finals.push(vars.finalPart); return { content: { findings: [] } }; },
    });
    await getCheck(PLOT_STRUCTURE).run(ctx);
    expect(finals).toEqual(['', '', 'true']);
  });
});

describe('pacing.escalation-curve — LLM check (#1618)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nThings happened to her, and then more things happened.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    series: {},
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'Opening', setting: 'a dock', plotlineId: 'a' }],
    planManuscriptChunks: async () => [overrides.manuscript ?? '# Issue 1\n\nThings happened to her.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + outline', () => {
    const check = getCheck(PACING_ESCALATION);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('pacing');
    expect(check.sources).toEqual(['manuscript', 'reverseOutline']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(PACING_ESCALATION);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript, scene map, and conflict-marker tally to the model and forces the pacing category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      manuscript: '# Issue 1\n\nThey shared tea and spoke softly.\n\n# Issue 2\n\nHe drew his knife and the gun fired; blood, screams, a desperate fight to the death.',
      planManuscriptChunks: async (_stage, opts) => {
        // Scene map + intensity tally both ride as trimmable context.
        expect(opts.context).toHaveProperty('sceneMap');
        expect(opts.context).toHaveProperty('intensityTally');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 2\n\nHe drew his knife and the gun fired.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'high', issueNumber: 2, location: 'Front-loaded climax — Issue 2', problem: 'The peak lands early' }] } };
      },
    });
    const findings = await getCheck(PACING_ESCALATION).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 2\n\nHe drew his knife and the gun fired.');
    expect(seenVars.sceneMap).toContain('Issue 1: Opening');
    // Both issues land in the tally; issue 2's conflict words score higher.
    expect(seenVars.intensityTally).toContain('Issue 1');
    expect(seenVars.intensityTally).toContain('Issue 2');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('pacing');
    expect(findings[0].location).toBe('Front-loaded climax — Issue 2');
  });

  it('passes empty context vars when the series has no outline and the manuscript has no issue headers', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      manuscript: 'Plain prose with no issue headers at all.',
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(PACING_ESCALATION).run(ctx);
    expect(seenVars.sceneMap).toBe('');
    expect(seenVars.intensityTally).toBe('');
  });

  it('marks a single-chunk run as the final part so whole-curve judgments are enabled', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(PACING_ESCALATION).run(ctx);
    expect(seenVars.finalPart).toBe('true');
  });

  it('flags only the LAST part as final across a chunked manuscript', async () => {
    const finals = [];
    const ctx = wholeCtx({
      planManuscriptChunks: async () => ['# Issue 1\n\np1', '# Issue 2\n\np2', '# Issue 3\n\np3'],
      callStagedLLM: async (_stage, vars) => { finals.push(vars.finalPart); return { content: { findings: [] } }; },
    });
    await getCheck(PACING_ESCALATION).run(ctx);
    expect(finals).toEqual(['', '', 'true']);
  });
});

describe('conflictIntensityTally (#1618)', () => {
  it('returns an empty string for a missing, empty, or header-less manuscript', () => {
    expect(conflictIntensityTally(undefined)).toBe('');
    expect(conflictIntensityTally('')).toBe('');
    expect(conflictIntensityTally('   ')).toBe('');
    expect(conflictIntensityTally('Just prose, no issue headers anywhere.')).toBe('');
  });

  it('tallies conflict markers per issue, in numeric order, normalized per 1k words', () => {
    const manuscript = [
      '# Issue 1 — Quiet (prose)',
      'They shared tea and spoke softly about the garden.',
      '# Issue 2 — Storm (prose)',
      'He drew his knife and the gun fired; blood, screams, a desperate fight to the death.',
    ].join('\n\n');
    const out = conflictIntensityTally(manuscript);
    const lines = out.split('\n').filter((l) => l.startsWith('- Issue'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Issue 1');
    expect(lines[1]).toContain('Issue 2');
    // Issue 1 has no markers; Issue 2 has several (knife, gun, fired, blood, screams, desperate, fight, death).
    expect(lines[0]).toContain('0 conflict markers');
    expect(lines[1]).toMatch(/[1-9]\d* conflict markers/);
  });

  it('sums a repeated issue header (chunk boundary mid-issue) into one bucket', () => {
    const manuscript = [
      '# Issue 1',
      'He drew his knife.',
      '# Issue 1',
      'The gun fired and blood spilled.',
    ].join('\n\n');
    const out = conflictIntensityTally(manuscript);
    const lines = out.split('\n').filter((l) => l.startsWith('- Issue'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Issue 1');
    // knife + gun + fired + blood = 4 markers merged across the two header sections.
    expect(lines[0]).toContain('4 conflict markers');
  });
});

describe('plotlineCoverageSummary (#1310)', () => {
  it('returns an empty string when there are no plotlines', () => {
    expect(plotlineCoverageSummary(null, [])).toBe('');
    expect(plotlineCoverageSummary([], [])).toBe('');
    expect(plotlineCoverageSummary(undefined, undefined)).toBe('');
  });

  it('renders per-plotline scene counts and the issue span the scenes touch', () => {
    const plotlines = [
      { id: 'a', label: 'A-plot', kind: 'main' },
      { id: 'b', label: 'The missing brother', kind: 'subplot' },
    ];
    const scenes = [
      { issueNumber: 1, plotlineId: 'a' },
      { issueNumber: 2, plotlineId: 'a', secondaryPlotlineId: 'b' },
      { issueNumber: 5, plotlineId: 'a' },
    ];
    const out = plotlineCoverageSummary(plotlines, scenes);
    expect(out).toContain('Plotlines (from the reverse outline');
    expect(out).toContain('- A-plot (main): 3 scenes, issues 1–5');
    // The subplot is carried only as a secondary tag on the Issue 2 scene.
    expect(out).toContain('- The missing brother (subplot): 1 scene, issue 2');
  });

  it('reports a plotline with no tagged scenes (a candidate dropped subplot)', () => {
    const out = plotlineCoverageSummary([{ id: 'c', label: 'Orphan thread', kind: 'subplot' }], []);
    expect(out).toContain('- Orphan thread (subplot): 0 scenes, no tagged scenes');
  });

  it('is type-guarded against hand-edited / older-peer plotline rows', () => {
    const out = plotlineCoverageSummary(
      [null, { id: '' }, { id: 'x', label: 42, kind: null }],
      [{ issueNumber: 3, plotlineId: 'x' }],
    );
    // Falls back to the id for a non-string label and 'other' for a missing kind.
    expect(out).toContain('- x (other): 1 scene, issue 3');
    // The null and id-less rows are dropped.
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
  });
});

describe('continuity.timeline-contradiction — LLM check (#1581)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nMara died on the bridge.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    series: {},
    canon: { characters: [{ name: 'Mara', age: 16, status: 'deceased after Issue 3' }] },
    continuityBible: [{ category: 'age', subject: 'Mara', statement: 'is 16', issueNumber: 1 }],
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'The bridge', setting: 'a bridge', charactersPresent: ['Mara'] }],
    planManuscriptChunks: async () => ['# Issue 1\n\nMara died on the bridge.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + canon + outline + arcs', () => {
    const check = getCheck(TIMELINE_CONTRADICTION);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('continuity');
    expect(check.severityDefault).toBe('medium');
    expect(check.sources).toEqual(['manuscript', 'canon', 'continuityBible', 'reverseOutline', 'series.characterArcs']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(TIMELINE_CONTRADICTION);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript, continuity ledger, canon facts, and scene map to the model and forces the continuity category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // Continuity ledger + canon states + scene map + character arcs all ride as trimmable context.
        expect(opts.context).toHaveProperty('continuityLedger');
        expect(opts.context).toHaveProperty('canonStates');
        expect(opts.context).toHaveProperty('sceneMap');
        expect(opts.context).toHaveProperty('characterArcs');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 6\n\nMara walked back into the room, very much alive.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'high', issueNumber: 6, location: 'Mara — resurrection', problem: 'Mara died in Issue 3 but is alive here' }] } };
      },
    });
    const findings = await getCheck(TIMELINE_CONTRADICTION).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 6\n\nMara walked back into the room, very much alive.');
    expect(seenVars.continuityLedger).toContain('Mara: is 16');
    expect(seenVars.canonStates).toContain('Mara');
    expect(seenVars.canonStates).toContain('age 16');
    expect(seenVars.sceneMap).toContain('Issue 1: The bridge');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('continuity');
    expect(findings[0].location).toBe('Mara — resurrection');
  });

  it('passes empty context vars when the series has no ledger, canon, or outline', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      canon: undefined,
      continuityBible: undefined,
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(TIMELINE_CONTRADICTION).run(ctx);
    expect(seenVars.continuityLedger).toBe('');
    expect(seenVars.canonStates).toBe('');
    expect(seenVars.sceneMap).toBe('');
    expect(seenVars.characterArcs).toBe('');
  });
});

describe('continuityLedgerSummary (#1581)', () => {
  it('returns an empty string when there are no usable facts', () => {
    expect(continuityLedgerSummary(null)).toBe('');
    expect(continuityLedgerSummary(undefined)).toBe('');
    expect(continuityLedgerSummary([])).toBe('');
    // A fact missing a category or statement is dropped.
    expect(continuityLedgerSummary([{ subject: 'Mara' }, { category: 'age' }])).toBe('');
  });

  it('groups facts by category in canonical order, with prettied labels and issue tags', () => {
    const out = continuityLedgerSummary([
      { category: 'timeline', subject: 'The crossing', statement: 'takes eight days', issueNumber: 2 },
      { category: 'age', subject: 'Mara', statement: 'is 16' },
    ]);
    expect(out).toContain('Continuity bible facts');
    // Age (canonical order) renders before Dates & elapsed time.
    expect(out.indexOf('Ages & birthdays')).toBeLessThan(out.indexOf('Dates & elapsed time'));
    expect(out).toContain('- Mara: is 16');
    expect(out).toContain('- The crossing: takes eight days (Issue 2)');
  });

  it('falls back to the raw category id for an unknown (newer-peer) category and is type-guarded', () => {
    expect(() => continuityLedgerSummary([null, 'nope', { category: 5, statement: 'x' }])).not.toThrow();
    const out = continuityLedgerSummary([{ category: 'mood', statement: 'the tone is grim' }]);
    expect(out).toContain('mood:\n- the tone is grim');
  });
});

describe('canonCharacterStatesSummary (#1581)', () => {
  it('returns an empty string when there are no characters or no renderable facts', () => {
    expect(canonCharacterStatesSummary(null)).toBe('');
    expect(canonCharacterStatesSummary(undefined)).toBe('');
    expect(canonCharacterStatesSummary({ characters: [] })).toBe('');
    // A named character with no contradiction-relevant fact renders nothing.
    expect(canonCharacterStatesSummary({ characters: [{ name: 'Joss' }] })).toBe('');
    // An alias-only row (no name) is skipped.
    expect(canonCharacterStatesSummary({ characters: [{ aliases: ['x'], age: 40 }] })).toBe('');
  });

  it('renders each character with name + aliases and the present facts', () => {
    const out = canonCharacterStatesSummary({ characters: [
      { name: 'Mara', aliases: ['The Captain'], age: 16, status: 'deceased after Issue 3', role: 'protagonist' },
      { name: 'Joss', description: 'a tall man with a scar' },
    ] });
    expect(out).toContain('Canon character facts');
    expect(out).toContain('- Mara (also: The Captain) — age 16; role: protagonist; status: deceased after Issue 3');
    expect(out).toContain('- Joss — described as: a tall man with a scar');
  });

  it('accepts a numeric or string age and prefers physicalDescription over description', () => {
    const out = canonCharacterStatesSummary({ characters: [
      { name: 'A', age: '30s' },
      { name: 'B', physicalDescription: 'rich', description: 'poor' },
    ] });
    expect(out).toContain('- A — age 30s');
    expect(out).toContain('- B — described as: rich');
    expect(out).not.toContain('poor');
  });

  it('is type-guarded against hand-edited / older-peer rows', () => {
    expect(() => canonCharacterStatesSummary({ characters: [null, 'nope', { name: 'C', role: 5, age: {} }] })).not.toThrow();
    // role is a non-string and age is a non-finite object → no facts → C drops out.
    expect(canonCharacterStatesSummary({ characters: [{ name: 'C', role: 5, age: {} }] })).toBe('');
  });
});

describe('character.consistency — LLM check (#1582)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nMara said nothing, as always.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    series: {},
    canon: { characters: [{ name: 'Mara', personality: 'reserved and guarded', specialTraits: 'deathly afraid of fire' }] },
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'The watch', setting: 'a wall', charactersPresent: ['Mara'] }],
    planManuscriptChunks: async () => ['# Issue 1\n\nMara said nothing, as always.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + canon + outline + arcs', () => {
    const check = getCheck(CHARACTER_CONSISTENCY);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('character');
    expect(check.severityDefault).toBe('medium');
    expect(check.sources).toEqual(['manuscript', 'canon', 'reverseOutline', 'series.characterArcs']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(CHARACTER_CONSISTENCY);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript, canon traits, and scene map to the model and forces the character category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // Canon traits + scene map + character arcs all ride as trimmable context.
        expect(opts.context).toHaveProperty('canonTraits');
        expect(opts.context).toHaveProperty('sceneMap');
        expect(opts.context).toHaveProperty('characterArcs');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 6\n\nMara cracked a joke, suddenly the life of the party.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'medium', issueNumber: 6, location: 'Mara — personality', problem: 'Mara is reserved in canon but jokes freely here with no earned beat' }] } };
      },
    });
    const findings = await getCheck(CHARACTER_CONSISTENCY).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 6\n\nMara cracked a joke, suddenly the life of the party.');
    expect(seenVars.canonTraits).toContain('Mara');
    expect(seenVars.canonTraits).toContain('personality: reserved and guarded');
    expect(seenVars.sceneMap).toContain('Issue 1: The watch');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('character');
    expect(findings[0].location).toBe('Mara — personality');
  });

  it('passes empty context vars when the series has no canon or outline', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      canon: undefined,
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(CHARACTER_CONSISTENCY).run(ctx);
    expect(seenVars.canonTraits).toBe('');
    expect(seenVars.sceneMap).toBe('');
    expect(seenVars.characterArcs).toBe('');
  });
});

describe('canonCharacterTraitsSummary (#1582)', () => {
  it('returns an empty string when there are no characters or no renderable traits', () => {
    expect(canonCharacterTraitsSummary(null)).toBe('');
    expect(canonCharacterTraitsSummary(undefined)).toBe('');
    expect(canonCharacterTraitsSummary({ characters: [] })).toBe('');
    // A named character with no trait-relevant field renders nothing (age/role/status
    // are facts, not traits — they belong to canonCharacterStatesSummary).
    expect(canonCharacterTraitsSummary({ characters: [{ name: 'Joss', age: 40, role: 'lead' }] })).toBe('');
    // An alias-only row (no name) is skipped.
    expect(canonCharacterTraitsSummary({ characters: [{ aliases: ['x'], personality: 'kind' }] })).toBe('');
  });

  it('renders each character with name + aliases and the present traits', () => {
    const out = canonCharacterTraitsSummary({ characters: [
      { name: 'Mara', aliases: ['The Captain'], personality: 'reserved and guarded', specialTraits: 'afraid of fire', speechPattern: 'clipped, formal' },
      { name: 'Joss', mannerisms: ['taps the table', 'never sits still'], likes: ['chess'], dislikes: ['small talk'] },
    ] });
    expect(out).toContain('Canon character traits');
    expect(out).toContain('- Mara (also: The Captain) — personality: reserved and guarded; fixed traits: afraid of fire; speech: clipped, formal');
    expect(out).toContain('- Joss — mannerisms: taps the table, never sits still; likes: chess; dislikes: small talk');
  });

  it('renders array OR string list fields and caps the list length', () => {
    const out = canonCharacterTraitsSummary({ characters: [
      { name: 'A', mannerisms: 'hums constantly' },
      { name: 'B', likes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    ] });
    expect(out).toContain('- A — mannerisms: hums constantly');
    // first five only
    expect(out).toContain('- B — likes: a, b, c, d, e');
    expect(out).not.toContain('a, b, c, d, e, f');
  });

  it('is type-guarded against hand-edited / older-peer rows', () => {
    expect(() => canonCharacterTraitsSummary({ characters: [null, 'nope', { name: 'C', personality: 5, mannerisms: {} }] })).not.toThrow();
    // personality is a non-string and mannerisms is a non-array object → no traits → C drops out.
    expect(canonCharacterTraitsSummary({ characters: [{ name: 'C', personality: 5, mannerisms: {} }] })).toBe('');
  });
});

describe('theme.coherence — LLM check (#1317)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nShe chose loyalty, and it cost her everything.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    series: { arc: { themes: ['the cost of loyalty', 'forgiveness'] } },
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'Opening', setting: 'a war room' }],
    planManuscriptChunks: async () => ['# Issue 1\n\nShe chose loyalty.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + arc themes + outline', () => {
    const check = getCheck(THEME_COHERENCE);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('theme');
    expect(check.sources).toEqual(['manuscript', 'series.arc.themes', 'reverseOutline']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(THEME_COHERENCE);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript, declared themes, and scene map to the model and forces the theme category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // Declared themes + scene map both ride as trimmable context (#1459).
        expect(opts.context).toHaveProperty('declaredThemes');
        expect(opts.context).toHaveProperty('sceneMap');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nForgiveness is never mentioned again.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'high', issueNumber: 1, location: 'Dropped theme — "forgiveness"', problem: 'Set up then abandoned' }] } };
      },
    });
    const findings = await getCheck(THEME_COHERENCE).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 1\n\nForgiveness is never mentioned again.');
    expect(seenVars.declaredThemes).toContain('the cost of loyalty');
    expect(seenVars.declaredThemes).toContain('forgiveness');
    expect(seenVars.sceneMap).toContain('Issue 1: Opening');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('theme');
    expect(findings[0].location).toBe('Dropped theme — "forgiveness"');
  });

  it('passes empty context vars when the series has no themes or outline', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      series: {},
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(THEME_COHERENCE).run(ctx);
    expect(seenVars.declaredThemes).toBe('');
    expect(seenVars.sceneMap).toBe('');
  });

  it('marks a single-chunk run as the final part so whole-arc judgments are enabled', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(THEME_COHERENCE).run(ctx);
    expect(seenVars.finalPart).toBe('true');
  });

  it('flags only the LAST part as final across a chunked manuscript', async () => {
    const finals = [];
    const ctx = wholeCtx({
      planManuscriptChunks: async () => ['# Issue 1\n\np1', '# Issue 2\n\np2', '# Issue 3\n\np3'],
      callStagedLLM: async (_stage, vars) => { finals.push(vars.finalPart); return { content: { findings: [] } }; },
    });
    await getCheck(THEME_COHERENCE).run(ctx);
    expect(finals).toEqual(['', '', 'true']);
  });
});

describe('arc.climax-agency — LLM check (#1583)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nThe hero waited as the cavalry arrived.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    series: { arc: {
      themes: ['earning forgiveness'],
      readerMap: {
        hooks: [{ label: 'who burned the village?' }],
        payoffs: [{ label: 'the debt is repaid', note: 'by the protagonist' }],
      },
    } },
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'The siege', setting: 'the gate', charactersPresent: ['Hero'] }],
    planManuscriptChunks: async () => ['# Issue 1\n\nThe hero waited as the cavalry arrived.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + outline + reader-map + themes', () => {
    const check = getCheck(CLIMAX_AGENCY);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('arc');
    expect(check.severityDefault).toBe('medium');
    expect(check.sources).toEqual(['manuscript', 'reverseOutline', 'series.arc.readerMap', 'series.arc.themes']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(CLIMAX_AGENCY);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript, authored payoffs, declared themes, and scene map and forces the arc category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // Authored payoffs + declared themes + scene map all ride as trimmable context.
        expect(opts.context).toHaveProperty('authoredPayoffs');
        expect(opts.context).toHaveProperty('declaredThemes');
        expect(opts.context).toHaveProperty('sceneMap');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nThe hero waited as the cavalry arrived and won the day.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'high', issueNumber: 1, location: 'Issue 1 climax — agency', problem: 'The cavalry, not the hero, resolves the conflict' }] } };
      },
    });
    const findings = await getCheck(CLIMAX_AGENCY).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 1\n\nThe hero waited as the cavalry arrived and won the day.');
    expect(seenVars.authoredPayoffs).toContain('the debt is repaid');
    // Only PAYOFFS feed the climax check — a planted hook is not a climax
    // obligation, so it must NOT appear in the authoredPayoffs block (#1583).
    expect(seenVars.authoredPayoffs).not.toContain('who burned the village?');
    expect(seenVars.declaredThemes).toContain('earning forgiveness');
    expect(seenVars.sceneMap).toContain('Issue 1: The siege');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('arc');
    expect(findings[0].location).toBe('Issue 1 climax — agency');
  });

  it('passes empty context vars when the series has no reader-map, themes, or outline', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      series: {},
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(CLIMAX_AGENCY).run(ctx);
    expect(seenVars.authoredPayoffs).toBe('');
    expect(seenVars.declaredThemes).toBe('');
    expect(seenVars.sceneMap).toBe('');
  });

  it('marks a single-chunk run as the final part so the climax verdict is enabled', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(CLIMAX_AGENCY).run(ctx);
    expect(seenVars.finalPart).toBe('true');
  });

  it('flags only the LAST part as final across a chunked manuscript', async () => {
    const finals = [];
    const ctx = wholeCtx({
      planManuscriptChunks: async () => ['# Issue 1\n\np1', '# Issue 2\n\np2', '# Issue 3\n\np3'],
      callStagedLLM: async (_stage, vars) => { finals.push(vars.finalPart); return { content: { findings: [] } }; },
    });
    await getCheck(CLIMAX_AGENCY).run(ctx);
    expect(finals).toEqual(['', '', 'true']);
  });
});

describe('emotion.reaction-proportionality — LLM check (#1584)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nThe bomb killed her brother. She made breakfast.',
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'The blast', setting: 'the kitchen', charactersPresent: ['Mara'] }],
    planManuscriptChunks: async () => ['# Issue 1\n\nThe bomb killed her brother. She made breakfast.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + outline with category emotion', () => {
    const check = getCheck(REACTION_PROPORTIONALITY);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('emotion');
    expect(check.severityDefault).toBe('medium');
    expect(check.sources).toEqual(['manuscript', 'reverseOutline']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(REACTION_PROPORTIONALITY);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript + scene map to the model and forces the emotion category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // The scene map rides as trimmable context with a non-zero overhead.
        expect(opts.context).toHaveProperty('sceneMap');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nThe bomb killed her brother. She made breakfast.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'high', issueNumber: 1, location: 'Issue 1 — Mara — under-reaction', problem: 'Her brother dies and she shows no reaction' }] } };
      },
    });
    const findings = await getCheck(REACTION_PROPORTIONALITY).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 1\n\nThe bomb killed her brother. She made breakfast.');
    expect(seenVars.sceneMap).toContain('Issue 1: The blast');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('emotion');
    expect(findings[0].location).toBe('Issue 1 — Mara — under-reaction');
  });

  it('passes an empty scene map when the series has no reverse outline', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(REACTION_PROPORTIONALITY).run(ctx);
    expect(seenVars.sceneMap).toBe('');
  });

  it('marks a single-chunk run as the final part so the under-reaction verdict is enabled', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(REACTION_PROPORTIONALITY).run(ctx);
    expect(seenVars.finalPart).toBe('true');
  });

  it('flags only the LAST part as final across a chunked manuscript (under-reaction gate)', async () => {
    const finals = [];
    const ctx = wholeCtx({
      planManuscriptChunks: async () => ['# Issue 1\n\np1', '# Issue 2\n\np2', '# Issue 3\n\np3'],
      callStagedLLM: async (_stage, vars) => { finals.push(vars.finalPart); return { content: { findings: [] } }; },
    });
    await getCheck(REACTION_PROPORTIONALITY).run(ctx);
    expect(finals).toEqual(['', '', 'true']);
  });
});

describe('secondaryCharacterPresenceSummary (#1585)', () => {
  it('tallies recurring NON-POV characters, excluding anyone who ever holds POV', () => {
    const summary = secondaryCharacterPresenceSummary([
      { sequence: 0, issueNumber: 1, povCharacter: 'Mara', charactersPresent: ['Mara', 'Joss', 'Reza'] },
      { sequence: 1, issueNumber: 2, povCharacter: 'Mara', charactersPresent: ['Mara', 'Joss'] },
      { sequence: 2, issueNumber: 3, povCharacter: 'Joss', charactersPresent: ['Joss', 'Reza'] },
    ]);
    expect(summary).toContain('Recurring non-POV characters');
    // Reza is present in 2 scenes and never holds POV → recurring secondary.
    expect(summary).toContain('Reza: present in 2 scenes (issues 1–3)');
    // Joss holds POV in scene 3, so although present in 3 scenes they are a POV
    // character (judged by pov.justified) and excluded entirely.
    expect(summary).not.toContain('Joss:');
    // Mara is the POV holder throughout → never a secondary.
    expect(summary).not.toContain('Mara:');
  });

  it('drops a one-scene walk-on below the recurrence threshold', () => {
    const summary = secondaryCharacterPresenceSummary([
      { sequence: 0, issueNumber: 1, povCharacter: 'Mara', charactersPresent: ['Mara', 'Cole'] },
    ]);
    // Cole appears once → below minScenes default of 2 → no roster.
    expect(summary).toBe('');
  });

  it('respects a raised minScenes threshold', () => {
    const scenes = [
      { sequence: 0, issueNumber: 1, povCharacter: 'Mara', charactersPresent: ['Mara', 'Reza'] },
      { sequence: 1, issueNumber: 2, povCharacter: 'Mara', charactersPresent: ['Mara', 'Reza'] },
    ];
    // Reza appears in 2 scenes: surfaces at the default but not at minScenes 3.
    expect(secondaryCharacterPresenceSummary(scenes, { minScenes: 2 })).toContain('Reza');
    expect(secondaryCharacterPresenceSummary(scenes, { minScenes: 3 })).toBe('');
  });

  it('counts a character once per scene even if listed twice', () => {
    const summary = secondaryCharacterPresenceSummary([
      { sequence: 0, issueNumber: 1, povCharacter: 'Mara', charactersPresent: ['Reza', 'reza'] },
      { sequence: 1, issueNumber: 2, povCharacter: 'Mara', charactersPresent: ['Reza'] },
    ]);
    // Two scenes, not three — the in-scene duplicate collapses by normalized name.
    expect(summary).toContain('Reza: present in 2 scenes');
  });

  it('returns "" when there are no scenes', () => {
    expect(secondaryCharacterPresenceSummary([])).toBe('');
    expect(secondaryCharacterPresenceSummary(null)).toBe('');
    expect(secondaryCharacterPresenceSummary(undefined)).toBe('');
  });

  it('tolerates malformed scenes (peer-sync resilience) without throwing', () => {
    expect(() => secondaryCharacterPresenceSummary([
      null,
      { sequence: 1, povCharacter: 99, charactersPresent: 'not-an-array' },
      { sequence: 2, povCharacter: 'Mara', charactersPresent: [1, null, 'Reza'] },
      { sequence: 3, povCharacter: 'Mara', charactersPresent: ['Reza'] },
    ])).not.toThrow();
    const summary = secondaryCharacterPresenceSummary([
      { sequence: 2, povCharacter: 'Mara', charactersPresent: [1, null, 'Reza'] },
      { sequence: 3, povCharacter: 'Mara', charactersPresent: ['Reza'] },
    ]);
    expect(summary).toContain('Reza: present in 2 scenes');
  });
});

describe('character.secondary-arc — LLM check (#1585)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nReza poured the coffee, said nothing, and left — as always.',
    config: { minScenes: 2, maxFindings: 12 },
    severityDefault: 'low',
    canon: { characters: [{ name: 'Reza', personality: 'stoic and quiet' }] },
    reverseOutline: [
      { sequence: 0, issueNumber: 1, heading: 'The diner', povCharacter: 'Mara', charactersPresent: ['Mara', 'Reza'] },
      { sequence: 1, issueNumber: 2, heading: 'The diner again', povCharacter: 'Mara', charactersPresent: ['Mara', 'Reza'] },
    ],
    planManuscriptChunks: async () => ['# Issue 1\n\nReza poured the coffee, said nothing, and left — as always.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + outline + canon', () => {
    const check = getCheck(SECONDARY_ARC);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('arc');
    expect(check.severityDefault).toBe('low');
    expect(check.sources).toEqual(['manuscript', 'reverseOutline', 'canon']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(SECONDARY_ARC);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript, recurring secondary roster, canon names roster, and canon traits and forces the arc category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        expect(opts.context).toHaveProperty('secondaryCast');
        expect(opts.context).toHaveProperty('canonRoster');
        expect(opts.context).toHaveProperty('canonTraits');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nReza poured the coffee, said nothing, and left — as always.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'low', issueNumber: 2, location: 'Issue 2 — Reza — flat arc', problem: 'Reza never changes' }] } };
      },
    });
    const findings = await getCheck(SECONDARY_ARC).run(ctx);
    expect(seenVars.secondaryCast).toContain('Reza');
    // Canon names roster surfaces every named bible character (so the modeled-vs-
    // incidental distinction works even for a trait-less row), and the traits
    // block carries the established baseline a change is measured against.
    expect(seenVars.canonRoster).toContain('Reza');
    expect(seenVars.canonTraits).toContain('stoic and quiet');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('arc');
    expect(findings[0].location).toBe('Issue 2 — Reza — flat arc');
  });

  it('still names a modeled character with no recorded traits in the canon roster (modeled-vs-incidental)', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      // A modeled character with a name but no trait fields — the traits summary
      // drops it, but the names roster must still list it so the model can tell
      // it apart from an incidental walk-on.
      canon: { characters: [{ name: 'Reza' }] },
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(SECONDARY_ARC).run(ctx);
    expect(seenVars.canonRoster).toContain('Reza');
    expect(seenVars.canonTraits).toBe('');
  });

  it('honors the minScenes config when building the secondary roster', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      config: { minScenes: 3, maxFindings: 12 },
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(SECONDARY_ARC).run(ctx);
    // Reza appears in only 2 scenes → excluded at minScenes 3 → empty roster.
    expect(seenVars.secondaryCast).toBe('');
  });

  it('passes empty context vars when there is no outline or canon', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      canon: undefined,
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(SECONDARY_ARC).run(ctx);
    expect(seenVars.secondaryCast).toBe('');
    expect(seenVars.canonRoster).toBe('');
    expect(seenVars.canonTraits).toBe('');
  });

  it('marks a single-chunk run as the final part so the flat-arc verdict is enabled', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(SECONDARY_ARC).run(ctx);
    expect(seenVars.finalPart).toBe('true');
  });

  it('flags only the LAST part as final across a chunked manuscript', async () => {
    const finals = [];
    const ctx = wholeCtx({
      planManuscriptChunks: async () => ['# Issue 1\n\np1', '# Issue 2\n\np2', '# Issue 3\n\np3'],
      callStagedLLM: async (_stage, vars) => { finals.push(vars.finalPart); return { content: { findings: [] } }; },
    });
    await getCheck(SECONDARY_ARC).run(ctx);
    expect(finals).toEqual(['', '', 'true']);
  });
});

describe('style.voice-consistency — LLM check (#1586)', () => {
  const VOICE_CONSISTENCY = 'style.voice-consistency';
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nThe rain came down, wry and unhurried, as it always did in this town.',
    config: { maxFindings: 12 },
    severityDefault: 'low',
    series: { styleGuide: { tone: ['wry', 'deadpan'] } },
    planManuscriptChunks: async () => ['# Issue 1\n\nnarration'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM check reading manuscript + style guide', () => {
    const check = getCheck(VOICE_CONSISTENCY);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('style');
    expect(check.severityDefault).toBe('low');
    expect(check.sources).toEqual(['manuscript', 'series.styleGuide']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(VOICE_CONSISTENCY);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('feeds the style guide intended voice alongside the manuscript and forces the style category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        expect(opts.context).toHaveProperty('intendedVoice');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nnarration'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'medium', issueNumber: 3, location: 'Issue 3 — tonal shift', problem: 'narration turns earnest', anchorQuote: 'how he loved her' }] } };
      },
    });
    const findings = await getCheck(VOICE_CONSISTENCY).run(ctx);
    expect(seenVars.intendedVoice).toContain('wry');
    expect(seenVars.intendedVoice).toContain('deadpan');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('style');
    expect(findings[0].location).toBe('Issue 3 — tonal shift');
  });

  it('still runs (cross-issue whiplash) when no style guide tone is declared', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      series: undefined,
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(VOICE_CONSISTENCY).run(ctx);
    expect(seenVars.intendedVoice).toBe('');
  });
});

describe('intendedVoiceSummary helper (#1586)', () => {
  it('renders the style guide tone words', () => {
    const out = intendedVoiceSummary({ tone: ['wry', 'deadpan', 'noir'] });
    expect(out).toContain('intended narrative tone/voice');
    expect(out).toContain('wry, deadpan, noir');
  });

  it('returns "" when the guide declares no tone', () => {
    expect(intendedVoiceSummary({ tone: [] })).toBe('');
    expect(intendedVoiceSummary({})).toBe('');
    expect(intendedVoiceSummary(null)).toBe('');
    expect(intendedVoiceSummary(undefined)).toBe('');
  });

  it('tolerates a malformed tone field without throwing', () => {
    expect(() => intendedVoiceSummary({ tone: 'not-an-array' })).not.toThrow();
    expect(intendedVoiceSummary({ tone: 'not-an-array' })).toBe('');
    expect(() => intendedVoiceSummary({ tone: [null, 42, '  ', 'wry'] })).not.toThrow();
    expect(intendedVoiceSummary({ tone: [null, 42, '  ', 'wry'] })).toBe('Style guide — intended narrative tone/voice: wry.');
  });
});

describe('declaredThemesSummary (#1317)', () => {
  it('returns an empty string when there are no themes', () => {
    expect(declaredThemesSummary(null)).toBe('');
    expect(declaredThemesSummary(undefined)).toBe('');
    expect(declaredThemesSummary([])).toBe('');
    expect(declaredThemesSummary(['', '   '])).toBe('');
  });

  it('renders one bullet per theme under a header', () => {
    const out = declaredThemesSummary(['the cost of loyalty', 'forgiveness']);
    expect(out).toContain('Declared themes (authored on the story arc):');
    expect(out).toContain('- the cost of loyalty');
    expect(out).toContain('- forgiveness');
  });

  it('is type-guarded against hand-edited / older-peer rows and trims whitespace', () => {
    const out = declaredThemesSummary([42, null, '  identity  ', { x: 1 }]);
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- identity']);
  });
});

describe('roster.unmodeled-names — LLM check (#1412)', () => {
  // The deterministic recurrence pass reads ctx.sections (one per issue), so a
  // surfaced name's appearances are counted across the WHOLE manuscript — not just
  // the chunk the model saw. `llmFinds` stubs the LLM to surface the given names.
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nMarguerite drew her sword as the bells of Veridia rang.',
    config: { maxFindings: 12 },
    severityDefault: 'low',
    canon: { characters: [{ name: 'Robert', aliases: ['Bob'] }] },
    sections: [{ number: 1, content: 'Marguerite drew her sword as the bells of Veridia rang.' }],
    planManuscriptChunks: async () => ['# Issue 1\n\nMarguerite drew her sword.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });
  const llmFinds = (...names) => async () => ({
    content: { findings: names.map((n) => ({ severity: 'low', issueNumber: 1, location: `Unmodeled character — "${n}"`, problem: `${n} is not in canon` })) },
  });

  it('is registered as a series-scoped LLM casting check reading manuscript + canon', () => {
    const check = getCheck(UNMODELED_NAMES);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('casting');
    expect(check.sources).toEqual(['manuscript', 'canon']);
    expect(check.needsManuscript).toBe(true);
  });

  it('runs whenever there is prose — even with an EMPTY canon (every name is unmodeled)', () => {
    const check = getCheck(UNMODELED_NAMES);
    expect(check.gate({ manuscript: '' })).toBe(false);
    // Unlike roster.economy, it does NOT require a populated canon.
    expect(check.gate({ manuscript: '# Issue 1\n\nprose', canon: { characters: [] } })).toBeTruthy();
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript + known-character roster to the model and forces the casting category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // The known-character roster rides as trimmable context (#1459).
        expect(opts.context).toHaveProperty('knownCharacters');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nMarguerite drew her sword.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'medium', issueNumber: 1, location: 'Unmodeled character — "Marguerite"', problem: 'Named but not in canon' }] } };
      },
    });
    const findings = await getCheck(UNMODELED_NAMES).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 1\n\nMarguerite drew her sword.');
    expect(seenVars.knownCharacters).toContain('Robert');
    expect(seenVars.knownCharacters).toContain('Bob');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('casting');
  });

  it('passes an empty roster var when the canon has no characters', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      canon: { characters: [] },
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(UNMODELED_NAMES).run(ctx);
    expect(seenVars.knownCharacters).toBe('');
  });

  it('relabels a one-appearance surfaced name as a low-severity throwaway', async () => {
    const ctx = wholeCtx({
      sections: [{ number: 1, content: 'Old Henrik nodded once and was never seen again.' }],
      callStagedLLM: llmFinds('Old Henrik'),
    });
    const findings = await getCheck(UNMODELED_NAMES).run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toBe('Throwaway name — "Old Henrik" (1 appearance)');
    expect(findings[0].severity).toBe('low');
    // problem/suggestion are authored deterministically (not the LLM's free text),
    // so the frequency narrative can never contradict the label.
    expect(findings[0].problem).toContain('only one issue');
    expect(findings[0].suggestion).toContain('recast them as an unnamed description');
  });

  it('counts appearances across ALL sections (not just the seen chunk) and labels a recurring name medium', async () => {
    // Marguerite appears in issues 1 and 3 — the deterministic pass must see both,
    // so a chunk that only showed issue 3 can't mislabel her a one-appearance throwaway.
    const ctx = wholeCtx({
      sections: [
        { number: 1, content: 'Marguerite drew her sword.' },
        { number: 2, content: 'A quiet interlude with no new names.' },
        { number: 3, content: 'Marguerite returned to the war room.' },
      ],
      callStagedLLM: llmFinds('Marguerite'),
    });
    const findings = await getCheck(UNMODELED_NAMES).run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toBe('Unmodeled character — "Marguerite" (2 issues)');
    expect(findings[0].severity).toBe('medium');
    expect(findings[0].problem).toContain('across 2 issues');
    expect(findings[0].suggestion).toContain('add "Marguerite" to canon');
  });

  it('authors problem/suggestion deterministically — a contradicting LLM frequency claim cannot survive', async () => {
    // The model (wrongly) calls a recurring name a one-off in its free text. Because
    // the post-pass OWNS problem/suggestion (it doesn't append to the model's text),
    // the recurring verdict + count win and the false "appears only once" never shows.
    const ctx = wholeCtx({
      sections: [
        { number: 1, content: 'Marguerite drew her sword.' },
        { number: 2, content: 'Marguerite returned to the war room.' },
      ],
      callStagedLLM: async () => ({ content: { findings: [{
        severity: 'low', issueNumber: 1, location: 'Unmodeled character — "Marguerite"',
        problem: 'Marguerite appears only once and should be cut.',
        suggestion: 'Recast Marguerite as an unnamed description.',
      }] } }),
    });
    const findings = await getCheck(UNMODELED_NAMES).run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toBe('Unmodeled character — "Marguerite" (2 issues)');
    expect(findings[0].problem).not.toContain('only once');
    expect(findings[0].problem).toContain('across 2 issues');
    expect(findings[0].suggestion).not.toContain('unnamed description');
  });

  it('collapses the same surfaced name reported from two different chunks into one finding', async () => {
    const ctx = wholeCtx({
      sections: [
        { number: 1, content: 'Marguerite drew her sword.' },
        { number: 2, content: 'Marguerite sheathed it again.' },
      ],
      // Two chunks each surface Marguerite — the dedupe keeps one.
      callStagedLLM: llmFinds('Marguerite', 'Marguerite'),
    });
    const findings = await getCheck(UNMODELED_NAMES).run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toBe('Unmodeled character — "Marguerite" (2 issues)');
  });

  it('drops malformed findings — no quoted name, or a quoted name absent from the prose', async () => {
    const ctx = wholeCtx({
      sections: [{ number: 1, content: 'Nothing matching here.' }],
      callStagedLLM: async () => ({ content: { findings: [
        // Quote-less ⇒ can't verify the name against the prose, and we won't pass the
        // model's un-vetted text through ⇒ dropped.
        { severity: 'low', issueNumber: 1, location: 'General note (no quoted name)', problem: 'malformed, appears only once' },
        // Quoted but matches 0 sections (garbled token) ⇒ dropped.
        { severity: 'low', issueNumber: 1, location: 'Unmodeled character — "Ghostname"', problem: 'not actually in prose' },
      ] } }),
    });
    const findings = await getCheck(UNMODELED_NAMES).run(ctx);
    expect(findings).toEqual([]);
  });
});

describe('canonRosterNamesSummary (#1412)', () => {
  it('returns an empty string when there are no usable canon names', () => {
    expect(canonRosterNamesSummary(null)).toBe('');
    expect(canonRosterNamesSummary(undefined)).toBe('');
    expect(canonRosterNamesSummary({ characters: [] })).toBe('');
    expect(canonRosterNamesSummary({ characters: [{ name: '   ' }, { aliases: ['x'] }] })).toBe('');
  });

  it('renders one bullet per character with aliases appended', () => {
    const out = canonRosterNamesSummary({ characters: [
      { name: 'Robert', aliases: ['Bob', 'Bobby'] },
      { name: 'Alice' },
    ] });
    expect(out).toContain('do NOT flag these');
    expect(out).toContain('- Robert (also: Bob, Bobby)');
    expect(out).toContain('- Alice');
  });

  it('is type-guarded against hand-edited / older-peer rows and de-dups name vs alias', () => {
    const out = canonRosterNamesSummary({ characters: [
      42,
      null,
      { name: '  Henrik  ', aliases: ['Henrik', '  ', 7] },
    ] });
    // Name trimmed; the alias equal to the name is de-duped, blanks/non-strings dropped.
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- Henrik']);
  });
});

describe('endings.cliffhanger — LLM check (#1298)', () => {
  const wholeCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nAnd so, with the war finally over, they all went home and rested.',
    config: { maxFindings: 12 },
    severityDefault: 'low',
    series: {},
    planManuscriptChunks: async () => [overrides.manuscript ?? '# Issue 1\n\nThey all went home and rested.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped LLM pacing check reading manuscript + reader-map', () => {
    const check = getCheck(ENDINGS_CLIFF);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('pacing');
    expect(check.sources).toEqual(['manuscript', 'series.arc.readerMap']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(ENDINGS_CLIFF);
    expect(check.gate({ manuscript: '' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('passes the manuscript + authored cliffhangers and forces the pacing category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      series: { arc: { readerMap: { cliffhangers: [{ note: 'the door opens', atIssueBoundary: 1 }] } } },
      planManuscriptChunks: async (_stage, opts) => {
        // Authored cliffhangers ride alongside the manuscript as trimmable context (#1459).
        expect(opts.context).toHaveProperty('authoredCliffhangers');
        expect(opts.fixedOverheadTokens).toBeGreaterThan(0);
        return ['# Issue 1\n\nThe war ended and everyone went home.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return { content: { findings: [{ severity: 'medium', issueNumber: 1, location: 'Issue 1 — ending', problem: 'The chapter fully resolves', anchorQuote: 'went home' }] } };
      },
    });
    const findings = await getCheck(ENDINGS_CLIFF).run(ctx);
    expect(seenVars.manuscript).toBe('# Issue 1\n\nThe war ended and everyone went home.');
    expect(seenVars.authoredCliffhangers).toContain('the door opens');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('pacing');
    expect(findings[0].severity).toBe('medium');
  });

  it('passes an empty authoredCliffhangers var when the series has no reader-map', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(ENDINGS_CLIFF).run(ctx);
    expect(seenVars.authoredCliffhangers).toBe('');
  });

  it('marks a single-chunk run as the final part so the terminal-chapter exemption applies', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(ENDINGS_CLIFF).run(ctx);
    expect(seenVars.finalPart).toBe('true');
  });

  it('flags only the LAST part as final so an earlier chunk does not treat its last chapter as terminal (#1298)', async () => {
    const finals = [];
    const ctx = wholeCtx({
      planManuscriptChunks: async () => ['# Issue 1\n\npart one', '# Issue 2\n\npart two', '# Issue 3\n\npart three'],
      callStagedLLM: async (_stage, vars) => { finals.push(vars.finalPart); return { content: { findings: [] } }; },
    });
    await getCheck(ENDINGS_CLIFF).run(ctx);
    expect(finals).toEqual(['', '', 'true']);
  });
});

describe('authoredCliffhangerSummary (#1298)', () => {
  it('returns an empty string when there are no authored cliffhangers', () => {
    expect(authoredCliffhangerSummary(null)).toBe('');
    expect(authoredCliffhangerSummary({})).toBe('');
    expect(authoredCliffhangerSummary({ cliffhangers: [] })).toBe('');
  });

  it('renders cliffhangers as a bullet list with an ending-issue hint when present', () => {
    const out = authoredCliffhangerSummary({
      cliffhangers: [{ note: 'the door opens', atIssueBoundary: 2 }, { note: 'a scream cuts off' }],
    });
    expect(out).toContain('Authored cliffhangers');
    expect(out).toContain('- the door opens (ending issue 2)');
    // No boundary hint when atIssueBoundary is absent.
    expect(out).toContain('- a scream cuts off');
    expect(out).not.toContain('a scream cuts off (ending issue');
  });

  it('drops cliffhangers with no note', () => {
    expect(authoredCliffhangerSummary({ cliffhangers: [{ atIssueBoundary: 1 }, { note: '' }] })).toBe('');
  });
});

describe('endings.pov-switch — deterministic check (#1298)', () => {
  // scene helper: pov + the issue it belongs to (sequence-ordered by array order).
  const scene = (pov, issueNumber, over = {}) => ({
    heading: `${pov || 'no'}-pov scene`, issueNumber, anchorQuote: `q-${issueNumber}`, povCharacter: pov, ...over,
  });
  const runSwitch = (scenes, cliffhangers) =>
    getCheck(POV_SWITCH).run({
      reverseOutline: scenes,
      series: { arc: { readerMap: { cliffhangers } } },
      config: {},
      severityDefault: 'low',
    });

  it('declares reverseOutline + reader-map sources and is series-scoped deterministic', () => {
    const c = getCheck(POV_SWITCH);
    expect(c.scope).toBe('series');
    expect(c.kind).toBe('deterministic');
    expect(c.category).toBe('pacing');
    expect(c.sources).toEqual(['reverseOutline', 'series.arc.readerMap']);
  });

  it('gate requires a POV-tagged scene AND at least one authored cliffhanger', () => {
    const c = getCheck(POV_SWITCH);
    const scenes = [scene('Aria', 1), scene('Bram', 2)];
    expect(c.gate({ reverseOutline: scenes, series: { arc: { readerMap: { cliffhangers: [] } } } })).toBeFalsy();
    expect(c.gate({ reverseOutline: [scene('', 1)], series: { arc: { readerMap: { cliffhangers: [{ atIssueBoundary: 1 }] } } } })).toBe(false);
    expect(c.gate({ reverseOutline: scenes, series: { arc: { readerMap: { cliffhangers: [{ atIssueBoundary: 1 }] } } } })).toBeTruthy();
  });

  it('flags a cliffhanger whose next chapter keeps the same POV (multi-POV series)', () => {
    const scenes = [
      scene('Aria', 1), scene('Aria', 1), // issue 1 ends on Aria
      scene('Aria', 2),                    // issue 2 opens on Aria — no switch
      scene('Bram', 3),                    // a second POV makes the series multi-POV
    ];
    const findings = runSwitch(scenes, [{ note: 'the door opens', atIssueBoundary: 1 }]);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.category).toBe('pacing');
    expect(f.location).toBe('Issue 1 → Issue 2');
    expect(f.problem).toMatch(/same POV character \(Aria\)/);
    expect(f.problem).toMatch(/the door opens/);
    expect(f.issueNumber).toBe(2);
    expect(f.anchorQuote).toBe('q-2');
  });

  it('does not flag when the next chapter switches POV', () => {
    const scenes = [scene('Aria', 1), scene('Bram', 2)];
    expect(runSwitch(scenes, [{ atIssueBoundary: 1 }])).toEqual([]);
  });

  it('no-ops on a single-POV series even with an authored cliffhanger', () => {
    const scenes = [scene('Aria', 1), scene('Aria', 2)];
    expect(runSwitch(scenes, [{ atIssueBoundary: 1 }])).toEqual([]);
  });

  it('no-ops when no cliffhangers are authored', () => {
    const scenes = [scene('Aria', 1), scene('Aria', 2), scene('Bram', 3)];
    expect(runSwitch(scenes, [])).toEqual([]);
  });

  it('skips a cliffhanger on the last drafted chapter (nowhere to cut to)', () => {
    const scenes = [scene('Aria', 1), scene('Bram', 2)];
    // Boundary 2 is the final chapter — no next issue, so no finding.
    expect(runSwitch(scenes, [{ atIssueBoundary: 2 }])).toEqual([]);
  });

  it('skips a cliffhanger whose boundary matches no outlined issue', () => {
    const scenes = [scene('Aria', 1), scene('Aria', 2), scene('Bram', 3)];
    // No issue 7 in the outline — nothing to resolve, no finding.
    expect(runSwitch(scenes, [{ atIssueBoundary: 7 }])).toEqual([]);
  });

  it('does not flag across an undrafted gap (next outlined issue is not endIssue+1)', () => {
    // Issue 2 is undrafted/unsegmented: the outline jumps 1 → 3. A cliffhanger
    // ending issue 1 has no adjacent chapter to cut to, so it must NOT compare
    // issue 1's ending POV against issue 3's opening POV.
    const scenes = [scene('Aria', 1), scene('Aria', 3), scene('Bram', 4)];
    expect(runSwitch(scenes, [{ atIssueBoundary: 1 }])).toEqual([]);
  });

  it('emits one finding per ending issue even if multiple cliffhangers share the boundary', () => {
    const scenes = [scene('Aria', 1), scene('Aria', 2), scene('Bram', 3)];
    const findings = runSwitch(scenes, [
      { note: 'first', atIssueBoundary: 1 },
      { note: 'second', atIssueBoundary: 1 },
    ]);
    expect(findings).toHaveLength(1);
  });

  it('treats casing/spacing variants of the POV name as the same holder', () => {
    const scenes = [scene('Aria Vance', 1), scene('aria  vance', 2), scene('Bram', 3)];
    const findings = runSwitch(scenes, [{ atIssueBoundary: 1 }]);
    expect(findings).toHaveLength(1);
  });

  it('tolerates an empty / malformed outline', () => {
    expect(runSwitch([], [{ atIssueBoundary: 1 }])).toEqual([]);
    expect(runSwitch([null, 'x', {}], [{ atIssueBoundary: 1 }])).toEqual([]);
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

  it('compares aliases against other characters\' names', () => {
    const findings = run([
      { id: 'a', name: 'Alina', aliases: ['Lina'] },
      { id: 'b', name: 'Tina' },
    ]);
    // "Lina" (alias of Alina) vs "Tina" — same length, vowel pattern, ending, edit distance 1.
    const aliasFinding = findings.find((f) => f.problem.includes('Lina') && f.problem.includes('Tina'));
    expect(aliasFinding).toBeTruthy();
    expect(aliasFinding.problem).toMatch(/alias of Alina/);
  });

  it('does not pair a character\'s own name with its own alias', () => {
    const findings = run([{ id: 'a', name: 'Robert', aliases: ['Rupert'] }]);
    // Robert/Rupert share a phonetic key + signals, but they are the SAME character.
    expect(findings).toEqual([]);
  });

  it('steers the rename suggestion toward the unlocked character', () => {
    const findings = run([
      { id: 'a', name: 'Alina', locked: true },
      { id: 'b', name: 'Alana', locked: false },
    ]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].suggestion).toMatch(/Rename Alana/);
    expect(findings[0].suggestion).toMatch(/Alina is locked/);
  });

  it('notes when both confusable characters are locked', () => {
    const findings = run([
      { id: 'a', name: 'Alina', locked: true },
      { id: 'b', name: 'Alana', locked: true },
    ]);
    expect(findings[0].suggestion).toMatch(/both .*locked/i);
  });

  it('escalates severity for near-identical (edit-distance-1) names above the low floor', () => {
    const findings = run([{ name: 'Alina' }, { name: 'Alana' }]);
    expect(findings[0].severity).toBe('high'); // edit distance 1 → escalate 2 ranks from low
  });

  it('flags first-letter crowding scaled by cast size (4 of 6), not a sparse 2 of 30', () => {
    const crowded = run([
      { name: 'Sam' }, { name: 'Sid' }, { name: 'Sky' }, { name: 'Sue' },
      { name: 'Bree' }, { name: 'Tom' },
    ]);
    const cluster = crowded.find((f) => f.location.startsWith('Characters starting with'));
    expect(cluster).toBeTruthy();
    expect(cluster.problem).toMatch(/start with "S"/);
    expect(cluster.severity).toBe('high'); // 4/6 ≥ 0.5

    const sparse = run([
      { name: 'Mike' }, { name: 'Mark' },
      ...Array.from({ length: 28 }, (_, i) => ({ name: `${'abcdefghijklnopqrstuvwxyz'[i % 25]}ame${i}` })),
    ]);
    expect(sparse.find((f) => f.location.startsWith('Characters starting with'))).toBeFalsy();
  });

  it('flags exact normalized collisions between different characters at top severity', () => {
    const findings = run([
      { id: 'a', name: 'Anne-Marie' },
      { id: 'b', name: 'Anne Marie' },
    ]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].problem).toMatch(/identical once case and punctuation/);
    expect(findings[0].severity).toBe('high');
  });

  it('flags an alias that collides with another character\'s name', () => {
    const findings = run([
      { id: 'a', name: 'Robert', aliases: ['Bob'] },
      { id: 'b', name: 'Bob' },
    ]);
    const collision = findings.find((f) => f.problem.includes('identical once case and punctuation'));
    expect(collision).toBeTruthy();
    expect(collision.problem).toMatch(/alias of Robert/);
  });

  it('always flags a near-typo within minEditDistance even when minSharedSignals is high', () => {
    // Alina/Alana share ~5 signals; with minSharedSignals 7 the shared-signal gate
    // would drop them, but minEditDistance=1 is documented as "always flag".
    const findings = run([{ name: 'Alina' }, { name: 'Alana' }], { minSharedSignals: 7, minEditDistance: 1 });
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe('high');
    // Turning the edit-distance signal off (0) restores the pure shared-signal gate.
    expect(run([{ name: 'Alina' }, { name: 'Alana' }], { minSharedSignals: 7, minEditDistance: 0 })).toEqual([]);
  });

  it('disables first-letter crowding when the ratio is set to 0', () => {
    const findings = run(
      [{ name: 'Sam' }, { name: 'Sid' }, { name: 'Sky' }],
      { minSharedSignals: 2, maxShareFirstLetterRatio: 0 },
    );
    expect(findings.find((f) => f.location.startsWith('Characters starting with'))).toBeFalsy();
  });
});

describe('roster.economy — deterministic check', () => {
  const ROSTER = 'roster.economy';
  const sec = (number, content) => ({ number, content });
  const runRoster = (characters, sections, config = {}) =>
    getCheck(ROSTER).run({ canon: { characters }, sections, config, severityDefault: 'low' });
  const throwaways = (findings) => findings.filter((f) => /never recurs/.test(f.problem));
  const crowding = (findings) => findings.find((f) => f.location.endsWith('(opening)'));
  const pressure = (findings) => findings.find((f) => f.location === 'Series roster');

  it('declares the expected scope / kind / sources', () => {
    const c = getCheck(ROSTER);
    expect(c.kind).toBe('deterministic');
    expect(c.scope).toBe('series');
    expect(c.needsManuscript).toBe(true);
    expect(c.sources).toEqual(expect.arrayContaining(['manuscript', 'canon']));
  });

  it('flags a named character who appears in only one issue (throwaway)', () => {
    const findings = runRoster(
      [{ name: 'Aria' }, { name: 'Bram' }, { name: 'Cleo' }],
      [sec(1, 'Aria met Bram at dawn.'), sec(2, 'Aria walked on alone.')],
    );
    const tw = throwaways(findings);
    expect(tw).toHaveLength(1); // Bram (issue 1 only); Aria recurs; Cleo never appears
    expect(tw[0].category).toBe('casting');
    expect(tw[0].severity).toBe('low');
    expect(tw[0].issueNumber).toBe(1);
    expect(tw[0].problem).toMatch(/"Bram".*only 1 issue/);
    expect(tw[0].problem).toMatch(/never recurs/);
  });

  it('leaves a never-appearing canon character alone (may be undrafted)', () => {
    const findings = runRoster(
      [{ name: 'Ghost' }],
      [sec(1, 'Nobody named shows up here.')],
    );
    expect(throwaways(findings)).toEqual([]);
  });

  it('minAppearancesToWarn=1 disables the throwaway check', () => {
    const findings = runRoster(
      [{ name: 'Bram' }],
      [sec(1, 'Bram waved once.')],
      { minAppearancesToWarn: 1, maxCastPerIssue: 0, maxFirstIssueCharacters: 0 },
    );
    expect(findings).toEqual([]);
  });

  it('matches whole words only — a name is not a substring of a longer word', () => {
    // "Sam" must not match "Samuel" / "Samantha".
    const findings = runRoster(
      [{ name: 'Sam' }],
      [sec(1, 'Samuel and Samantha spoke.')],
    );
    expect(findings).toEqual([]); // 0 appearances → nothing to flag
  });

  it('matches names that end in punctuation as whole tokens (lookaround, not \\b)', () => {
    // A trailing \b can't match a token ending in "." — lookarounds handle any edge.
    const findings = runRoster(
      [{ name: 'J.R.' }, { name: 'Aria' }],
      [sec(1, 'J.R. arrived at dawn.'), sec(2, 'Aria mused; Aria left.')],
    );
    expect(throwaways(findings).some((f) => /"J\.R\."/.test(f.problem))).toBe(true);
  });

  it('counts appearances via aliases, anchoring on the matched alias not the canonical name', () => {
    const findings = runRoster(
      [{ name: 'Robert', aliases: ['Bob'] }, { name: 'Aria' }],
      [sec(1, 'Bob arrived.'), sec(2, 'Aria stayed; Aria thought of him.')],
    );
    // Robert appears only via "Bob" in issue 1 → throwaway named as Robert, but the
    // anchorQuote must be the prose token "Bob" so the editor's jump-to-highlight lands.
    const tw = throwaways(findings).find((f) => /"Robert"/.test(f.problem));
    expect(tw).toBeTruthy();
    expect(tw.anchorQuote).toBe('Bob');
  });

  it('words the throwaway finding for the recurrence threshold, not always "never recurs"', () => {
    // minAppearancesToWarn=3: a 2-issue character DOES recur but is under threshold.
    const findings = runRoster(
      [{ name: 'Bram' }, { name: 'Aria' }],
      [sec(1, 'Bram and Aria met.'), sec(2, 'Bram and Aria parted.'), sec(3, 'Aria went on.')],
      { minAppearancesToWarn: 3, maxFirstIssueCharacters: 0, maxCastPerIssue: 0 },
    );
    const f = findings.find((x) => /"Bram"/.test(x.problem)); // Bram in 1,2 (n=2); Aria in all 3
    expect(f).toBeTruthy();
    expect(f.problem).not.toMatch(/never recurs/);
    expect(f.problem).toMatch(/2 issues/);
    expect(f.problem).toMatch(/recurrence threshold/);
  });

  it('flags first-issue crowding and lists the introduced names', () => {
    const six = ['Ann', 'Bob', 'Cyd', 'Dan', 'Eve', 'Fox'].map((name) => ({ name }));
    const findings = runRoster(
      six,
      [sec(1, 'Ann, Bob, Cyd, Dan, Eve, and Fox all gathered.')],
      { minAppearancesToWarn: 1 }, // suppress throwaways to isolate crowding
    );
    const cr = crowding(findings);
    expect(cr).toBeTruthy();
    expect(cr.severity).toBe('low'); // 6 named, not ≥1.5× the default 5
    expect(cr.problem).toMatch(/6 named characters appear in the opening issue/);
    expect(cr.problem).toMatch(/Fox/);
    expect(cr.issueNumber).toBe(1);
  });

  it('escalates crowding to medium when well over the threshold', () => {
    const six = ['Ann', 'Bob', 'Cyd', 'Dan', 'Eve', 'Fox'].map((name) => ({ name }));
    const findings = runRoster(
      six,
      [sec(1, 'Ann, Bob, Cyd, Dan, Eve, and Fox all gathered.')],
      { minAppearancesToWarn: 1, maxFirstIssueCharacters: 2, maxCastPerIssue: 0 },
    );
    expect(crowding(findings).severity).toBe('medium'); // 6 ≥ ceil(2×1.5)=3
  });

  it('maxFirstIssueCharacters=0 disables the crowding check', () => {
    const six = ['Ann', 'Bob', 'Cyd', 'Dan', 'Eve', 'Fox'].map((name) => ({ name }));
    const findings = runRoster(
      six,
      [sec(1, 'Ann, Bob, Cyd, Dan, Eve, and Fox all gathered.')],
      { minAppearancesToWarn: 1, maxFirstIssueCharacters: 0, maxCastPerIssue: 0 },
    );
    expect(findings).toEqual([]);
  });

  it('flags roster-size pressure (advisory, whole-series)', () => {
    const findings = runRoster(
      [{ name: 'Ann' }, { name: 'Bob' }, { name: 'Cyd' }],
      [sec(1, 'Ann, Bob, and Cyd met.')],
      { minAppearancesToWarn: 1, maxFirstIssueCharacters: 0, maxCastPerIssue: 2 },
    );
    const pr = pressure(findings);
    expect(pr).toBeTruthy();
    expect(pr.severity).toBe('low');
    expect(pr.issueNumber).toBeNull();
    expect(pr.problem).toMatch(/3 named characters across 1 issue/);
  });

  it('scales throwaway severity up in a long story', () => {
    const sections = Array.from({ length: 8 }, (_, i) => sec(i + 1, i === 0 ? 'Aria meets Solo.' : 'Aria continues.'));
    const findings = runRoster([{ name: 'Aria' }, { name: 'Solo' }], sections);
    const tw = throwaways(findings);
    expect(tw).toHaveLength(1); // Solo appears in issue 1 only; Aria in all 8
    expect(tw[0].problem).toMatch(/"Solo"/);
    expect(tw[0].severity).toBe('medium'); // 8 sections → escalated above the low floor
  });

  it('tolerates empty canon / no sections', () => {
    expect(runRoster([], [])).toEqual([]);
    expect(runRoster([{}, { name: '' }], [sec(1, 'text')])).toEqual([]);
  });
});

describe('scene.component-balance — deterministic check', () => {
  const SCENE = 'scene.component-balance';
  const scene = (over = {}) => ({
    heading: 'A scene', issueNumber: 1, anchorQuote: 'q',
    components: { narrative: false, action: false, dialogue: false }, ...over,
  });
  const runScene = (scenes, config = {}) =>
    getCheck(SCENE).run({ reverseOutline: scenes, config, severityDefault: 'low' });

  it('declares the reverseOutline source and scene scope', () => {
    const c = getCheck(SCENE);
    expect(c.scope).toBe('scene');
    expect(c.kind).toBe('deterministic');
    expect(c.sources).toEqual(['reverseOutline']);
  });

  it('flags a single-mode scene and names the missing components', () => {
    const findings = runScene([
      scene({ heading: 'Talking heads', components: { narrative: false, action: false, dialogue: true } }),
    ]);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.category).toBe('pacing');
    expect(f.problem).toMatch(/all dialogue/);
    expect(f.problem).toMatch(/no narrative or action/);
    expect(f.anchorQuote).toBe('q');
    expect(f.issueNumber).toBe(1);
    expect(f.location).toBe('Issue 1: Talking heads');
  });

  it('passes a scene that mixes two components', () => {
    expect(runScene([scene({ components: { narrative: true, action: false, dialogue: true } })])).toEqual([]);
  });

  it('skips unclassified scenes (no component signal) rather than false-flagging', () => {
    const findings = runScene([
      scene({ components: { narrative: false, action: false, dialogue: false } }),
      scene({ components: {} }),
      scene({ components: undefined }),
    ]);
    expect(findings).toEqual([]);
  });

  it('minComponents=3 flags a two-component scene and names the one gap', () => {
    const findings = runScene(
      [scene({ heading: 'No voice', components: { narrative: true, action: true, dialogue: false } })],
      { minComponents: 3 },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toMatch(/narrative and action but no dialogue/);
  });

  it('tells a single-mode scene to add BOTH missing modes under minComponents=3', () => {
    // A single-mode scene under an all-three target must add both gaps, not "either".
    const findings = runScene(
      [scene({ heading: 'Monologue', components: { narrative: false, action: false, dialogue: true } })],
      { minComponents: 3 },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toMatch(/at least 3 of/);
    expect(findings[0].suggestion).toMatch(/Add narrative and action/); // "and", not "or"
  });

  it('tells a single-mode scene it may add EITHER missing mode under the default (2)', () => {
    const findings = runScene([scene({ components: { narrative: false, action: false, dialogue: true } })]);
    expect(findings[0].problem).toMatch(/at least 2 of/);
    expect(findings[0].suggestion).toMatch(/Add narrative or action/); // "or" — one suffices
  });

  it('minComponents=1 disables the check', () => {
    const findings = runScene(
      [scene({ components: { narrative: false, action: false, dialogue: true } })],
      { minComponents: 1 },
    );
    expect(findings).toEqual([]);
  });

  it('falls back to a Scene: label when issueNumber is absent', () => {
    const findings = runScene([scene({ heading: 'Loose scene', issueNumber: null, components: { narrative: true } })]);
    expect(findings[0].location).toBe('Scene: Loose scene');
    expect(findings[0].issueNumber).toBeNull();
  });

  it('tolerates an empty / malformed outline', () => {
    expect(runScene([])).toEqual([]);
    expect(runScene([null, 'x', {}])).toEqual([]);
  });

  it('does not throw on a non-string heading (peer-synced / malformed scene)', () => {
    const findings = runScene([{ heading: 123, sequence: 0, components: { dialogue: true } }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toBe('Scene: scene 1'); // falls back past the non-string heading
  });
});

describe('pov.justified — deterministic check', () => {
  const POV = 'pov.justified';
  const scene = (pov, over = {}) => ({
    heading: `${pov || 'no'}-pov scene`, issueNumber: 1, anchorQuote: 'q', povCharacter: pov, ...over,
  });
  const runPov = (scenes, { config = {}, arcs = [], arcsComplete = true } = {}) =>
    getCheck(POV).run({
      reverseOutline: scenes,
      editorialArcs: arcs,
      editorialArcsComplete: arcsComplete,
      config,
      severityDefault: 'low',
    });

  it('declares both reverseOutline and editorialArcs sources', () => {
    const c = getCheck(POV);
    expect(c.scope).toBe('series');
    expect(c.kind).toBe('deterministic');
    expect(c.sources).toEqual(['reverseOutline', 'editorialArcs']);
    expect(c.defaultEnabled).toBe(true);
  });

  it('gate requires at least one POV-tagged scene', () => {
    const c = getCheck(POV);
    expect(c.gate({ reverseOutline: [] })).toBe(false);
    expect(c.gate({ reverseOutline: [scene('')] })).toBe(false);
    expect(c.gate({ reverseOutline: [scene('Aria')] })).toBe(true);
  });

  it('flags a POV holder with no detected arc as unjustified (arc model present)', () => {
    const findings = runPov(
      [scene('Aria'), scene('Aria'), scene('Bram'), scene('Bram')],
      { arcs: [{ name: 'Aria', arcDirection: 'rising', issueCount: 2 }, { name: 'Bram', arcDirection: 'flat', issueCount: 2 }] },
    );
    // Bram holds POV but his arc is flat → "POV without arc". Aria is justified (rising).
    const unjustified = findings.filter((f) => /no detected character arc/.test(f.problem));
    expect(unjustified).toHaveLength(1);
    expect(unjustified[0].problem).toMatch(/"Bram"/);
    expect(unjustified[0].category).toBe('arc');
    expect(unjustified[0].location).toBe('Issue 1: Bram-pov scene');
    expect(unjustified[0].anchorQuote).toBe('q');
  });

  it('flags a POV holder absent from the detected arcs entirely', () => {
    const findings = runPov(
      [scene('Ghost'), scene('Ghost')],
      { config: { driveByMaxScenes: 0 }, arcs: [{ name: 'Aria', arcDirection: 'rising', issueCount: 2 }] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toMatch(/not present in the detected arcs/);
  });

  it('under incomplete/stale coverage, suppresses ALL no-arc findings (arc data is unreliable)', () => {
    // Partial or prose-staled analysis → a present "flat" reading may be outdated
    // and an absent holder may simply be unanalyzed. Neither is trustworthy, so the
    // no-arc check stays silent; only the structural drive-by check would run.
    const findings = runPov(
      [scene('Flat'), scene('Flat'), scene('Ghost'), scene('Ghost')],
      { config: { driveByMaxScenes: 0 }, arcs: [{ name: 'Flat', arcDirection: 'flat', issueCount: 2 }], arcsComplete: false },
    );
    expect(findings).toEqual([]);
  });

  it('once coverage is complete, both the present-flat and absent POV holders are flagged', () => {
    const findings = runPov(
      [scene('Flat'), scene('Flat'), scene('Ghost'), scene('Ghost')],
      { config: { driveByMaxScenes: 0 }, arcs: [{ name: 'Flat', arcDirection: 'flat', issueCount: 2 }], arcsComplete: true },
    );
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => /"Flat"/.test(f.problem)).problem).toMatch(/arc direction is flat/);
    expect(findings.find((f) => /"Ghost"/.test(f.problem)).problem).toMatch(/not present in the detected arcs/);
  });

  it('flags a drive-by (single-scene) POV via the inverse-imbalance check', () => {
    const findings = runPov(
      [scene('Aria'), scene('Aria'), scene('Cameo')],
      { arcs: [{ name: 'Aria', arcDirection: 'rising', issueCount: 2 }, { name: 'Cameo', arcDirection: 'rising', issueCount: 1 }] },
    );
    // Cameo has an arc (so not unjustified) but holds POV in only 1 scene → drive-by.
    const driveBy = findings.filter((f) => /drive-by viewpoint/.test(f.problem));
    expect(driveBy).toHaveLength(1);
    expect(driveBy[0].problem).toMatch(/"Cameo"/);
    expect(driveBy[0].problem).toMatch(/only 1 scene/);
  });

  it('degrades gracefully when analysis has not run: only the structural drive-by check runs', () => {
    // No arcs AND not complete (no analysis yet) → can't tell justified from not.
    const findings = runPov([scene('Aria'), scene('Aria'), scene('Solo')], { arcs: [], arcsComplete: false });
    expect(findings.every((f) => !/no detected character arc/.test(f.problem))).toBe(true);
    const driveBy = findings.filter((f) => /drive-by viewpoint/.test(f.problem));
    expect(driveBy).toHaveLength(1);
    expect(driveBy[0].problem).toMatch(/"Solo"/);
  });

  it('treats a complete-but-empty analysis as a usable model: every POV holder is flagged arc-less', () => {
    // Analysis completed and detected zero characters → every POV holder genuinely
    // has no arc, so the no-arc finding must still fire (not silently suppressed).
    const findings = runPov(
      [scene('Aria'), scene('Aria'), scene('Bram'), scene('Bram')],
      { config: { driveByMaxScenes: 0 }, arcs: [], arcsComplete: true },
    );
    const unjustified = findings.filter((f) => /not present in the detected arcs/.test(f.problem));
    expect(unjustified).toHaveLength(2);
    expect(unjustified.map((f) => f.problem).join(' ')).toMatch(/"Aria".*"Bram"|"Bram".*"Aria"/s);
  });

  it('stays silent on an empty analysis that is NOT complete (can\'t tell)', () => {
    // Zero arcs and incomplete → indistinguishable from "not analyzed yet".
    const findings = runPov(
      [scene('Aria'), scene('Aria')],
      { config: { driveByMaxScenes: 0 }, arcs: [], arcsComplete: false },
    );
    expect(findings).toEqual([]);
  });

  it('collapses casing/spacing variants of a POV name into one holder', () => {
    const findings = runPov(
      [scene('Aria'), scene('  aria '), scene('ARIA')],
      { config: { driveByMaxScenes: 0 }, arcs: [{ name: 'aria', arcDirection: 'flat', issueCount: 3 }] },
    );
    // One holder (3 scenes), flat arc → exactly one unjustified finding, not three.
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toMatch(/holds POV in 3 scenes/);
  });

  it('driveByMaxScenes=0 disables the drive-by check; flagUnjustifiedPov=false disables the arc check', () => {
    const scenes = [scene('Solo')];
    const arcs = [{ name: 'Solo', arcDirection: 'flat', issueCount: 1 }];
    expect(runPov(scenes, { config: { driveByMaxScenes: 0, flagUnjustifiedPov: false }, arcs })).toEqual([]);
  });

  it('tolerates an empty / malformed outline', () => {
    expect(runPov([])).toEqual([]);
    expect(runPov([null, 'x', {}, scene('')])).toEqual([]);
  });

  it('falls back to a POV: label when issueNumber is absent', () => {
    const findings = runPov(
      [scene('Aria', { issueNumber: null })],
      { config: { driveByMaxScenes: 1, flagUnjustifiedPov: false } },
    );
    expect(findings[0].location).toBe('POV: Aria');
    expect(findings[0].issueNumber).toBeNull();
  });
});

describe('pov.economy — deterministic check (#1620)', () => {
  const POV = 'pov.economy';
  // Build a scene for a POV holder in a given issue. `seq` keeps first-appearance
  // order stable; `anchorQuote` lets the late-intro anchor assertion bite.
  const scene = (pov, issueNumber, over = {}) => ({
    heading: `${pov}-pov i${issueNumber}`, issueNumber, sequence: 0, anchorQuote: 'q', povCharacter: pov, ...over,
  });
  // Distinct alphabetic names — `normalizeName` strips digits, so "P1".."P8" would
  // all collapse to one holder. Real viewpoint rosters use names, so the fixtures do too.
  const NAMES = ['Aria', 'Bram', 'Cael', 'Dara', 'Enzo', 'Faye', 'Gwen', 'Hugo', 'Ivy', 'Jonas', 'Kira', 'Liam'];
  // N POV holders, one scene each, spread one-per-issue across issues 1..issueCount.
  const roster = (povCount, issueCount) => {
    const out = [];
    for (let i = 0; i < issueCount; i += 1) {
      // Only the first `povCount` holders are distinct viewpoints; the rest reuse
      // NAMES[0] so issue count grows without adding POVs.
      out.push(scene(i < povCount ? NAMES[i] : NAMES[0], i + 1));
    }
    return out;
  };
  const runEcon = (scenes, config = {}) =>
    getCheck(POV).run({ reverseOutline: scenes, config, severityDefault: 'low' });

  it('declares reverseOutline as its only source and is a series-scope deterministic check', () => {
    const c = getCheck(POV);
    expect(c.scope).toBe('series');
    expect(c.kind).toBe('deterministic');
    expect(c.sources).toEqual(['reverseOutline']);
    expect(c.defaultEnabled).toBe(true);
    // Must NOT pull in the manuscript corpus — purely structural over the outline.
    expect(c.sources).not.toContain('manuscript');
  });

  it('gate requires at least one POV-tagged scene', () => {
    const c = getCheck(POV);
    expect(c.gate({ reverseOutline: [] })).toBe(false);
    expect(c.gate({ reverseOutline: [scene('', 1)] })).toBe(false);
    expect(c.gate({ reverseOutline: [scene('Aria', 1)] })).toBe(true);
  });

  it('flags too many POVs for the run length (8 across 12 issues)', () => {
    const findings = runEcon(roster(8, 12));
    const crowded = findings.filter((f) => /more viewpoints than the run length/.test(f.problem));
    expect(crowded).toHaveLength(1);
    expect(crowded[0].location).toBe('Series');
    expect(crowded[0].category).toBe('arc');
    expect(crowded[0].severity).toBe('low');
    // 12 * 0.5 = budget 6, so 8 POVs > 6.
    expect(crowded[0].problem).toMatch(/8 POV characters across 12 issues/);
    expect(crowded[0].problem).toMatch(/supports about 6/);
  });

  it('does NOT flag a roster that fits the run length (6 across 12 issues)', () => {
    const findings = runEcon(roster(6, 12));
    expect(findings.filter((f) => /more viewpoints than the run length/.test(f.problem))).toHaveLength(0);
  });

  it('never flags 1–2 POVs as a crowd even at a high ratio (2 across 3 issues)', () => {
    // 2/3 shares the same 0.67 ratio as 8/12, but two viewpoints is not a crowd —
    // the absolute floor (3) suppresses it.
    const findings = runEcon([scene('A', 1), scene('B', 2), scene('A', 3)]);
    expect(findings.filter((f) => /more viewpoints than the run length/.test(f.problem))).toHaveLength(0);
  });

  it('skips the economy verdict for a run shorter than minIssues', () => {
    // 4 POVs but only 2 issues (< default minIssues 3) → no count finding.
    const findings = runEcon([scene('A', 1), scene('B', 1), scene('C', 2), scene('D', 2)]);
    expect(findings.filter((f) => /more viewpoints than the run length/.test(f.problem))).toHaveLength(0);
  });

  it('respects a custom maxPovPerIssue (ensemble tuning suppresses the crowd flag)', () => {
    // 8/12 trips at the 0.5 default but not at 1.0 (budget 12).
    expect(runEcon(roster(8, 12), { maxPovPerIssue: 1.0 })
      .filter((f) => /more viewpoints than the run length/.test(f.problem))).toHaveLength(0);
  });

  it('flags a late-introduced, underdeveloped POV (first appears in issue 11 of 12)', () => {
    // A 12-issue run carried by P1, plus a drive-by viewpoint that first shows up
    // in issue 11 with a single scene.
    const scenes = [];
    for (let i = 1; i <= 12; i += 1) scenes.push(scene('Lead', i));
    scenes.push(scene('Latecomer', 11));
    const findings = runEcon(scenes);
    const late = findings.filter((f) => /introduced too late to develop/.test(f.problem));
    expect(late).toHaveLength(1);
    expect(late[0].problem).toMatch(/"Latecomer" first takes the viewpoint in issue 11 of 1–12/);
    expect(late[0].issueNumber).toBe(11);
    expect(late[0].location).toBe('Issue 11: Latecomer-pov i11');
    expect(late[0].anchorQuote).toBe('q');
  });

  it('does NOT flag a late POV that is well developed (above the underdevelopment threshold)', () => {
    const scenes = [];
    for (let i = 1; i <= 12; i += 1) scenes.push(scene('Lead', i));
    // Latecomer first appears late but holds 3 scenes (> lateIntroMaxScenes 2).
    scenes.push(scene('Latecomer', 11));
    scenes.push(scene('Latecomer', 11, { heading: 'Latecomer-pov i11b' }));
    scenes.push(scene('Latecomer', 12));
    const findings = runEcon(scenes);
    expect(findings.filter((f) => /introduced too late to develop/.test(f.problem))).toHaveLength(0);
  });

  it('does NOT flag an early POV introduced before the late-intro window', () => {
    const scenes = [];
    for (let i = 1; i <= 12; i += 1) scenes.push(scene('Lead', i));
    // First appears in issue 8 of 12 → position (8-1)/11 = 0.64 < 0.8.
    scenes.push(scene('Earlybird', 8));
    const findings = runEcon(scenes);
    expect(findings.filter((f) => /introduced too late to develop/.test(f.problem))).toHaveLength(0);
  });

  it('lateIntroMaxScenes=0 disables the late-introduction check', () => {
    const scenes = [];
    for (let i = 1; i <= 12; i += 1) scenes.push(scene('Lead', i));
    scenes.push(scene('Latecomer', 11));
    expect(runEcon(scenes, { lateIntroMaxScenes: 0 })
      .filter((f) => /introduced too late to develop/.test(f.problem))).toHaveLength(0);
  });

  it('stays silent on both signals when the outline carries no issue numbers', () => {
    // No issue length to judge against → neither count nor timing can fire.
    const scenes = NAMES.slice(0, 8).map((n) => scene(n, null));
    expect(runEcon(scenes)).toEqual([]);
  });

  it('collapses casing/spacing variants of a POV name into one holder', () => {
    // Three spellings of one viewpoint across a 12-issue run → one holder, not three.
    const scenes = [];
    for (let i = 1; i <= 12; i += 1) scenes.push(scene('Lead', i));
    scenes.push(scene('Aria', 2));
    scenes.push(scene('  aria ', 5));
    scenes.push(scene('ARIA', 9));
    const findings = runEcon(scenes);
    // 2 holders (Lead, Aria) over 12 issues → under budget 6, no crowd finding.
    expect(findings.filter((f) => /more viewpoints than the run length/.test(f.problem))).toHaveLength(0);
  });

  it('tolerates an empty / malformed outline', () => {
    expect(runEcon([])).toEqual([]);
    expect(runEcon([null, 'x', {}, scene('', 1)])).toEqual([]);
  });
});

describe('arc.transitions — LLM check (#1293)', () => {
  const ARC = 'arc.transitions';
  const baseCtx = (overrides = {}) => ({
    manuscript: 'Mara stared at the bridge, then struck the match.',
    series: { characterArcs: [] },
    reverseOutline: [],
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    planManuscriptChunks: async () => [overrides.manuscript ?? 'Mara stared at the bridge, then struck the match.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('emits arc-category transition findings from the model', async () => {
    const ctx = baseCtx({
      callStagedLLM: async (_stage, vars) => {
        // The check ships the manuscript plus its two context blocks.
        expect(vars).toHaveProperty('manuscript');
        expect(vars).toHaveProperty('sceneMap');
        expect(vars).toHaveProperty('characterArcs');
        return { content: { findings: [{ severity: 'high', issueNumber: 4, problem: 'Mara crosses the point of no return', anchorQuote: 'struck the match' }] } };
      },
    });
    const findings = await getCheck(ARC).run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('arc');
    expect(findings[0].issueNumber).toBe(4);
  });

  it('renders the authored character arcs into the prompt vars', async () => {
    let capturedArcs = null;
    const ctx = baseCtx({
      series: {
        characterArcs: [
          { characterName: 'Mara', want: 'revenge', transitions: [{ kind: 'sacrifice', label: 'spares the killer', atIssue: 6 }] },
        ],
      },
      callStagedLLM: async (_stage, vars) => {
        capturedArcs = vars.characterArcs;
        return { content: { findings: [] } };
      },
    });
    await getCheck(ARC).run(ctx);
    expect(capturedArcs).toContain('- Mara');
    expect(capturedArcs).toContain('wants: revenge');
    expect(capturedArcs).toContain('sacrifice (issue 6): spares the killer');
  });

  it('passes a scene map built from the reverse outline as context', async () => {
    let capturedSceneMap = null;
    const ctx = baseCtx({
      reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'The bridge', setting: 'a rope bridge', charactersPresent: ['Mara'] }],
      callStagedLLM: async (_stage, vars) => {
        capturedSceneMap = vars.sceneMap;
        return { content: { findings: [] } };
      },
    });
    await getCheck(ARC).run(ctx);
    expect(capturedSceneMap).toContain('The bridge');
    expect(capturedSceneMap).toContain('present: Mara');
  });

  it('is gated off when the manuscript is empty', () => {
    expect(getCheck(ARC).gate({ manuscript: '   ' })).toBe(false);
    expect(getCheck(ARC).gate({ manuscript: 'real prose' })).toBe(true);
  });

  it('degrades gracefully when no authored arcs or outline exist', async () => {
    const ctx = baseCtx({
      series: {},
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => {
        expect(vars.characterArcs).toBe('');
        expect(vars.sceneMap).toBe('');
        return { content: { findings: [] } };
      },
    });
    const findings = await getCheck(ARC).run(ctx);
    expect(findings).toEqual([]);
  });
});

describe('arc.regression — LLM check (#1619)', () => {
  const REG = 'arc.regression';
  const baseCtx = (overrides = {}) => ({
    manuscript: '# Issue 1\n\nMara vowed to change, and for a while she did.',
    series: { characterArcs: [] },
    reverseOutline: [],
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    planManuscriptChunks: async () => [overrides.manuscript ?? '# Issue 1\n\nMara vowed to change.'],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as a series-scoped arc LLM check reading manuscript + outline + characterArcs', () => {
    const check = getCheck(REG);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('series');
    expect(check.category).toBe('arc');
    expect(check.sources).toEqual(['manuscript', 'reverseOutline', 'series.characterArcs']);
    expect(check.needsManuscript).toBe(true);
  });

  it('only runs when there is drafted prose to scan', () => {
    const check = getCheck(REG);
    expect(check.gate({ manuscript: '   ' })).toBe(false);
    expect(check.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
  });

  it('emits arc-category findings and ships the manuscript + both context blocks', async () => {
    const ctx = baseCtx({
      callStagedLLM: async (_stage, vars) => {
        expect(vars).toHaveProperty('manuscript');
        expect(vars).toHaveProperty('sceneMap');
        expect(vars).toHaveProperty('characterArcs');
        return { content: { findings: [{ severity: 'high', issueNumber: 3, location: 'Mara — premature closure', problem: 'Her arc resolves in issue 3 then goes flat' }] } };
      },
    });
    const findings = await getCheck(REG).run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('arc');
    expect(findings[0].location).toBe('Mara — premature closure');
  });

  it('renders the authored character arcs into the prompt vars', async () => {
    let capturedArcs = null;
    const ctx = baseCtx({
      series: {
        characterArcs: [
          { characterName: 'Mara', want: 'revenge', transitions: [{ kind: 'sacrifice', label: 'spares the killer', atIssue: 6 }] },
        ],
      },
      callStagedLLM: async (_stage, vars) => { capturedArcs = vars.characterArcs; return { content: { findings: [] } }; },
    });
    await getCheck(REG).run(ctx);
    expect(capturedArcs).toContain('- Mara');
    expect(capturedArcs).toContain('wants: revenge');
  });

  it('degrades gracefully when no authored arcs or outline exist', async () => {
    const ctx = baseCtx({
      series: {},
      reverseOutline: undefined,
      callStagedLLM: async (_stage, vars) => {
        expect(vars.characterArcs).toBe('');
        expect(vars.sceneMap).toBe('');
        return { content: { findings: [] } };
      },
    });
    const findings = await getCheck(REG).run(ctx);
    expect(findings).toEqual([]);
  });

  it('marks a single-chunk run as the final part so whole-arc verdicts are enabled', async () => {
    let seenVars = null;
    const ctx = baseCtx({
      callStagedLLM: async (_stage, vars) => { seenVars = vars; return { content: { findings: [] } }; },
    });
    await getCheck(REG).run(ctx);
    expect(seenVars.finalPart).toBe('true');
  });

  it('flags only the LAST part as final across a chunked manuscript', async () => {
    const finals = [];
    const ctx = baseCtx({
      planManuscriptChunks: async () => ['# Issue 1\n\np1', '# Issue 2\n\np2', '# Issue 3\n\np3'],
      callStagedLLM: async (_stage, vars) => { finals.push(vars.finalPart); return { content: { findings: [] } }; },
    });
    await getCheck(REG).run(ctx);
    expect(finals).toEqual(['', '', 'true']);
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

describe('arc.ticking-clock-hygiene — deterministic advisory', () => {
  const CLOCK = 'arc.ticking-clock-hygiene';
  const run = (tickingClock, config = { minReminders: 1 }) =>
    getCheck(CLOCK).run({ series: { arc: { tickingClock } }, config, severityDefault: 'low' });
  const check = getCheck(CLOCK);
  const gate = (tickingClock) => check.gate({ series: { arc: { tickingClock } } });

  it('gate fires only for an enabled clock', () => {
    expect(gate(undefined)).toBe(false);
    expect(gate({ enabled: false, label: 'x' })).toBe(false);
    expect(gate({ enabled: true })).toBe(true);
  });

  it('returns nothing for a fully-specified clock', () => {
    const findings = run({
      enabled: true,
      label: 'The storm makes landfall',
      kind: 'event',
      plantedAtArcPosition: 1,
      dueAtArcPosition: 8,
      stakes: 'The town floods.',
      reminders: [{ id: 'rm-1', atIssue: 4, note: 'barometer drops' }],
    });
    expect(findings).toEqual([]);
  });

  it('flags an enabled clock missing name, stakes, plant, due, and reminders', () => {
    const findings = run({ enabled: true });
    const problems = findings.map((f) => f.problem).join(' | ');
    expect(problems).toMatch(/unnamed/i);
    expect(problems).toMatch(/no stakes/i);
    expect(problems).toMatch(/no plant position/i);
    expect(problems).toMatch(/no due position/i);
    expect(problems).toMatch(/reminder beat/i);
    for (const f of findings) {
      expect(f.category).toBe('arc');
      expect(f.severity).toBe('low');
    }
  });

  it('flags a due position at or before the plant position', () => {
    const findings = run({
      enabled: true, label: 'x', stakes: 's',
      plantedAtArcPosition: 5, dueAtArcPosition: 5,
      reminders: [{ id: 'rm-1', note: 'tick' }],
    });
    expect(findings.some((f) => /at or before it is planted/i.test(f.problem))).toBe(true);
  });

  it('respects minReminders: 0 (skips the reminder-count finding)', () => {
    const findings = run(
      { enabled: true, label: 'x', stakes: 's', plantedAtArcPosition: 1, dueAtArcPosition: 4 },
      { minReminders: 0 },
    );
    expect(findings.some((f) => /reminder beat/i.test(f.problem))).toBe(false);
  });

  it('is enabled by default', () => {
    expect(getCheck(CLOCK).defaultEnabled).toBe(true);
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
  const baseCtx = (overrides = {}) => {
    const manuscript = overrides.manuscript ?? 'She clutched the watch as if it meant everything.';
    return {
      manuscript,
      canon: {
        objects: [{ id: 'o1', name: 'Watch', significance: 'heirloom', attachments: [{ characterId: 'c1', emotion: 'grief' }] }],
        characters: [{ id: 'c1', name: 'Mara' }],
      },
      config: { maxFindings: 12 },
      severityDefault: 'low',
      // Default chunker: a single whole-corpus chunk.
      planManuscriptChunks: async () => [manuscript],
      callStagedLLM: async () => ({ content: { findings: [] } }),
      ...overrides,
    };
  };

  it('passes the manuscript AND an objects-attachment summary to the model', async () => {
    let vars = null;
    await getCheck('objects.unmotivated-interaction').run(baseCtx({
      callStagedLLM: async (_stage, v) => { vars = v; return { content: { findings: [] } }; },
    }));
    expect(vars.manuscript).toContain('clutched the watch');
    expect(vars.objects).toContain('Watch');
    expect(vars.objects).toContain('Mara'); // resolved character name, not the id
  });

  it('budgets the objects summary as prompt overhead and re-sends it on every chunk', async () => {
    let sawObjectsContext = false;
    const objectsSeen = [];
    await getCheck('objects.unmotivated-interaction').run(baseCtx({
      planManuscriptChunks: async (_stage, opts) => { sawObjectsContext = Object.prototype.hasOwnProperty.call(opts.context || {}, 'objects'); return ['chunk a', 'chunk b']; },
      callStagedLLM: async (_stage, v) => { objectsSeen.push(v.objects); return { content: { findings: [] } }; },
    }));
    // The objects summary is passed as trimmable context (#1459), re-sent per chunk.
    expect(sawObjectsContext).toBe(true);
    // The objects summary rides every chunk (it's not part of the chunked manuscript).
    expect(objectsSeen).toHaveLength(2);
    expect(objectsSeen.every((o) => o.includes('Watch'))).toBe(true);
  });

  it('shapes findings into the continuity category and respects maxFindings', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ severity: 'low', problem: `p${i}`, anchorQuote: `a${i}` }));
    const findings = await getCheck('objects.unmotivated-interaction').run(baseCtx({
      config: { maxFindings: 4 },
      callStagedLLM: async () => ({ content: { findings: many } }),
    }));
    expect(findings).toHaveLength(4);
    expect(findings.every((f) => f.category === 'continuity')).toBe(true);
  });

  it('gates off when the manuscript is empty', () => {
    expect(getCheck('objects.unmotivated-interaction').gate(baseCtx({ manuscript: '   ' }))).toBe(false);
  });
});

describe('objects.weight-proportionality — LLM check (#1624)', () => {
  const baseCtx = (overrides = {}) => {
    const manuscript = overrides.manuscript ?? 'The locket — three generations of her line had guarded it — caught the light, then she pocketed it and forgot it.';
    return {
      manuscript,
      canon: {
        objects: [{ id: 'o1', name: 'Locket', significance: 'an ancestral heirloom', attachments: [{ characterId: 'c1', emotion: 'reverence', origin: 'pried from her grandmother\'s coffin', role: 'talisman' }] }],
        characters: [{ id: 'c1', name: 'Mara' }],
      },
      config: { maxFindings: 12 },
      severityDefault: 'low',
      // Default chunker: a single whole-corpus chunk.
      planManuscriptChunks: async () => [manuscript],
      callStagedLLM: async () => ({ content: { findings: [] } }),
      ...overrides,
    };
  };

  it('passes the manuscript AND the full per-object weight summary (incl. origin lineage + role) to the model', async () => {
    let vars = null;
    await getCheck('objects.weight-proportionality').run(baseCtx({
      callStagedLLM: async (_stage, v) => { vars = v; return { content: { findings: [] } }; },
    }));
    expect(vars.manuscript).toContain('locket');
    expect(vars.objects).toContain('Locket');
    expect(vars.objects).toContain('Mara'); // resolved character name, not the id
    // The recorded lineage/backstory the over-weighted verdict depends on (#1624 review):
    expect(vars.objects).toContain('pried from her grandmother'); // attachment origin
    expect(vars.objects).toContain('talisman'); // attachment role archetype
  });

  it('budgets the objects summary as prompt overhead and re-sends it on every chunk', async () => {
    let sawObjectsContext = false;
    const objectsSeen = [];
    await getCheck('objects.weight-proportionality').run(baseCtx({
      planManuscriptChunks: async (_stage, opts) => { sawObjectsContext = Object.prototype.hasOwnProperty.call(opts.context || {}, 'objects'); return ['chunk a', 'chunk b']; },
      callStagedLLM: async (_stage, v) => { objectsSeen.push(v.objects); return { content: { findings: [] } }; },
    }));
    expect(sawObjectsContext).toBe(true);
    expect(objectsSeen).toHaveLength(2);
    expect(objectsSeen.every((o) => o.includes('Locket'))).toBe(true);
  });

  it('shapes findings into the plot category and respects maxFindings', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ severity: 'low', problem: `p${i}`, anchorQuote: `a${i}` }));
    const findings = await getCheck('objects.weight-proportionality').run(baseCtx({
      config: { maxFindings: 4 },
      callStagedLLM: async () => ({ content: { findings: many } }),
    }));
    expect(findings).toHaveLength(4);
    expect(findings.every((f) => f.category === 'plot')).toBe(true);
  });

  it('keeps a model-supplied issue number (manuscript-scoped findings)', async () => {
    const findings = await getCheck('objects.weight-proportionality').run(baseCtx({
      callStagedLLM: async () => ({ content: { findings: [{ severity: 'medium', issueNumber: 7, problem: 'climactic relic, no setup', anchorQuote: 'the relic' }] } }),
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].issueNumber).toBe(7);
  });

  it('gates off when the manuscript is empty', () => {
    expect(getCheck('objects.weight-proportionality').gate(baseCtx({ manuscript: '   ' }))).toBe(false);
  });
});

describe('cross-chunk continuity digest (#1383)', () => {
  describe('editorialPriorFindingsDigest formatter', () => {
    it('returns empty string for no / non-array findings', () => {
      expect(editorialPriorFindingsDigest([])).toBe('');
      expect(editorialPriorFindingsDigest(null)).toBe('');
      expect(editorialPriorFindingsDigest(undefined)).toBe('');
    });

    it('lists prior findings by issue (or location) + category + problem under a header', () => {
      const digest = editorialPriorFindingsDigest([
        { issueNumber: 1, category: 'style', problem: 'past tense established' },
        { location: 'Prologue', category: 'continuity', problem: 'watch introduced' },
      ]);
      expect(digest).toMatch(/EARLIER parts of this manuscript/);
      expect(digest).toContain('- [Issue 1] style: past tense established');
      expect(digest).toContain('- [Prologue] continuity: watch introduced');
      expect(digest.endsWith('---\n\n')).toBe(true);
    });

    it('caps the listed findings and notes how many more were omitted', () => {
      const many = Array.from({ length: EDITORIAL_PRIOR_DIGEST_MAX + 5 }, (_, i) => ({
        issueNumber: i + 1, category: 'style', problem: `p${i}`,
      }));
      const digest = editorialPriorFindingsDigest(many);
      expect(digest).toMatch(/\(\+5 more earlier findings\)/);
    });

    it('caps the whole digest to EDITORIAL_PRIOR_DIGEST_CHARS so it stays within the safety margin', () => {
      const huge = Array.from({ length: EDITORIAL_PRIOR_DIGEST_MAX }, (_, i) => ({
        issueNumber: i + 1, category: 'continuity', problem: 'x'.repeat(500),
      }));
      const digest = editorialPriorFindingsDigest(huge);
      expect(digest.length).toBeLessThanOrEqual(EDITORIAL_PRIOR_DIGEST_CHARS);
    });

    it('keeps the trailing --- separator intact even when the body overflows the cap', () => {
      // The next manuscript chunk is concatenated right after the digest, so the
      // delimiter must survive truncation or the manuscript bleeds into the
      // "already recorded" list (codex P2).
      const huge = Array.from({ length: EDITORIAL_PRIOR_DIGEST_MAX }, (_, i) => ({
        issueNumber: i + 1, category: 'continuity', problem: 'x'.repeat(500),
      }));
      const digest = editorialPriorFindingsDigest(huge);
      expect(digest.endsWith('\n\n---\n\n')).toBe(true);
      expect(digest.startsWith('# Editorial findings already recorded')).toBe(true);
      // A following chunk stays clearly separated from the digest body.
      expect(`${digest}NEXT_CHUNK`).toContain('---\n\nNEXT_CHUNK');
    });
  });

  // A check that opts into the digest prefixes every chunk AFTER the first with a
  // digest of the findings gathered so far, riding inside the manuscript var.
  const runTwoChunks = async (checkId, ctxExtras) => {
    const seen = [];
    let overhead = null;
    await getCheck(checkId).run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      // No usableChars on the returned array → unbounded headroom, so the digest
      // always fits (the fits-in-budget gate is exercised separately below).
      planManuscriptChunks: async (_stage, opts) => {
        // A context-based check (#1459) passes { context, fixedOverheadTokens }; a
        // legacy plain-scan check passes { overheadTokens }. Capture whichever is set.
        overhead = opts.context ? opts.fixedOverheadTokens : opts.overheadTokens;
        return ['CHUNK_ONE', 'CHUNK_TWO'];
      },
      callStagedLLM: async (_stage, vars) => {
        seen.push(vars.manuscript);
        // Only the first chunk surfaces a finding, so the digest fed to chunk two
        // carries exactly that one.
        const findings = seen.length === 1
          ? [{ severity: 'high', issueNumber: 1, problem: 'tense slip in chapter one', anchorQuote: 'I walk' }]
          : [];
        return { content: { findings } };
      },
      ...ctxExtras,
    });
    return { seen, overhead };
  };

  it('style.conformance feeds the prior-chunk digest to later chunks', async () => {
    const { seen, overhead } = await runTwoChunks('style.conformance', {
      series: { styleGuide: { tense: 'past', povPerson: 'first' } },
    });
    // First chunk is untouched (no prior findings yet).
    expect(seen[0]).toBe('CHUNK_ONE');
    // Second chunk is prefixed with the digest of chunk one's finding, then its text.
    expect(seen[1]).toContain('EARLIER parts of this manuscript');
    expect(seen[1]).toContain('tense slip in chapter one');
    expect(seen[1].endsWith('CHUNK_TWO')).toBe(true);
    // The style-guide expectations are budgeted as prompt overhead.
    expect(overhead).toBeGreaterThan(0);
  });

  it('skips the digest (sends the manuscript whole) when it would not fit the chunk budget', async () => {
    const seen = [];
    // usableChars is just barely above the chunk text, so the (larger) digest can't
    // fit — manuscript coverage must win, so the chunk is sent without a digest.
    await getCheck('style.conformance').run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      series: { styleGuide: { tense: 'past', povPerson: 'first' } },
      planManuscriptChunks: async () => {
        const chunks = ['CHUNK_ONE', 'CHUNK_TWO'];
        chunks.usableChars = 'CHUNK_TWO'.length; // no spare room for any digest
        return chunks;
      },
      callStagedLLM: async (_stage, vars) => {
        seen.push(vars.manuscript);
        const findings = seen.length === 1
          ? [{ severity: 'high', issueNumber: 1, problem: 'tense slip', anchorQuote: 'q' }]
          : [];
        return { content: { findings } };
      },
    });
    // Even though chunk one produced a finding, the tight budget means chunk two is
    // sent verbatim — no digest, no dropped manuscript text.
    expect(seen[1]).toBe('CHUNK_TWO');
    expect(seen[1]).not.toContain('EARLIER parts of this manuscript');
  });

  it('objects.unmotivated-interaction feeds the prior-chunk digest to later chunks', async () => {
    const { seen } = await runTwoChunks('objects.unmotivated-interaction', {
      canon: {
        objects: [{ id: 'o1', name: 'Watch', attachments: [{ characterId: 'c1', emotion: 'grief' }] }],
        characters: [{ id: 'c1', name: 'Mara' }],
      },
    });
    expect(seen[0]).toBe('CHUNK_ONE');
    expect(seen[1]).toContain('EARLIER parts of this manuscript');
    expect(seen[1].endsWith('CHUNK_TWO')).toBe(true);
  });

  it('objects.weight-proportionality feeds the prior-chunk digest to later chunks and gates finalPart to the last chunk', async () => {
    const seen = [];
    const finalFlags = [];
    await getCheck('objects.weight-proportionality').run({
      config: { maxFindings: 12 },
      severityDefault: 'low',
      canon: {
        objects: [{ id: 'o1', name: 'Locket', significance: 'an ancestral heirloom', attachments: [{ characterId: 'c1', emotion: 'reverence' }] }],
        characters: [{ id: 'c1', name: 'Mara' }],
      },
      planManuscriptChunks: async () => ['CHUNK_ONE', 'CHUNK_TWO'],
      callStagedLLM: async (_stage, vars) => {
        seen.push(vars.manuscript);
        finalFlags.push(vars.finalPart);
        // Only the first chunk surfaces a finding, so the digest fed to chunk two carries it.
        const findings = seen.length === 1
          ? [{ severity: 'low', issueNumber: 1, problem: 'locket over-weighted', anchorQuote: 'the locket' }]
          : [];
        return { content: { findings } };
      },
    });
    expect(seen[0]).toBe('CHUNK_ONE');
    expect(seen[1]).toContain('EARLIER parts of this manuscript');
    expect(seen[1].endsWith('CHUNK_TWO')).toBe(true);
    // The whole-corpus verdict is gated: only the FINAL chunk is flagged finalPart.
    expect(finalFlags).toEqual(['', 'true']);
  });

  it('prose.info-dumping stays per-chunk — no digest is prepended (its problems are localized)', async () => {
    const { seen } = await runTwoChunks(INFODUMP, {
      manuscript: 'CHUNK_ONE',
    });
    expect(seen[0]).toBe('CHUNK_ONE');
    // Second chunk is the raw text — no continuity digest even though chunk one
    // produced a finding.
    expect(seen[1]).toBe('CHUNK_TWO');
    expect(seen[1]).not.toContain('EARLIER parts of this manuscript');
  });
});

describe('cross-chunk clean-setup digest (#1403)', () => {
  describe('editorialSetupDigest formatter', () => {
    it('returns empty string for empty / non-string summaries', () => {
      expect(editorialSetupDigest('')).toBe('');
      expect(editorialSetupDigest('   ')).toBe('');
      expect(editorialSetupDigest(null)).toBe('');
      expect(editorialSetupDigest(undefined)).toBe('');
    });

    it('wraps the summary in the clean-setup header + trailing separator', () => {
      const digest = editorialSetupDigest('- past tense, first person\n- Watch = grief over father');
      expect(digest).toMatch(/Setup already established in EARLIER parts/);
      expect(digest).toContain('past tense, first person');
      expect(digest).toContain('Watch = grief over father');
      expect(digest.endsWith('\n\n---\n\n')).toBe(true);
    });

    it('caps the whole digest and keeps the trailing --- separator after a body overflow', () => {
      const digest = editorialSetupDigest('x'.repeat(EDITORIAL_SETUP_DIGEST_BODY_CHARS + 500));
      expect(digest.length).toBeLessThanOrEqual(EDITORIAL_SETUP_DIGEST_CHARS);
      expect(digest.endsWith('\n\n---\n\n')).toBe(true);
      // A following chunk stays clearly separated from the digest body.
      expect(`${digest}NEXT_CHUNK`).toContain('---\n\nNEXT_CHUNK');
    });
  });

  describe('buildSetupDigestPrompt', () => {
    it('embeds the focus, the prior summary, and the new chunk; asks for summary-only output', () => {
      const prompt = buildSetupDigestPrompt({
        focus: 'tense/POV/rating in force',
        priorSummary: '- past tense established',
        manuscript: 'CHAPTER TWO TEXT',
      });
      expect(prompt).toContain('tense/POV/rating in force');
      expect(prompt).toContain('- past tense established');
      expect(prompt).toContain('CHAPTER TWO TEXT');
      expect(prompt).toMatch(/summary text only/i);
    });

    it('falls back to a default focus + "(none yet)" prior summary', () => {
      const prompt = buildSetupDigestPrompt({ manuscript: 'CHAPTER ONE' });
      expect(prompt).toContain('(none yet)');
      expect(prompt).toMatch(/narrative tense, point-of-view person, and content rating/);
    });
  });

  // Drive a two-chunk run with an inline LLM caller wired so the clean-setup digest
  // path activates. Returns the manuscript text each findings call saw + the inline
  // prompts the summarizer was given.
  const runTwoChunksWithSetup = async (checkId, ctxExtras, { usableChars } = {}) => {
    const seen = [];
    const setupPrompts = [];
    await getCheck(checkId).run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      planManuscriptChunks: async () => {
        const chunks = ['CHUNK_ONE', 'CHUNK_TWO'];
        if (Number.isFinite(usableChars)) chunks.usableChars = usableChars;
        return chunks;
      },
      callStagedLLM: async (_stage, vars) => {
        seen.push(vars.manuscript);
        return { content: { findings: [] } }; // no findings → isolate the setup digest
      },
      callStageScopedInlineLLM: async (_stage, prompt) => {
        setupPrompts.push(prompt);
        return { content: '- SETUP: past tense, first person' };
      },
      ...ctxExtras,
    });
    return { seen, setupPrompts };
  };

  it('style.conformance rolls a setup summary forward into the next chunk', async () => {
    const { seen, setupPrompts } = await runTwoChunksWithSetup('style.conformance', {
      series: { styleGuide: { tense: 'past', povPerson: 'first' } },
    });
    // First chunk untouched (no prior setup yet).
    expect(seen[0]).toBe('CHUNK_ONE');
    // The summarizer ran once (after chunk one, before chunk two) and saw chunk one.
    expect(setupPrompts).toHaveLength(1);
    expect(setupPrompts[0]).toContain('CHUNK_ONE');
    // The second chunk is prefixed with the clean-setup digest, then its text.
    expect(seen[1]).toContain('Setup already established in EARLIER parts');
    expect(seen[1]).toContain('past tense, first person');
    expect(seen[1].endsWith('CHUNK_TWO')).toBe(true);
  });

  it('objects.unmotivated-interaction rolls a setup summary forward', async () => {
    const { seen, setupPrompts } = await runTwoChunksWithSetup('objects.unmotivated-interaction', {
      canon: {
        objects: [{ id: 'o1', name: 'Watch', attachments: [{ characterId: 'c1', emotion: 'grief' }] }],
        characters: [{ id: 'c1', name: 'Mara' }],
      },
    });
    expect(seen[0]).toBe('CHUNK_ONE');
    expect(setupPrompts).toHaveLength(1);
    expect(seen[1]).toContain('Setup already established in EARLIER parts');
    expect(seen[1].endsWith('CHUNK_TWO')).toBe(true);
  });

  it('objects.weight-proportionality rolls a setup summary forward keyed on object weight/prominence', async () => {
    const { seen, setupPrompts } = await runTwoChunksWithSetup('objects.weight-proportionality', {
      canon: {
        objects: [{ id: 'o1', name: 'Locket', significance: 'an ancestral heirloom', attachments: [{ characterId: 'c1', emotion: 'reverence' }] }],
        characters: [{ id: 'c1', name: 'Mara' }],
      },
    });
    expect(seen[0]).toBe('CHUNK_ONE');
    expect(setupPrompts).toHaveLength(1);
    // The setup focus tracks each object's prominence + established lineage so the final part can weigh a late payoff.
    expect(setupPrompts[0]).toMatch(/prominent or decisive/);
    expect(seen[1]).toContain('Setup already established in EARLIER parts');
    expect(seen[1].endsWith('CHUNK_TWO')).toBe(true);
  });

  it('runs the setup-summary on the check STAGE (so it follows the stage provider pin) with the dedicated source tag', async () => {
    let source = null;
    let stageSeen = null;
    await getCheck('style.conformance').run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      series: { styleGuide: { tense: 'past', povPerson: 'first' } },
      planManuscriptChunks: async () => ['CHUNK_ONE', 'CHUNK_TWO'],
      callStagedLLM: async () => ({ content: { findings: [] } }),
      callStageScopedInlineLLM: async (stage, _prompt, opts) => {
        stageSeen = stage;
        source = opts?.source;
        return { content: 'summary' };
      },
    });
    expect(source).toBe(EDITORIAL_SETUP_DIGEST_SOURCE);
    // Pinned to the same stage the findings call uses, so the summary call resolves
    // the stage's provider rather than the active/cloud one.
    expect(stageSeen).toBe('pipeline-editorial-style-conformance');
  });

  it('does not summarize a single-chunk run (no later chunk consumes it)', async () => {
    let inlineCalls = 0;
    const seen = [];
    await getCheck('style.conformance').run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      series: { styleGuide: { tense: 'past', povPerson: 'first' } },
      planManuscriptChunks: async () => ['ONLY_CHUNK'],
      callStagedLLM: async (_stage, vars) => { seen.push(vars.manuscript); return { content: { findings: [] } }; },
      callStageScopedInlineLLM: async () => { inlineCalls += 1; return { content: 'summary' }; },
    });
    expect(seen).toEqual(['ONLY_CHUNK']);
    expect(inlineCalls).toBe(0);
  });

  it('skips the setup digest when it would not fit the chunk budget (manuscript coverage wins)', async () => {
    const { seen } = await runTwoChunksWithSetup(
      'style.conformance',
      { series: { styleGuide: { tense: 'past', povPerson: 'first' } } },
      { usableChars: 'CHUNK_TWO'.length }, // no spare room for any digest
    );
    expect(seen[1]).toBe('CHUNK_TWO');
    expect(seen[1]).not.toContain('Setup already established in EARLIER parts');
  });

  // #1667: a check that gates a whole-story verdict to the final part AND anchors it on
  // the carried setup snippet opts into `reserveSetupDigest` — so when the digest can't
  // ride alongside a packed final chunk, the manuscript TAIL is trimmed to guarantee the
  // carried context, rather than silently dropping it and missing the final-only finding.
  it('reserves room for the setup digest on the FINAL chunk of an opt-in check (#1667), trimming the manuscript tail', async () => {
    const digest = editorialSetupDigest('- SETUP: past tense, first person');
    // Window leaves only 4 chars of spare room beyond the digest, so the digest cannot
    // ride alongside the full final chunk — but arc.climax-agency opts in, so the
    // manuscript tail is trimmed instead of the digest dropped.
    const usableChars = digest.length + 4;
    const { seen } = await runTwoChunksWithSetup('arc.climax-agency', {}, { usableChars });
    // First chunk untouched (no prior setup yet).
    expect(seen[0]).toBe('CHUNK_ONE');
    // Final chunk: the guaranteed setup digest + only the head of the manuscript chunk
    // (tail trimmed), and the total never exceeds the window.
    expect(seen[1].startsWith(digest)).toBe(true);
    expect(seen[1]).toContain('past tense, first person');
    expect(seen[1]).toBe(`${digest}CHUN`);
    expect(seen[1].length).toBe(usableChars);
  });

  it('reserves the setup digest even when it fully displaces the final manuscript chunk (#1667)', async () => {
    const digest = editorialSetupDigest('- SETUP: past tense, first person');
    const usableChars = digest.length; // zero spare room: digest exactly fills the window
    const { seen } = await runTwoChunksWithSetup('emotion.reaction-proportionality', {}, { usableChars });
    expect(seen[1]).toBe(digest); // manuscript tail trimmed to nothing, digest guaranteed
    expect(seen[1].length).toBe(usableChars);
  });

  it('does NOT reserve the setup digest for a check that did not opt in (manuscript coverage still wins)', async () => {
    const digest = editorialSetupDigest('- SETUP: past tense, first person');
    // Same window where the opt-in check would trim to fit — but style.conformance does
    // not set reserveSetupDigest, so the digest yields and the full manuscript chunk runs.
    const usableChars = digest.length + 4;
    const { seen } = await runTwoChunksWithSetup(
      'style.conformance',
      { series: { styleGuide: { tense: 'past', povPerson: 'first' } } },
      { usableChars },
    );
    expect(seen[1]).toBe('CHUNK_TWO');
    expect(seen[1]).not.toContain('Setup already established in EARLIER parts');
  });

  it('yields (no overflow) when the setup digest alone is larger than the whole window, even for an opt-in check (#1667)', async () => {
    const digest = editorialSetupDigest('- SETUP: past tense, first person');
    const usableChars = digest.length - 5; // even the digest alone overflows the window
    const { seen } = await runTwoChunksWithSetup('arc.climax-agency', {}, { usableChars });
    // A digest that can't fit the window at all must not be prepended — fall back to
    // the manuscript chunk untouched rather than send an over-budget prompt.
    expect(seen[1]).toBe('CHUNK_TWO');
    expect(seen[1]).not.toContain('Setup already established in EARLIER parts');
  });

  it('reserves from the RAW manuscript so a prepended findings digest is never truncated mid-block (#1667)', async () => {
    const setupDigest = editorialSetupDigest('- SETUP: past tense, first person');
    // A finding from the first chunk produces a findings digest carried into the final
    // chunk; size the window so the findings digest fits there but the setup digest
    // doesn't, forcing the reserve branch.
    const findingsDigest = editorialPriorFindingsDigest([{ category: 'arc', problem: 'passive climax', issueNumber: 1, location: '' }]);
    const usableChars = setupDigest.length + findingsDigest.length + 2;
    const seen = [];
    let call = 0;
    await getCheck('arc.climax-agency').run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      planManuscriptChunks: async () => {
        const chunks = ['CHUNK_ONE', 'CHUNK_TWO'];
        chunks.usableChars = usableChars;
        return chunks;
      },
      callStagedLLM: async (_stage, vars) => {
        seen.push(vars.manuscript);
        call += 1;
        // First chunk emits a finding so the final chunk carries a findings digest.
        return call === 1
          ? { content: { findings: [{ problem: 'passive climax', severity: 'medium', issueNumber: 1 }] } }
          : { content: { findings: [] } };
      },
      callStageScopedInlineLLM: async () => ({ content: '- SETUP: past tense, first person' }),
    });
    // Final chunk: setup digest guaranteed + the manuscript head, rebuilt from the raw
    // manuscript — so the findings digest is dropped whole, never sliced into a
    // malformed fragment (the old `text.slice` would have emitted a partial header).
    expect(seen[1]).toBe(`${setupDigest}CHUNK_TWO`);
    expect(seen[1]).not.toContain('Editorial findings already recorded');
    expect(seen[1].length).toBeLessThanOrEqual(usableChars);
  });

  it('only reserves on the FINAL chunk — a non-final chunk still yields the digest to manuscript coverage (#1667)', async () => {
    const digest = editorialSetupDigest('- SETUP: past tense, first person');
    const seen = [];
    // Three chunks: the MIDDLE chunk (i=1) consumes a setup summary but is not final, so
    // even for an opt-in check it must yield (no tail trimming) when the digest won't fit.
    await getCheck('arc.climax-agency').run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      planManuscriptChunks: async () => {
        const chunks = ['CHUNK_ONE', 'CHUNK_TWO', 'CHUNK_THREE'];
        chunks.usableChars = digest.length + 4; // would force a trim IF this were the final chunk
        return chunks;
      },
      callStagedLLM: async (_stage, vars) => { seen.push(vars.manuscript); return { content: { findings: [] } }; },
      callStageScopedInlineLLM: async () => ({ content: '- SETUP: past tense, first person' }),
    });
    // Middle chunk yields the digest (not final) → runs the full manuscript untouched.
    expect(seen[1]).toBe('CHUNK_TWO');
    // Final chunk reserves → digest guaranteed, manuscript tail trimmed.
    expect(seen[2].startsWith(digest)).toBe(true);
    expect(seen[2]).toBe(`${digest}CHUN`);
  });

  it('degrades to findings-only when no inline LLM caller is injected (no setup digest, no crash)', async () => {
    // No callStageScopedInlineLLM in ctx → the setup-summary path stays off entirely.
    const seen = [];
    await getCheck('style.conformance').run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      series: { styleGuide: { tense: 'past', povPerson: 'first' } },
      planManuscriptChunks: async () => ['CHUNK_ONE', 'CHUNK_TWO'],
      callStagedLLM: async (_stage, vars) => { seen.push(vars.manuscript); return { content: { findings: [] } }; },
    });
    expect(seen).toEqual(['CHUNK_ONE', 'CHUNK_TWO']);
    expect(seen[1]).not.toContain('Setup already established in EARLIER parts');
  });

  it('caps the STORED rolling summary so a verbose summarizer response cannot compound across chunks', async () => {
    // The summarizer echoes a huge response; the prior summary fed into the NEXT
    // summarization prompt must be capped, not the full string.
    const priorSummariesSeen = [];
    await getCheck('style.conformance').run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      series: { styleGuide: { tense: 'past', povPerson: 'first' } },
      planManuscriptChunks: async () => ['CHUNK_ONE', 'CHUNK_TWO', 'CHUNK_THREE'],
      callStagedLLM: async () => ({ content: { findings: [] } }),
      callStageScopedInlineLLM: async (_stage, prompt) => {
        // Capture the "Setup recorded so far" section the prompt embedded.
        const m = prompt.match(/# Setup recorded so far \(from earlier parts\)\n([\s\S]*?)\n\n# New manuscript part/);
        priorSummariesSeen.push(m ? m[1] : '');
        return { content: 'y'.repeat(EDITORIAL_SETUP_DIGEST_BODY_CHARS + 5000) };
      },
    });
    // First summarizer call has no prior summary; the second sees the capped first.
    expect(priorSummariesSeen[0]).toBe('(none yet)');
    expect(priorSummariesSeen[1].length).toBeLessThanOrEqual(EDITORIAL_SETUP_DIGEST_BODY_CHARS);
  });

  it('keeps the prior summary when the summarizer throws (a bad call must not abort the check)', async () => {
    const seen = [];
    let inlineCalls = 0;
    await getCheck('style.conformance').run({
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      series: { styleGuide: { tense: 'past', povPerson: 'first' } },
      planManuscriptChunks: async () => ['CHUNK_ONE', 'CHUNK_TWO'],
      callStagedLLM: async (_stage, vars) => { seen.push(vars.manuscript); return { content: { findings: [] } }; },
      callStageScopedInlineLLM: async () => { inlineCalls += 1; throw new Error('summarizer down'); },
    });
    // The summarizer was attempted but threw → no setup digest, and the run still
    // processed both chunks to completion.
    expect(inlineCalls).toBe(1);
    expect(seen).toEqual(['CHUNK_ONE', 'CHUNK_TWO']);
    expect(seen[1]).not.toContain('Setup already established in EARLIER parts');
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

describe('visual.eyeline-match — LLM check (#1466)', () => {
  const sceneEntry = (issueNumber, scene) => ({ issueNumber, scene });
  // A comparable scene: two characters whose gaze does not reciprocate.
  const comparableScenes = () => [
    sceneEntry(4, {
      heading: 'INT. KITCHEN',
      shots: [
        { id: 'shot-01', shotType: 'medium', screenDirection: 'right', description: 'Anna faces Ben, looking screen-right' },
        { id: 'shot-02', shotType: 'medium', screenDirection: 'right', continuityFromShotId: 'shot-01', description: 'Ben answers Anna but also looks screen-right' },
      ],
    }),
  ];

  it('gates on whether any scene has two-or-more described shots to compare', () => {
    const check = getCheck('visual.eyeline-match');
    expect(check.gate({ storyboardScenes: comparableScenes() })).toBe(true);
    // A single described shot → nothing to match an eyeline across.
    expect(check.gate({ storyboardScenes: [sceneEntry(1, { heading: 'A', shots: [{ id: 's1', description: 'alone' }] })] })).toBe(false);
    expect(check.gate({ storyboardScenes: [] })).toBe(false);
    expect(check.gate({ storyboardScenes: null })).toBe(false);
  });

  it('feeds the rendered shot block to the model and shapes findings (issue-anchored)', async () => {
    let vars = null;
    const findings = await getCheck('visual.eyeline-match').run({
      storyboardScenes: comparableScenes(),
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      callStagedLLM: async (_stage, v) => {
        vars = v;
        return { content: { findings: [{
          severity: 'high',
          issueNumber: 4,
          location: 'Issue 4 — INT. KITCHEN: shots shot-01 ↔ shot-02',
          problem: 'Both characters look screen-right, so their eyelines do not reciprocate across the cut.',
          suggestion: 'Flip shot-02 to screen-left so Ben looks back toward Anna.',
          anchorQuote: 'also looks screen-right',
        }] } };
      },
    });
    expect(vars.shots).toContain('Scene 1 (Issue 4): INT. KITCHEN');
    expect(vars.shots).toContain('shot-01');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('continuity');
    expect(findings[0].issueNumber).toBe(4);
    expect(findings[0].severity).toBe('high');
  });

  it('returns no findings (and never calls the model) when no scene qualifies', async () => {
    let called = false;
    const findings = await getCheck('visual.eyeline-match').run({
      storyboardScenes: [sceneEntry(1, { heading: 'A', shots: [{ id: 's1', description: 'alone' }] })],
      config: {},
      severityDefault: 'medium',
      callStagedLLM: async () => { called = true; return { content: { findings: [] } }; },
    });
    expect(findings).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('visual.appearance-continuity — LLM check (#1467)', () => {
  const sceneEntry = (issueNumber, scene) => ({ issueNumber, scene });
  // A comparable scene: the same character described with conflicting wardrobe
  // across two shots, so there is an appearance to diff.
  const comparableScenes = () => [
    sceneEntry(4, {
      heading: 'INT. KITCHEN',
      shots: [
        { id: 'shot-01', shotType: 'medium', screenDirection: 'right', description: 'Anna in a bright red jacket pours coffee' },
        { id: 'shot-03', shotType: 'medium', screenDirection: 'right', continuityFromShotId: 'shot-01', description: 'Anna, now in a grey coat, sets the mug down' },
      ],
    }),
  ];

  it('gates on whether any scene has two-or-more described shots to diff', () => {
    const check = getCheck('visual.appearance-continuity');
    expect(check.gate({ storyboardScenes: comparableScenes() })).toBe(true);
    // A single described shot → nothing to diff an appearance across.
    expect(check.gate({ storyboardScenes: [sceneEntry(1, { heading: 'A', shots: [{ id: 's1', description: 'alone' }] })] })).toBe(false);
    expect(check.gate({ storyboardScenes: [] })).toBe(false);
    expect(check.gate({ storyboardScenes: null })).toBe(false);
  });

  it('feeds the rendered shot block to the model and shapes findings (issue-anchored)', async () => {
    let vars = null;
    const findings = await getCheck('visual.appearance-continuity').run({
      storyboardScenes: comparableScenes(),
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      callStagedLLM: async (_stage, v) => {
        vars = v;
        return { content: { findings: [{
          severity: 'high',
          issueNumber: 4,
          location: 'Issue 4 — INT. KITCHEN: shots shot-01 ↔ shot-03',
          problem: 'Anna wears a red jacket in shot-01 but a grey coat in shot-03 with no costume change described.',
          suggestion: 'Align shot-03 to the red jacket, or describe the wardrobe change between shots.',
          anchorQuote: 'now in a grey coat',
        }] } };
      },
    });
    expect(vars.shots).toContain('Scene 1 (Issue 4): INT. KITCHEN');
    expect(vars.shots).toContain('shot-01');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('continuity');
    expect(findings[0].issueNumber).toBe(4);
    expect(findings[0].severity).toBe('high');
  });

  it('returns no findings (and never calls the model) when no scene qualifies', async () => {
    let called = false;
    const findings = await getCheck('visual.appearance-continuity').run({
      storyboardScenes: [sceneEntry(1, { heading: 'A', shots: [{ id: 's1', description: 'alone' }] })],
      config: {},
      severityDefault: 'medium',
      callStagedLLM: async () => { called = true; return { content: { findings: [] } }; },
    });
    expect(findings).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('comic.prose-sync — LLM cross-media check (#1589)', () => {
  // A hybrid issue record: a populated comicPages split AND a prose stage. Built the
  // way production issues are (full `stages`), NOT via synthetic manuscript sections
  // — so the prose half is read from the `prose` stage, exercising the real path.
  const hybridIssue = (number, prose, panels, extraStages = {}) => ({
    number,
    stages: { prose: { output: prose }, comicPages: { pages: [{ panels }] }, ...extraStages },
  });
  // A comic-only issue (comic content, no prose stage).
  const comicOnlyIssue = (number, panels) => ({ number, stages: { comicPages: { pages: [{ panels }] } } });
  // A prose-only issue (prose stage, no comic content).
  const proseOnlyIssue = (number, prose) => ({ number, stages: { prose: { output: prose } } });
  const onePanel = (description) => [{ description, dialogue: [], caption: '', sfx: '' }];

  describe('pure helpers', () => {
    it('proseStageIssues reads the prose STAGE specifically, not comicScript — keyed/sorted by number', () => {
      const rows = proseStageIssues([
        // A hybrid issue with BOTH a comicScript stage AND a prose stage: the
        // helper must pick the PROSE, never the comic script (the core bug guard).
        { number: 5, stages: { comicScript: { output: 'COMIC SCRIPT — not prose' }, prose: { output: 'Issue five prose.' } } },
        { number: 3, stages: { prose: { input: 'Issue three prose (input fallback).' } } },
        { number: 9, stages: { prose: { output: '   ' } } },        // blank → skipped
        { number: 7, stages: { comicScript: { output: 'comic only' } } }, // no prose → skipped
      ]);
      expect(rows.map((r) => r.number)).toEqual([3, 5]); // sorted, prose-bearing only
      expect(rows.find((r) => r.number === 5).prose).toBe('Issue five prose.');
      expect(rows.find((r) => r.number === 3).prose).toBe('Issue three prose (input fallback).');
    });

    it('renderComicForProseSync emits page/panel headers + shows/dialogue/caption/sfx, skipping empty panels', () => {
      const out = renderComicForProseSync([
        { panels: [
          // Production parsed dialogue shape is { character, line } (NOT { speaker }).
          { description: 'Anna draws the knife', dialogue: [{ character: 'ANNA', line: 'Stay back.' }], caption: 'Later', sfx: 'SHNK' },
          { description: '', dialogue: [], caption: '', sfx: '' }, // empty → skipped
        ] },
      ]);
      expect(out).toContain('Page 1 · Panel 1');
      expect(out).toContain('Shows: Anna draws the knife');
      expect(out).toContain('ANNA: Stay back.');
      expect(out).toContain('Caption: Later');
      expect(out).toContain('SFX: SHNK');
      // The empty second panel produced no header.
      expect(out).not.toContain('Panel 2');
    });

    it('proseSyncPairs joins only issues with BOTH prose and comic, caps prose, and uses the prose stage', () => {
      const longProse = 'x'.repeat(PROSE_SYNC_PROSE_CHAR_CAP + 500);
      const ctx = {
        issues: [
          // Hybrid: prose stage + comic. Also carries a comicScript stage to prove
          // the prose half comes from `prose`, not the comicScript precedence.
          hybridIssue(3, longProse, onePanel('a panel'), { comicScript: { output: 'WRONG — comic script' } }),
          comicOnlyIssue(7, onePanel('comic but no prose')),
          proseOnlyIssue(9, 'prose but no comic'),
        ],
      };
      const pairs = proseSyncPairs(ctx);
      expect(pairs.map((p) => p.number)).toEqual([3]); // only issue 3 has both
      expect(pairs[0].prose).toHaveLength(PROSE_SYNC_PROSE_CHAR_CAP);
      expect(pairs[0].prose.startsWith('x')).toBe(true); // the prose stage, not the comic script
      expect(pairs[0].comic).toContain('Shows: a panel');
    });
  });

  it('gates true only when an issue has both prose and comic content', () => {
    const check = getCheck('comic.prose-sync');
    expect(check.gate({ issues: [hybridIssue(3, 'prose', onePanel('panel'))] })).toBe(true);
    // Comic but no prose → nothing to cross-check.
    expect(check.gate({ issues: [comicOnlyIssue(3, onePanel('panel'))] })).toBe(false);
    // Prose but no comic → nothing to cross-check.
    expect(check.gate({ issues: [proseOnlyIssue(3, 'prose')] })).toBe(false);
    expect(check.gate({ issues: [] })).toBe(false);
  });

  it('compares the PROSE stage (not the comic script) for a hybrid issue', async () => {
    let seen = null;
    await getCheck('comic.prose-sync').run({
      issues: [
        // A hybrid issue whose comicScript stage text differs from its prose stage —
        // the check must hand the model the PROSE, never the comic script.
        hybridIssue(3, 'Anna is stabbed and falls.', onePanel('Anna stands, unharmed'), { comicScript: { output: 'COMIC SCRIPT SOURCE — must not be sent' } }),
      ],
      config: {},
      severityDefault: 'medium',
      callStagedLLM: async (_stage, vars) => { seen = vars; return { content: { findings: [] } }; },
    });
    expect(seen.prose).toBe('Anna is stabbed and falls.');
    expect(seen.prose).not.toContain('COMIC SCRIPT SOURCE');
    expect(seen.comic).toContain('Shows: Anna stands, unharmed');
  });

  it('makes one model call per hybrid issue and forces the issue anchor on findings', async () => {
    const seen = [];
    const findings = await getCheck('comic.prose-sync').run({
      issues: [
        hybridIssue(3, 'Anna is stabbed and falls.', onePanel('Anna stands, unharmed')),
        hybridIssue(4, 'A quiet morning.', onePanel('morning kitchen')),
      ],
      config: { maxFindings: 12, maxIssues: 40 },
      severityDefault: 'medium',
      callStagedLLM: async (_stage, vars) => {
        seen.push(vars);
        // Model reports a mismatch only for issue 3, and deliberately omits
        // issueNumber to prove the check forces it.
        return vars.issueNumber === 3
          ? { content: { findings: [{ severity: 'medium', location: 'Issue 3 — unshown beat', problem: 'Prose stabs Anna; no panel shows it.', suggestion: 'Add a panel.', anchorQuote: 'Anna is stabbed' }] } }
          : { content: { findings: [] } };
      },
    });
    // One call per hybrid issue.
    expect(seen.map((v) => v.issueNumber).sort()).toEqual([3, 4]);
    expect(seen[0]).toHaveProperty('prose');
    expect(seen[0]).toHaveProperty('comic');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('continuity');
    expect(findings[0].issueNumber).toBe(3); // forced from the pair, not the model
  });

  it('respects maxIssues (caps the number of model calls)', async () => {
    let calls = 0;
    await getCheck('comic.prose-sync').run({
      issues: [
        hybridIssue(3, 'p3', onePanel('d3')),
        hybridIssue(4, 'p4', onePanel('d4')),
        hybridIssue(5, 'p5', onePanel('d5')),
      ],
      config: { maxIssues: 2 },
      severityDefault: 'medium',
      callStagedLLM: async () => { calls += 1; return { content: { findings: [] } }; },
    });
    expect(calls).toBe(2);
  });

  it('stops launching further calls once the abort signal trips', async () => {
    let calls = 0;
    const signal = { aborted: false };
    await getCheck('comic.prose-sync').run({
      issues: [
        hybridIssue(3, 'p3', onePanel('d3')),
        hybridIssue(4, 'p4', onePanel('d4')),
      ],
      config: {},
      severityDefault: 'medium',
      signal,
      callStagedLLM: async () => { calls += 1; signal.aborted = true; return { content: { findings: [] } }; },
    });
    expect(calls).toBe(1); // second issue skipped after the signal tripped
  });

  it('returns no findings (and never calls the model) when no issue is hybrid', async () => {
    let called = false;
    const findings = await getCheck('comic.prose-sync').run({
      issues: [proseOnlyIssue(3, 'prose only')], // no comic content anywhere
      config: {},
      severityDefault: 'medium',
      callStagedLLM: async () => { called = true; return { content: { findings: [] } }; },
    });
    expect(findings).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('style.reading-level — deterministic check (#1303)', () => {
  const check = getCheck('style.reading-level');
  const run = (styleGuide, manuscript, config = {}) =>
    check.run({ series: { styleGuide }, manuscript, config, severityDefault: 'low' });
  const gate = (styleGuide, manuscript) => check.gate({ series: { styleGuide }, manuscript });

  // Simple grade-3-ish prose (short words, short sentences) vs. dense academic
  // prose (long words, long sentences) — far enough apart that the FK estimate
  // lands on opposite sides of a mid-range target with a tight tolerance.
  const SIMPLE = 'The cat sat. The dog ran. We had fun. It was a good day. '.repeat(8);
  const DENSE = ('The aforementioned epistemological ramifications necessitated unprecedented '
    + 'interdisciplinary collaboration amongst numerous distinguished academic institutions '
    + 'throughout the consequential deliberations. ').repeat(6);
  // Ordinary narrative prose — grade lands in a middle band, so a mid target
  // with the max tolerance is comfortably within range regardless of the exact
  // FK estimate.
  const MEDIUM = ('The surveyor walked along the quiet harbor and counted the empty boats. '
    + 'She wondered where the fishermen had gone. The morning felt strange and still. ').repeat(5);

  it('gate requires both a target reading level and a non-empty manuscript', () => {
    expect(gate({ readingLevel: 8 }, '')).toBe(false);
    expect(gate(null, SIMPLE)).toBe(false);
    expect(gate({ readingLevel: 8 }, SIMPLE)).toBe(true);
  });

  it('returns nothing when the measured grade is within tolerance', () => {
    // Ordinary prose targeted at a mid grade with the max tolerance → within.
    expect(run({ readingLevel: 6 }, MEDIUM, { tolerance: 6 })).toEqual([]);
  });

  it('flags prose that reads ABOVE the target', () => {
    const findings = run({ readingLevel: 3 }, DENSE, { tolerance: 2 });
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('style');
    expect(findings[0].problem).toMatch(/above/i);
    expect(findings[0].issueNumber).toBeNull();
  });

  it('flags prose that reads BELOW the target', () => {
    const findings = run({ readingLevel: 12 }, SIMPLE, { tolerance: 2 });
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toMatch(/below/i);
  });

  // Per-scene reading-level variance (#1625). A scene-broken manuscript so
  // `splitScenes` yields >1 measurable scene; `minSceneWords` lowered because the
  // SIMPLE fixture is ~110 words (under the 120 default). A scene-level finding is
  // identified by its "— scene N" location.
  const sceneFindings = (findings) => findings.filter((f) => /— scene \d/i.test(f.location));
  const BREAK = '\n\n* * *\n\n';

  it('flags a single scene that swings ABOVE the target band', () => {
    // Two calm scenes + one dense scene; the dense one breaks the band even if the
    // averaged whole-corpus grade would not.
    const manuscript = [MEDIUM, MEDIUM, DENSE].join(BREAK);
    const findings = run({ readingLevel: 6 }, manuscript, { sceneTolerance: 3, minSceneWords: 20 });
    const scenes = sceneFindings(findings);
    expect(scenes.length).toBeGreaterThanOrEqual(1);
    const above = scenes.find((f) => /above the target band/i.test(f.problem));
    expect(above).toBeTruthy();
    expect(above.location).toMatch(/— scene \d/i);
    expect(above.anchorQuote).toBeTruthy();
    expect(above.issueNumber).toBeNull();
  });

  it('flags a single scene that swings BELOW the target band', () => {
    const manuscript = [DENSE, DENSE, SIMPLE].join(BREAK);
    const findings = run({ readingLevel: 12 }, manuscript, { sceneTolerance: 3, minSceneWords: 20 });
    const below = sceneFindings(findings).find((f) => /below the target band/i.test(f.problem));
    expect(below).toBeTruthy();
    expect(below.anchorQuote).toBeTruthy();
  });

  it('reports no per-scene findings when every scene sits within the band', () => {
    const manuscript = [MEDIUM, MEDIUM, MEDIUM].join(BREAK);
    const findings = run({ readingLevel: 7 }, manuscript, { tolerance: 6, sceneTolerance: 6, minSceneWords: 20 });
    expect(sceneFindings(findings)).toHaveLength(0);
  });

  it('caps per-scene findings at maxSceneFindings (worst swings first)', () => {
    // Six out-of-band dense scenes, cap of 2 → at most 2 scene findings.
    const manuscript = Array(6).fill(DENSE).join(BREAK);
    const findings = run({ readingLevel: 3 }, manuscript, { tolerance: 12, sceneTolerance: 4, minSceneWords: 20, maxSceneFindings: 2 });
    expect(sceneFindings(findings)).toHaveLength(2);
  });

  it('does not emit per-scene findings for a single-scene manuscript', () => {
    // No scene dividers → one scene → only the whole-corpus check can fire.
    const findings = run({ readingLevel: 3 }, DENSE, { tolerance: 2, sceneTolerance: 1, minSceneWords: 20 });
    expect(sceneFindings(findings)).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toMatch(/whole-corpus/i);
  });

  it('is enabled by default', () => {
    expect(check.defaultEnabled).toBe(true);
  });
});

describe('style.conformance — LLM check (#1303)', () => {
  const check = getCheck('style.conformance');
  const gate = (styleGuide, manuscript = 'Some prose.') => check.gate({ series: { styleGuide }, manuscript });

  it('gate requires prose AND a conformance-relevant style-guide field', () => {
    expect(gate({ tense: 'past' }, '')).toBe(false);          // no prose
    expect(gate({ tone: ['noir'] })).toBe(false);             // tone alone isn't conformance-relevant
    expect(gate(null)).toBe(false);
    expect(gate({ tense: 'past' })).toBe(true);
    expect(gate({ contentRating: 'PG-13' })).toBe(true);
  });

  it('passes the declared expectations + manuscript to the model and maps findings', async () => {
    let sentVars = null;
    const manuscript = '# Issue 2 — Drift (prose)\n\nI walk to the door.';
    const findings = await check.run({
      series: { styleGuide: { tense: 'past', povPerson: 'first', contentRating: 'PG' } },
      manuscript,
      config: { maxFindings: 5 },
      severityDefault: 'medium',
      planManuscriptChunks: async () => [manuscript],
      callStagedLLM: async (_stage, vars) => {
        sentVars = vars;
        return { content: { findings: [{ severity: 'high', issueNumber: 2, problem: 'present-tense slip', anchorQuote: 'I walk' }] } };
      },
    });
    expect(sentVars.styleGuide).toMatch(/Tense: past/);
    expect(sentVars.styleGuide).toMatch(/Point-of-view person: first/);
    expect(sentVars.styleGuide).toMatch(/Content rating ceiling: PG/);
    expect(sentVars.manuscript).toContain('I walk to the door');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('style');
    expect(findings[0].issueNumber).toBe(2);
    expect(findings[0].severity).toBe('high');
  });

  it('is enabled by default', () => {
    expect(check.defaultEnabled).toBe(true);
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

describe('prose.cliches / prose.modifier-stacking / prose.dead-metaphor (#1308)', () => {
  const CLICHES = 'prose.cliches';
  const STACKING = 'prose.modifier-stacking';
  const DEADMETA = 'prose.dead-metaphor';

  it('registers all three as manuscript-scoped style checks of the right kind', () => {
    expect(getCheck(CLICHES).kind).toBe('deterministic');
    expect(getCheck(STACKING).kind).toBe('deterministic');
    expect(getCheck(DEADMETA).kind).toBe('llm');
    for (const id of [CLICHES, STACKING, DEADMETA]) {
      const c = getCheck(id);
      expect(c.category).toBe('style');
      expect(c.sources).toEqual(['manuscript']);
      expect(c.needsManuscript).toBe(true);
      expect(c.gate({ manuscript: '' })).toBe(false);
      expect(c.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
    }
  });

  it('prose.cliches anchors a stock phrase to its issue and dedupes across the draft', () => {
    const sections = [
      { number: 1, content: 'And then time stood still in the hall.' },
      { number: 2, content: 'Once more, time stood still — but also all hell broke loose.' },
    ];
    const findings = getCheck(CLICHES).run({ sections, config: {}, severityDefault: 'low' });
    // "time stood still" deduped to issue 1; "all hell broke loose" from issue 2.
    expect(findings.map((f) => f.anchorQuote)).toEqual(['time stood still', 'all hell broke loose']);
    expect(findings[0].issueNumber).toBe(1);
    expect(findings[0].category).toBe('style');
    expect(findings[1].issueNumber).toBe(2);
  });

  it('prose.cliches honors the house-style allowlist and the findings cap', () => {
    const sections = [{ number: 1, content: 'time stood still and all hell broke loose' }];
    const muted = getCheck(CLICHES).run({ sections, config: { allowPhrases: 'time stood still' }, severityDefault: 'low' });
    expect(muted.map((f) => f.anchorQuote)).toEqual(['all hell broke loose']);
    const capped = getCheck(CLICHES).run({ sections, config: { maxFindings: 1 }, severityDefault: 'low' });
    expect(capped).toHaveLength(1);
  });

  it('prose.modifier-stacking flags a no-comma adjective pile and escalates a long run', () => {
    const sections = [{ number: 3, content: 'a big red shiny new old battered car rolled by' }];
    const findings = getCheck(STACKING).run({ sections, config: {}, severityDefault: 'low' });
    expect(findings).toHaveLength(1);
    expect(findings[0].issueNumber).toBe(3);
    // 6-modifier pile (>=5) escalates above the low floor.
    expect(findings[0].severity).toBe('medium');
  });

  it('prose.dead-metaphor passes the planned chunk to the model and forces the style category', async () => {
    let seen = null;
    const findings = await getCheck(DEADMETA).run({
      manuscript: '# Issue 4\n\nThe beacon of hope shone.',
      config: { maxFindings: 12 },
      severityDefault: 'low',
      planManuscriptChunks: async (_stage, opts) => {
        expect(opts.overheadTokens).toBeGreaterThan(0);
        return ['# Issue 4\n\nThe beacon of hope shone.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seen = vars.manuscript;
        return { content: { findings: [{ severity: 'low', issueNumber: 4, location: 'Issue 4 — cliché', problem: 'dead metaphor', anchorQuote: 'beacon of hope' }] } };
      },
    });
    expect(seen).toBe('# Issue 4\n\nThe beacon of hope shone.');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('style');
    expect(findings[0].issueNumber).toBe(4);
  });
});

describe('copy-edit prose-tic bundle (#1306)', () => {
  const FILTER = 'prose.filter-words';
  const HEDGE = 'prose.hedge-words';
  const CRUTCH = 'prose.crutch-words';
  const ADVERBS = 'prose.adverbs';
  const PASSIVE = 'prose.passive-voice';
  const GESTURES = 'prose.repeated-gestures';
  const ECHOES = 'prose.word-echoes';
  const RHYTHM = 'prose.sentence-rhythm';
  const TELLING = 'prose.telling-emotion';
  const DETERMINISTIC = [FILTER, HEDGE, CRUTCH, ADVERBS, PASSIVE, GESTURES, ECHOES, RHYTHM];

  it('registers all deterministic prose-tic checks as manuscript style checks of the right kind', () => {
    for (const id of DETERMINISTIC) {
      const c = getCheck(id);
      expect(c.kind, id).toBe('deterministic');
      expect(c.category, id).toBe('style');
      expect(c.sources, id).toEqual(['manuscript']);
      expect(c.needsManuscript, id).toBe(true);
      expect(c.gate({ manuscript: '' }), id).toBe(false);
      expect(c.gate({ manuscript: '# Issue 1\n\nprose' }), id).toBeTruthy();
    }
    expect(getCheck(TELLING).kind).toBe('llm');
    expect(getCheck(TELLING).category).toBe('style');
  });

  it('prose.filter-words flags above the density threshold and anchors to the issue', () => {
    // 5 filter words in ~10 words → ~500/1000, well above default 6.
    const sections = [{ number: 2, content: 'She saw it. He felt it. They heard it. I noticed. We watched.' }];
    const findings = getCheck(FILTER).run({ sections, config: {}, severityDefault: 'low' });
    expect(findings).toHaveLength(1);
    expect(findings[0].issueNumber).toBe(2);
    expect(findings[0].category).toBe('style');
    expect(findings[0].anchorQuote.toLowerCase()).toBe('saw');
  });

  it('prose.filter-words stays silent below the density threshold', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const sections = [{ number: 1, content: `She saw it. ${filler}` }];
    expect(getCheck(FILTER).run({ sections, config: { densityPer1000: 6 }, severityDefault: 'low' })).toEqual([]);
  });

  it('prose.hedge-words flags hedge/weasel markers above the density threshold and anchors to the issue', () => {
    // 4 hedge markers ("as if", "part of him", "almost", "no doubt") in ~13 words.
    const sections = [{ number: 5, content: 'It was as if part of him almost knew, no doubt of it.' }];
    const findings = getCheck(HEDGE).run({ sections, config: {}, severityDefault: 'low' });
    expect(findings).toHaveLength(1);
    expect(findings[0].issueNumber).toBe(5);
    expect(findings[0].category).toBe('style');
    expect(/hedge\/weasel/i.test(findings[0].problem)).toBe(true);
    expect(findings[0].anchorQuote.toLowerCase()).toBe('as if');
  });

  it('prose.hedge-words stays silent below the density threshold', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const sections = [{ number: 1, content: `It was as if true. ${filler}` }];
    expect(getCheck(HEDGE).run({ sections, config: { densityPer1000: 7 }, severityDefault: 'low' })).toEqual([]);
  });

  it('prose.crutch-words excludes "that" unless includeThat is set', () => {
    const sections = [{ number: 1, content: 'It was just really very that thing that he saw.' }];
    const off = getCheck(CRUTCH).run({ sections, config: { densityPer1000: 0 }, severityDefault: 'low' });
    expect(off).toHaveLength(1);
    const on = getCheck(CRUTCH).run({ sections, config: { densityPer1000: 0, includeThat: true }, severityDefault: 'low' });
    // "that" now counted → both findings present, but it's one section so still one finding;
    // assert the anchor is the first crutch word regardless.
    expect(on[0].anchorQuote.toLowerCase()).toBe('just');
  });

  it('prose.adverbs flags emotion-telling dialogue-tag adverbs at higher severity regardless of density', () => {
    const sections = [{ number: 3, content: '"Fine," she said angrily as the room slept.' }];
    const findings = getCheck(ADVERBS).run({ sections, config: { densityPer1000: 999 }, severityDefault: 'low' });
    const tag = findings.find((f) => /dialogue tag/i.test(f.problem));
    expect(tag).toBeTruthy();
    expect(tag.severity).toBe('medium'); // escalated one step above low
    expect(tag.anchorQuote.toLowerCase()).toBe('angrily');
    expect(/emotion-telling/i.test(tag.problem)).toBe(true);
  });

  it('prose.adverbs leaves a reporting dialogue tag ("said quietly") unflagged by default', () => {
    const sections = [{ number: 7, content: '"Fine," she said quietly as the room slept.' }];
    const findings = getCheck(ADVERBS).run({ sections, config: { densityPer1000: 999 }, severityDefault: 'low' });
    // Reporting tag is an invisible stage direction → no tag finding, and density
    // is gated out by the 999/1000 threshold, so nothing fires.
    expect(findings.find((f) => /dialogue tag/i.test(f.problem))).toBeUndefined();
  });

  it('prose.adverbs flags reporting tags too when flagReportingTags is set', () => {
    const sections = [{ number: 8, content: '"Fine," she said quietly as the room slept.' }];
    const findings = getCheck(ADVERBS).run({ sections, config: { densityPer1000: 999, flagReportingTags: true }, severityDefault: 'low' });
    const tag = findings.find((f) => /dialogue tag/i.test(f.problem));
    expect(tag).toBeTruthy();
    expect(tag.anchorQuote.toLowerCase()).toBe('quietly');
    // With reporting tags included the wording must stay neutral — it can not
    // claim a "said quietly" match "names the feeling".
    expect(/emotion-telling/i.test(tag.problem)).toBe(false);
    expect(/adverb-laden/i.test(tag.problem)).toBe(true);
  });

  it('prose.adverbs flags an extraWords adverb the -ly heuristic misses', () => {
    // "fast" is a real adverb without an -ly suffix; a series adds it via extraWords.
    const sections = [{ number: 4, content: 'He ran fast. She ran fast. They drove fast.' }];
    const off = getCheck(ADVERBS).run({ sections, config: { densityPer1000: 0 }, severityDefault: 'low' });
    expect(off).toEqual([]);
    const on = getCheck(ADVERBS).run({ sections, config: { densityPer1000: 0, extraWords: 'fast' }, severityDefault: 'low' });
    expect(on).toHaveLength(1);
    expect(on[0].anchorQuote.toLowerCase()).toBe('fast');
  });

  it('prose.passive-voice flags above the rate threshold', () => {
    const sections = [{ number: 1, content: 'The door was opened. The vase was broken. It was forgotten.' }];
    const findings = getCheck(PASSIVE).run({ sections, config: { densityPer1000: 0 }, severityDefault: 'low' });
    expect(findings).toHaveLength(1);
    expect(/passive/i.test(findings[0].problem)).toBe(true);
  });

  it('prose.passive-voice suppresses intentional passive by default but counts it when toggled off', () => {
    // 1 weak ("was opened") + 1 stative ("was exhausted") + 1 mood ("sky was streaked").
    const sections = [{ number: 1, content: 'The door was opened. She was exhausted. The sky was streaked with red.' }];
    const suppressed = getCheck(PASSIVE).run({ sections, config: { densityPer1000: 0 }, severityDefault: 'low' });
    expect(suppressed).toHaveLength(1);
    expect(/1 passive construction\b/.test(suppressed[0].problem)).toBe(true);
    // With the context tuning off, the raw heuristic counts all three.
    const raw = getCheck(PASSIVE).run({ sections, config: { densityPer1000: 0, suppressIntentional: false }, severityDefault: 'low' });
    expect(/3 passive constructions/.test(raw[0].problem)).toBe(true);
  });

  it('prose.passive-voice mutes an allow-listed participle', () => {
    // "was blessed" trips the raw heuristic; allow-listing it silences the check.
    const sections = [{ number: 1, content: 'She was blessed. He was blessed. They were blessed.' }];
    const raw = getCheck(PASSIVE).run({ sections, config: { densityPer1000: 0, suppressIntentional: false }, severityDefault: 'low' });
    expect(raw).toHaveLength(1);
    const allowed = getCheck(PASSIVE).run({ sections, config: { densityPer1000: 0, suppressIntentional: false, allowWords: 'blessed' }, severityDefault: 'low' });
    expect(allowed).toEqual([]);
  });

  it('prose.passive-voice recognizes a series-specific irregular participle via extraWords', () => {
    const sections = [{ number: 1, content: 'The beam was hewn. The post was hewn. The plank was hewn by hand.' }];
    const off = getCheck(PASSIVE).run({ sections, config: { densityPer1000: 0, suppressIntentional: false }, severityDefault: 'low' });
    expect(off).toEqual([]);
    const on = getCheck(PASSIVE).run({ sections, config: { densityPer1000: 0, suppressIntentional: false, extraWords: 'hewn' }, severityDefault: 'low' });
    expect(on).toHaveLength(1);
    expect(/passive/i.test(on[0].problem)).toBe(true);
  });

  it('prose.repeated-gestures tallies a gesture across the manuscript and flags body-part autonomy', () => {
    const sections = [
      { number: 1, content: Array(5).fill('He nodded.').join(' ') + ' Her eyes followed him across the room.' },
      { number: 2, content: Array(4).fill('She nodded.').join(' ') },
    ];
    const findings = getCheck(GESTURES).run({ sections, config: { maxPerGesture: 8 }, severityDefault: 'low' });
    const gesture = findings.find((f) => /gesture "nod"/i.test(f.problem));
    expect(gesture).toBeTruthy(); // 9 total ≥ 8
    const body = findings.find((f) => /body part/i.test(f.problem));
    expect(body).toBeTruthy();
    expect(body.anchorQuote.toLowerCase()).toContain('eyes followed');
  });

  it('prose.word-echoes flags a distinctive close repeat and a repeated-opener run', () => {
    const sections = [{ number: 4, content: 'The obsidian gleamed. She raised the obsidian. He ran. He fell. He stood.' }];
    const findings = getCheck(ECHOES).run({ sections, config: {}, severityDefault: 'low' });
    expect(findings.some((f) => /obsidian/i.test(f.problem))).toBe(true);
    expect(findings.some((f) => /open with "He"/i.test(f.problem))).toBe(true);
  });

  it('prose.sentence-rhythm flags a uniform passage and stays silent on a varied one', () => {
    const uniform = [{ number: 1, content: Array(10).fill('one two three four five.').join(' ') }];
    const flat = getCheck(RHYTHM).run({ sections: uniform, config: {}, severityDefault: 'low' });
    expect(flat).toHaveLength(1);
    expect(/monotonous/i.test(flat[0].problem)).toBe(true);
  });

  it('prose.telling-emotion passes the planned chunk to the model and forces the style category', async () => {
    let seen = null;
    const findings = await getCheck(TELLING).run({
      manuscript: '# Issue 5\n\nShe was sad.',
      config: { maxFindings: 12 },
      severityDefault: 'low',
      planManuscriptChunks: async (_stage, opts) => {
        expect(opts.overheadTokens).toBeGreaterThan(0);
        return ['# Issue 5\n\nShe was sad.'];
      },
      callStagedLLM: async (_stage, vars) => {
        seen = vars.manuscript;
        return { content: { findings: [{ severity: 'low', issueNumber: 5, location: 'Issue 5 — told sadness', problem: 'told emotion', anchorQuote: 'She was sad' }] } };
      },
    });
    expect(seen).toBe('# Issue 5\n\nShe was sad.');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('style');
    expect(findings[0].issueNumber).toBe(5);
  });
});

describe('prose anti-pattern bundle (#1300)', () => {
  const OPENING = 'opening.wrong-start';
  const MIRROR = 'prose.mirror-description';
  const PLEASANTRIES = 'dialogue.pleasantries';
  const DARLINGS = 'prose.kill-your-darlings';
  const ITALICS = 'prose.italic-thoughts';

  // The four LLM checks share the manuscript-chunk harness — assert each is a
  // registered manuscript-scoped LLM check that forces its own category and
  // passes the planned chunk through.
  const LLM_CHECKS = [
    { id: OPENING, category: 'opening' },
    { id: MIRROR, category: 'cliche' },
    { id: PLEASANTRIES, category: 'dialogue' },
    { id: DARLINGS, category: 'style' },
  ];

  it('registers all five bundle checks (4 LLM + 1 deterministic)', () => {
    const ids = listChecks().map((c) => c.id);
    for (const { id } of LLM_CHECKS) expect(ids).toContain(id);
    expect(ids).toContain(ITALICS);
  });

  for (const { id, category } of LLM_CHECKS) {
    it(`${id} is a manuscript-scoped LLM check gated on prose`, () => {
      const c = getCheck(id);
      expect(c.kind).toBe('llm');
      expect(c.category).toBe(category);
      expect(c.sources).toEqual(['manuscript']);
      expect(c.needsManuscript).toBe(true);
      expect(c.gate({ manuscript: '' })).toBe(false);
      expect(c.gate({ manuscript: '# Issue 1\n\nprose' })).toBeTruthy();
    });

    it(`${id} passes the planned chunk to the model and forces its category`, async () => {
      let seen = null;
      const findings = await getCheck(id).run({
        manuscript: '# Issue 2\n\nSome drafted prose.',
        config: { maxFindings: 12 },
        severityDefault: getCheck(id).severityDefault,
        planManuscriptChunks: async (_stage, opts) => {
          expect(opts.overheadTokens).toBeGreaterThan(0);
          return ['# Issue 2\n\nSome drafted prose.'];
        },
        callStagedLLM: async (_stage, vars) => {
          seen = vars.manuscript;
          return { content: { findings: [{ severity: 'medium', issueNumber: 2, problem: 'p', anchorQuote: 'a' }] } };
        },
      });
      expect(seen).toBe('# Issue 2\n\nSome drafted prose.');
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe(category);
      expect(findings[0].issueNumber).toBe(2);
    });
  }

  describe('prose.italic-thoughts — deterministic check', () => {
    const run = (sections, config = {}) =>
      getCheck(ITALICS).run({ sections, config, severityDefault: 'low' });

    it('declares the expected scope / kind / sources', () => {
      const c = getCheck(ITALICS);
      expect(c.kind).toBe('deterministic');
      expect(c.category).toBe('style');
      expect(c.sources).toEqual(['manuscript']);
      expect(c.needsManuscript).toBe(true);
    });

    it('flags a multi-word italicized thought and anchors it to its issue', () => {
      const findings = run([{ number: 3, content: 'She froze. *He knows I lied to him.* Then she ran.' }]);
      expect(findings).toHaveLength(1);
      expect(findings[0].issueNumber).toBe(3);
      expect(findings[0].category).toBe('style');
      expect(findings[0].severity).toBe('low');
      expect(findings[0].anchorQuote).toBe('*He knows I lied to him.*');
    });

    it('ignores short emphasis spans below the word threshold', () => {
      expect(run([{ number: 1, content: 'She would *never* do that.' }])).toEqual([]);
    });

    it('dedups the same thought across issues and honors maxFindings', () => {
      const sections = [
        { number: 1, content: '*I have to get out of here.*' },
        { number: 2, content: '*I have to get out of here.* again' },
        { number: 3, content: '*A completely different worried thought.*' },
      ];
      const deduped = run(sections);
      expect(deduped).toHaveLength(2); // repeated thought counted once
      const capped = run(sections, { maxFindings: 1 });
      expect(capped).toHaveLength(1);
    });

    it('honors a custom minWords threshold', () => {
      const sections = [{ number: 1, content: 'He paused. *What now?* he wondered.' }];
      expect(run(sections)).toEqual([]); // 2 words < default 4
      expect(run(sections, { minWords: 2 })).toHaveLength(1);
    });
  });
});

describe('dialogue-craft bundle (#1307)', () => {
  const SAID_BOOKISMS = 'dialogue.said-bookisms';
  const ATTRIBUTION = 'dialogue.attribution-clarity';
  const ON_THE_NOSE = 'dialogue.on-the-nose';
  const VOICE = 'dialogue.voice-distinctiveness';

  describe('dialogue.said-bookisms — deterministic check', () => {
    const run = (sections, config = {}) =>
      getCheck(SAID_BOOKISMS).run({ sections, config, severityDefault: 'low' });

    it('declares the expected scope / kind / sources', () => {
      const c = getCheck(SAID_BOOKISMS);
      expect(c.kind).toBe('deterministic');
      expect(c.scope).toBe('issue');
      expect(c.category).toBe('dialogue');
      expect(c.sources).toEqual(['manuscript']);
      expect(c.needsManuscript).toBe(true);
    });

    it('flags an ornate tag and anchors it to its issue', () => {
      const findings = run([{ number: 2, content: '"I object," expostulated the duke.' }]);
      expect(findings).toHaveLength(1);
      expect(findings[0].issueNumber).toBe(2);
      expect(findings[0].category).toBe('dialogue');
      expect(findings[0].problem).toMatch(/said-bookism/);
      expect(findings[0].anchorQuote).toContain('expostulated');
    });

    it('flags a non-speech action used as a tag with distinct wording', () => {
      const findings = run([{ number: 1, content: '"Of course," she smiled.' }]);
      expect(findings).toHaveLength(1);
      expect(findings[0].problem).toMatch(/non-speech action/);
      expect(findings[0].suggestion).toMatch(/action/);
    });

    it('does not flag plain tags or narrated verbs', () => {
      expect(run([{ number: 1, content: '"Hello," she said. The engine growled outside.' }])).toEqual([]);
    });

    it('honors allowWords and maxFindings', () => {
      const sections = [{ number: 1, content: '"A," he opined. "B," she retorted. "C," they interjected.' }];
      expect(run(sections, { allowWords: 'opine, retort, interject' })).toEqual([]);
      expect(run(sections, { maxFindings: 1 })).toHaveLength(1);
    });
  });

  describe('dialogue.attribution-clarity — deterministic check', () => {
    const run = (sections, config = {}) =>
      getCheck(ATTRIBUTION).run({ sections, config, severityDefault: 'low' });
    const bareRun = [
      '"You came back."',
      '"I had to."',
      '"After everything?"',
      '"Especially after everything."',
      '"And now?"',
      '"Now we finish it."',
    ].join('\n');

    it('declares the expected scope / kind / sources', () => {
      const c = getCheck(ATTRIBUTION);
      expect(c.kind).toBe('deterministic');
      expect(c.scope).toBe('issue');
      expect(c.category).toBe('dialogue');
      expect(c.sources).toEqual(['manuscript']);
      expect(c.needsManuscript).toBe(true);
    });

    it('flags a long untagged run and anchors it to the run start', () => {
      const findings = run([{ number: 4, content: bareRun }]);
      expect(findings).toHaveLength(1);
      expect(findings[0].issueNumber).toBe(4);
      expect(findings[0].category).toBe('dialogue');
      expect(findings[0].problem).toMatch(/no speech tag or action beat/);
      expect(findings[0].anchorQuote).toBe('"You came back."');
    });

    it('does not flag a short exchange below the default threshold', () => {
      expect(run([{ number: 1, content: '"Hi."\n"Hello."\n"Bye."' }])).toEqual([]);
    });

    it('honors a custom minRun', () => {
      const findings = run([{ number: 1, content: '"A."\n"B."\n"C."' }], { minRun: 3 });
      expect(findings).toHaveLength(1);
    });
  });

  describe('dialogue.on-the-nose — LLM check', () => {
    const wholeCtx = (overrides = {}) => ({
      manuscript: '# Issue 1\n\n"I am angry at you for leaving me," she said.',
      config: { maxFindings: 12 },
      severityDefault: 'low',
      planManuscriptChunks: async () => ['# Issue 1\n\n"I am angry at you for leaving me," she said.'],
      callStagedLLM: async () => ({ content: { findings: [] } }),
      ...overrides,
    });

    it('is registered as a manuscript LLM check with category dialogue', () => {
      const c = getCheck(ON_THE_NOSE);
      expect(c.kind).toBe('llm');
      expect(c.scope).toBe('issue');
      expect(c.category).toBe('dialogue');
      expect(c.needsManuscript).toBe(true);
      expect(c.sources).toEqual(['manuscript']);
    });

    it('passes the corpus to the model and normalizes findings to the dialogue category', async () => {
      const ctx = wholeCtx({
        callStagedLLM: async (_stage, vars) => {
          expect(vars.manuscript).toContain('angry');
          return { content: { findings: [{ severity: 'medium', issueNumber: 1, problem: 'on the nose', anchorQuote: 'I am angry' }] } };
        },
      });
      const findings = await getCheck(ON_THE_NOSE).run(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('dialogue');
      expect(findings[0].issueNumber).toBe(1);
    });

    it('stamps a recognized subtype on each finding (#1626)', async () => {
      const ctx = wholeCtx({
        callStagedLLM: async () => ({
          content: { findings: [{ severity: 'low', subtype: 'emotion-tell', issueNumber: 1, problem: 'names the feeling', anchorQuote: 'I am angry' }] },
        }),
      });
      const findings = await getCheck(ON_THE_NOSE).run(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0].subtype).toBe('emotion-tell');
    });

    it('drops an off-list subtype to null (#1626)', async () => {
      const ctx = wholeCtx({
        callStagedLLM: async () => ({
          content: { findings: [{ severity: 'low', subtype: 'made-up-label', issueNumber: 1, problem: 'on the nose', anchorQuote: 'I am angry' }] },
        }),
      });
      const findings = await getCheck(ON_THE_NOSE).run(ctx);
      expect(findings[0].subtype).toBeNull();
    });

    it('defaults subtype to null when the model omits it (#1626)', async () => {
      const ctx = wholeCtx({
        callStagedLLM: async () => ({
          content: { findings: [{ severity: 'low', issueNumber: 1, problem: 'on the nose', anchorQuote: 'I am angry' }] },
        }),
      });
      const findings = await getCheck(ON_THE_NOSE).run(ctx);
      expect(findings[0].subtype).toBeNull();
    });

    it('only declares the three documented subtypes', () => {
      expect(ON_THE_NOSE_SUBTYPES).toEqual(['exposition', 'emotion-tell', 'relationship-report']);
    });
  });

  describe('dialogue.voice-distinctiveness — LLM check', () => {
    const canon = { characters: [{ name: 'Mara', speechPattern: 'clipped, profane' }, { name: 'Joss', speechAccent: 'formal Edwardian' }] };
    const wholeCtx = (overrides = {}) => ({
      manuscript: '# Issue 1\n\n"We go now," said Mara. "Indeed we shall," said Joss.',
      canon,
      config: { maxFindings: 12 },
      severityDefault: 'medium',
      planManuscriptChunks: async () => ['# Issue 1\n\nlines'],
      callStagedLLM: async () => ({ content: { findings: [] } }),
      ...overrides,
    });

    it('is registered as a manuscript+canon LLM check with category dialogue', () => {
      const c = getCheck(VOICE);
      expect(c.kind).toBe('llm');
      expect(c.scope).toBe('series');
      expect(c.category).toBe('dialogue');
      expect(c.needsManuscript).toBe(true);
      expect(c.sources).toEqual(expect.arrayContaining(['manuscript', 'canon']));
      expect(c.severityDefault).toBe('medium');
    });

    it('feeds the authored voice profiles alongside the manuscript', async () => {
      let seenVars = null;
      const ctx = wholeCtx({
        callStagedLLM: async (_stage, vars) => {
          seenVars = vars;
          return { content: { findings: [{ severity: 'high', issueNumber: 1, problem: 'interchangeable', anchorQuote: 'We go now' }] } };
        },
      });
      const findings = await getCheck(VOICE).run(ctx);
      expect(seenVars.voiceProfiles).toContain('Mara');
      expect(seenVars.voiceProfiles).toContain('clipped, profane');
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('dialogue');
      // A check that doesn't declare subtypes carries a clean null (#1626).
      expect(findings[0].subtype).toBeNull();
    });
  });

  describe('characterVoiceProfiles helper', () => {
    it('renders only characters carrying a voice field', () => {
      const out = characterVoiceProfiles({
        characters: [
          { name: 'Mara', speechPattern: 'clipped, profane' },
          { name: 'Joss', speechAccent: 'formal Edwardian' },
          { name: 'Extra' }, // no voice fields → omitted
        ],
      });
      expect(out).toContain('Authored character voices');
      expect(out).toContain('Mara — speech pattern: clipped, profane');
      expect(out).toContain('Joss — accent/dialect: formal Edwardian');
      expect(out).not.toContain('Extra');
    });

    it('returns "" when no character carries a voice field', () => {
      expect(characterVoiceProfiles({ characters: [{ name: 'A' }, { name: 'B' }] })).toBe('');
      expect(characterVoiceProfiles({})).toBe('');
      expect(characterVoiceProfiles(null)).toBe('');
    });

    it('tolerates malformed characters without throwing', () => {
      expect(() => characterVoiceProfiles({ characters: [null, { speechPattern: 42 }, 'x'] })).not.toThrow();
      expect(characterVoiceProfiles({ characters: [null, { speechPattern: 42 }] })).toBe('');
    });
  });
});

describe('comic-pacing bundle (#1314)', () => {
  const PANEL_RHYTHM = 'comic.panel-rhythm';
  const PAGE_TURN = 'comic.page-turn-beats';
  // The comic-pacing checks read each issue's pages off ctx.issues via the shared
  // `comicLetteringIssues` projection — which prefers an edited `comicPages.pages`
  // split (already panelized) over the generated script. Build pages by panel count.
  const page = (n) => ({ panels: Array.from({ length: n }, (_, i) => ({ description: `p${i}`, caption: '', dialogue: [], sfx: '' })) });
  const issue = (number, counts) => ({ number, stages: { comicPages: { pages: counts.map(page) } } });

  describe('comic.panel-rhythm — deterministic', () => {
    it('is registered as an issue-scoped deterministic pacing check over comicScript.layout', () => {
      const check = getCheck(PANEL_RHYTHM);
      expect(check.kind).toBe('deterministic');
      expect(check.scope).toBe('issue');
      expect(check.category).toBe('pacing');
      // Layout-only source: rhythm reads panel COUNTS, so a text edit must not stale it.
      expect(check.sources).toEqual(['comicScript.layout']);
    });

    it('only runs when at least one issue has comic content', () => {
      const check = getCheck(PANEL_RHYTHM);
      expect(check.gate({ issues: [] })).toBeFalsy();
      expect(check.gate({ issues: undefined })).toBeFalsy();
      expect(check.gate({ issues: [issue(1, [3])] })).toBe(true);
    });

    it('flags splash overuse, overcrowding, and grid monotony, attributing each to its issue', () => {
      const ctx = {
        config: {},
        severityDefault: 'low',
        issues: [issue(3, [1, 1, 3, 12, 4, 4, 4, 4])],
      };
      const findings = getCheck(PANEL_RHYTHM).run(ctx);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.category === 'pacing')).toBe(true);
      expect(findings.every((f) => f.issueNumber === 3)).toBe(true);
      const problems = findings.map((f) => f.problem).join('\n');
      expect(problems).toContain('full-page splashes');
      expect(problems).toContain('12 panels');
      expect(problems).toMatch(/same 4-panel grid/);
    });

    it('honors maxFindings as a hard cap across issues', () => {
      const ctx = {
        config: { maxFindings: 1 },
        severityDefault: 'low',
        issues: [issue(1, [1, 1, 1]), issue(2, [12, 12])],
      };
      const findings = getCheck(PANEL_RHYTHM).run(ctx);
      expect(findings).toHaveLength(1);
    });
  });

  describe('comic.page-turn-beats — LLM', () => {
    it('is registered as an issue-scoped LLM pacing check reading comicScript.pacing + reader-map', () => {
      const check = getCheck(PAGE_TURN);
      expect(check.kind).toBe('llm');
      expect(check.scope).toBe('issue');
      expect(check.category).toBe('pacing');
      expect(check.sources).toEqual(['comicScript.pacing', 'series.arc.readerMap']);
    });

    it('passes each issue page layout + authored reveals to the model and attributes findings to the issue', async () => {
      const seenVars = [];
      const ctx = {
        config: {},
        severityDefault: 'low',
        series: { arc: { readerMap: { beats: [{ kind: 'reveal', note: 'The mentor is the villain' }], cliffhangers: [] } } },
        issues: [issue(7, [1, 3, 2])],
        callStagedLLM: async (_stage, vars) => {
          seenVars.push(vars);
          return { content: { findings: [{ severity: 'medium', location: 'Page 2', problem: 'Reveal exposed early' }] } };
        },
      };
      const findings = await getCheck(PAGE_TURN).run(ctx);
      expect(seenVars[0].pageLayout).toContain('Issue 7 page layout:');
      expect(seenVars[0].authoredReveals).toContain('The mentor is the villain');
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('pacing');
      expect(findings[0].issueNumber).toBe(7);
    });

    it('passes an empty authoredReveals var when the series has no reader-map', async () => {
      let seen = null;
      const ctx = {
        config: {},
        severityDefault: 'low',
        series: {},
        issues: [issue(1, [2, 2])],
        callStagedLLM: async (_stage, vars) => { seen = vars; return { content: { findings: [] } }; },
      };
      await getCheck(PAGE_TURN).run(ctx);
      expect(seen.authoredReveals).toBe('');
    });

    it('stops launching further issue calls once maxFindings is reached', async () => {
      let calls = 0;
      const ctx = {
        config: { maxFindings: 1 },
        severityDefault: 'low',
        series: {},
        issues: [issue(1, [2, 2]), issue(2, [3, 3])],
        callStagedLLM: async () => { calls += 1; return { content: { findings: [{ problem: 'x' }] } }; },
      };
      const findings = await getCheck(PAGE_TURN).run(ctx);
      expect(findings).toHaveLength(1);
      expect(calls).toBe(1);
    });
  });
});

describe('comic.lettering-density — deterministic check (#1313)', () => {
  const COMIC = 'comic.lettering-density';
  // A canonical comic-script page with one over-stuffed balloon (60 words).
  const stuffedScript = `## Page 1

Panel 1
**Description:** A crowded throne room.
**Dialogue:**
- KING: "${Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')}"
`;
  const cleanScript = `## Page 1

Panel 1
**Description:** A quiet field.
**Dialogue:**
- ANYA: "We should go."
`;
  const issue = (number, script) => ({ number, stages: { comicScript: { output: script } } });
  const ctxFor = (issues, config = {}) => ({ issues, config, severityDefault: 'low' });

  it('is a deterministic, issue-scoped check reading the comicScript source', () => {
    const check = getCheck(COMIC);
    expect(check.kind).toBe('deterministic');
    expect(check.scope).toBe('issue');
    expect(check.category).toBe('lettering');
    expect(check.sources).toEqual(['comicScript']);
  });

  it('gate is false with no comic scripts, true when one has content', () => {
    const check = getCheck(COMIC);
    expect(check.gate(ctxFor([]))).toBe(false);
    expect(check.gate(ctxFor([issue(1, '')]))).toBe(false);
    expect(check.gate(ctxFor([issue(1, stuffedScript)]))).toBe(true);
  });

  it('flags an over-stuffed balloon and stamps the issue number + location', () => {
    const findings = getCheck(COMIC).run(ctxFor([issue(7, stuffedScript)]));
    expect(findings.length).toBeGreaterThan(0);
    const balloon = findings.find((f) => f.problem.includes('balloon'));
    expect(balloon).toBeTruthy();
    expect(balloon.category).toBe('lettering');
    expect(balloon.issueNumber).toBe(7);
    expect(balloon.location).toContain('Issue 7');
    expect(balloon.location).toContain('Page 1');
    expect(balloon.severity).toBe('high'); // 60/25 = 2.4×
    expect(balloon.anchorQuote).toContain('word0');
  });

  it('returns no findings for a well-lettered script', () => {
    expect(getCheck(COMIC).run(ctxFor([issue(1, cleanScript)]))).toEqual([]);
  });

  it('honors configured thresholds', () => {
    // cleanScript's single 3-word balloon trips only when the limit drops below 3.
    expect(getCheck(COMIC).run(ctxFor([issue(1, cleanScript)], { maxWordsPerBalloon: 2 })))
      .not.toEqual([]);
  });

  it('skips issues without a comic script and scans in issue-number order', () => {
    const findings = getCheck(COMIC).run(ctxFor([issue(2, stuffedScript), issue(1, ''), issue(3, stuffedScript)]));
    const issueNums = [...new Set(findings.map((f) => f.issueNumber))];
    expect(issueNums).toEqual([2, 3]);
  });

  // The edited comicPages split is the source of truth once a script is split —
  // edits there never flow back to comicScript.output, so the check must read it.
  const overflowBalloon = { dialogue: [{ character: 'KING', line: Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ') }] };
  const cleanBalloon = { dialogue: [{ character: 'ANYA', line: 'Short line.' }] };
  const withPages = (number, script, panels) => ({
    number,
    stages: { comicScript: { output: script }, comicPages: { pages: [{ panels }] } },
  });

  it('reads the edited comicPages split when present (it wins over comicScript.output)', () => {
    // The raw script is clean, but the EDITED page added an over-stuffed balloon —
    // the check must flag it (reading comicPages), not pass on the stale script.
    const findings = getCheck(COMIC).run(ctxFor([withPages(5, cleanScript, [overflowBalloon])]));
    expect(findings.some((f) => f.problem.includes('balloon'))).toBe(true);
    expect(findings[0].issueNumber).toBe(5);
  });

  it('does NOT flag when the edited pages are clean even if the stale script was stuffed', () => {
    // The user edited the over-stuffed script down to a clean page — no finding.
    expect(getCheck(COMIC).run(ctxFor([withPages(5, stuffedScript, [cleanBalloon])]))).toEqual([]);
  });

  it('gate is true when only an edited comicPages split exists (no script output)', () => {
    const ctx = ctxFor([{ number: 5, stages: { comicPages: { pages: [{ panels: [overflowBalloon] }] } } }]);
    expect(getCheck(COMIC).gate(ctx)).toBe(true);
    expect(getCheck(COMIC).run(ctx).length).toBeGreaterThan(0);
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
