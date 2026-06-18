import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  EDITORIAL_CHECKS,
  EDITORIAL_SOURCES,
  CHECK_SCOPES,
  CHECK_KINDS,
  getCheck,
  listChecks,
  assertValidChecks,
  resolveCheckConfig,
  resolveCheckState,
  getEnabledChecks,
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
} from './checkRegistry.js';

const NAMING = 'naming.dissimilar-names';
const INFODUMP = 'prose.info-dumping';

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

  it('counts appearances via aliases, attributing to the canonical name', () => {
    const findings = runRoster(
      [{ name: 'Robert', aliases: ['Bob'] }, { name: 'Aria' }],
      [sec(1, 'Bob arrived.'), sec(2, 'Aria stayed; Aria thought of him.')],
    );
    // Robert appears only via "Bob" in issue 1 → throwaway, named as Robert.
    const tw = throwaways(findings);
    expect(tw.some((f) => /"Robert"/.test(f.problem))).toBe(true);
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
    let overhead = null;
    const objectsSeen = [];
    await getCheck('objects.unmotivated-interaction').run(baseCtx({
      planManuscriptChunks: async (_stage, opts) => { overhead = opts.overheadTokens; return ['chunk a', 'chunk b']; },
      callStagedLLM: async (_stage, v) => { objectsSeen.push(v.objects); return { content: { findings: [] } }; },
    }));
    // Overhead exceeds the fixed template reserve because the objects summary is counted in.
    expect(overhead).toBeGreaterThan(0);
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
        overhead = opts.overheadTokens;
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
