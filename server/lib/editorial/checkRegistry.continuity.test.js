import { NAMING, INFODUMP } from './checkRegistry.test.fixture.js';
import { describe, it, expect } from 'vitest';
import {
  getCheck,
  editorialPriorFindingsDigest,
  EDITORIAL_PRIOR_DIGEST_MAX,
  EDITORIAL_PRIOR_DIGEST_CHARS,
  editorialSetupDigest,
  buildSetupDigestPrompt,
  EDITORIAL_SETUP_DIGEST_BODY_CHARS,
  EDITORIAL_SETUP_DIGEST_CHARS,
  EDITORIAL_SETUP_DIGEST_SOURCE,
  canonRosterNamesSummary,
  proseStageIssues,
  renderComicForProseSync,
  proseSyncPairs,
  PROSE_SYNC_PROSE_CHAR_CAP,
} from './checkRegistry.js';

const UNMODELED_NAMES = 'roster.unmodeled-names';

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
      planManuscriptChunks: async (_stage, opts) => { sawObjectsContext = Object.hasOwn(opts.context || {}, 'objects'); return ['chunk a', 'chunk b']; },
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
      planManuscriptChunks: async (_stage, opts) => { sawObjectsContext = Object.hasOwn(opts.context || {}, 'objects'); return ['chunk a', 'chunk b']; },
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
