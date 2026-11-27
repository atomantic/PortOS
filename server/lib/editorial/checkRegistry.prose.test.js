import { INFODUMP } from './checkRegistry.test.fixture.js';
import { describe, it, expect } from 'vitest';
import {
  getCheck,
  listChecks,
  sceneGroundingSummary,
  characterVoiceProfiles,
  intendedVoiceSummary,
  scenePovSummary,
} from './checkRegistry.js';

const INTERIORITY = 'interiority.protagonist';

const SENSORY_BALANCE = 'sensory.balance';

const WHITE_ROOM = 'scene.white-room';

const INTERIORITY_BALANCE = 'scene.interiority-balance';

const SUMMARY_NOT_SCENE = 'narration.summary-not-scene';

const REPORTED_SPEECH = 'dialogue.reported-speech';

const INTERIORITY_REGISTER = 'interiority.register';

const HEAD_HOPPING = 'pov.head-hopping';

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

describe('narration.summary-not-scene — summary-vs-scene LLM check (#3591)', () => {
  const MANUSCRIPT = '# Issue 1\n\nOver the next week they argued about it, and eventually she agreed to go.';
  const wholeCtx = (overrides = {}) => ({
    manuscript: MANUSCRIPT,
    reverseOutline: [{ sequence: 0, issueNumber: 1, heading: 'The void', setting: '', charactersPresent: ['Mara'] }],
    config: { maxFindings: 12 },
    severityDefault: 'medium',
    planManuscriptChunks: async () => [overrides.manuscript ?? MANUSCRIPT],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as an issue-scoped manuscript+reverseOutline LLM check in the pacing category', () => {
    const check = getCheck(SUMMARY_NOT_SCENE);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('issue');
    expect(check.category).toBe('pacing');
    expect(check.severityDefault).toBe('medium');
    expect(check.defaultEnabled).toBe(true);
    expect(check.needsManuscript).toBe(true);
    expect(check.sources).toEqual(expect.arrayContaining(['manuscript', 'reverseOutline']));
  });

  it('injects the scene map into the prompt vars and stamps findings with the pacing category', async () => {
    let seenVars = null;
    let seenOverhead = 0;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // The scene map rides as trimmable context (#1459); the fixed template
        // reserve is passed separately and must be budgeted, or a long manuscript
        // plans chunks that overflow the provider window once the prompt is added.
        seenOverhead = opts.fixedOverheadTokens;
        expect(opts.context).toHaveProperty('sceneMap');
        return [MANUSCRIPT];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return {
          content: {
            findings: [{
              severity: 'medium',
              issueNumber: 1,
              location: 'Issue 1 — compressed turning point',
              problem: 'The decision to go is narrated instead of played out.',
              suggestion: 'Zoom into the argument where she changes her mind.',
              anchorQuote: 'Over the next week they argued about it',
            }],
          },
        };
      },
    });
    const findings = await getCheck(SUMMARY_NOT_SCENE).run(ctx);
    expect(seenVars.sceneMap).toContain('Issue 1: The void');
    expect(seenVars.manuscript).toBe(MANUSCRIPT);
    expect(seenOverhead).toBeGreaterThan(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('pacing');
    expect(findings[0].issueNumber).toBe(1);
    // The anchor is a verbatim slice of the manuscript so the editor can jump to it.
    expect(MANUSCRIPT).toContain(findings[0].anchorQuote);
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
    await getCheck(SUMMARY_NOT_SCENE).run(ctx);
    expect(seenVars.sceneMap).toBe('');
  });

  it('returns no findings for an already-dramatized manuscript', async () => {
    const findings = await getCheck(SUMMARY_NOT_SCENE).run(wholeCtx());
    expect(findings).toEqual([]);
  });

  it('respects maxFindings as a whole-run cap', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ severity: 'medium', problem: `p${i}`, anchorQuote: `a${i}` }));
    const ctx = wholeCtx({
      config: { maxFindings: 4 },
      callStagedLLM: async () => ({ content: { findings: many } }),
    });
    const findings = await getCheck(SUMMARY_NOT_SCENE).run(ctx);
    expect(findings).toHaveLength(4);
  });
});

describe('dialogue.reported-speech — reported-speech LLM check (#3592)', () => {
  const MANUSCRIPT = '# Issue 1\n\nThey argued about the money for an hour, and in the end she told him she was leaving.';
  const wholeCtx = (overrides = {}) => ({
    manuscript: MANUSCRIPT,
    config: { maxFindings: 12 },
    severityDefault: 'low',
    planManuscriptChunks: async () => [overrides.manuscript ?? MANUSCRIPT],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as an issue-scoped manuscript LLM check in the dialogue category', () => {
    const check = getCheck(REPORTED_SPEECH);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('issue');
    expect(check.category).toBe('dialogue');
    expect(check.severityDefault).toBe('low');
    expect(check.defaultEnabled).toBe(true);
    expect(check.needsManuscript).toBe(true);
    expect(check.sources).toEqual(['manuscript']);
  });

  it('budgets the fixed prompt overhead when planning chunks and stamps findings with the dialogue category', async () => {
    let seenVars = null;
    let seenOverhead = 0;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // No trimmable context rides along, so the template reserve is passed as
        // `overheadTokens` — unbudgeted, a long manuscript plans chunks that
        // overflow the provider window once the prompt is added.
        seenOverhead = opts.overheadTokens;
        return [MANUSCRIPT];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return {
          content: {
            findings: [{
              severity: 'low',
              issueNumber: 1,
              location: 'Issue 1 — the money argument',
              problem: 'The confrontation is narrated instead of quoted.',
              suggestion: 'Quote the moment she says she is leaving.',
              anchorQuote: 'she told him she was leaving',
            }],
          },
        };
      },
    });
    const findings = await getCheck(REPORTED_SPEECH).run(ctx);
    expect(seenOverhead).toBeGreaterThan(0);
    expect(seenVars.manuscript).toBe(MANUSCRIPT);
    // Manuscript-only check — no scene map rides along.
    expect(seenVars.sceneMap).toBeUndefined();
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('dialogue');
    expect(findings[0].issueNumber).toBe(1);
    expect(findings[0].suggestion).toContain('Quote the moment');
    // The anchor is a verbatim slice of the manuscript so the editor can jump to it.
    expect(MANUSCRIPT).toContain(findings[0].anchorQuote);
  });

  it('returns no findings for a manuscript whose decisive beats are already quoted', async () => {
    const findings = await getCheck(REPORTED_SPEECH).run(wholeCtx({
      manuscript: '# Issue 1\n\n"I\'m leaving," she said.',
    }));
    expect(findings).toEqual([]);
  });

  it('respects maxFindings as a whole-run cap', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ severity: 'low', problem: `p${i}`, anchorQuote: `a${i}` }));
    const ctx = wholeCtx({
      config: { maxFindings: 4 },
      callStagedLLM: async () => ({ content: { findings: many } }),
    });
    const findings = await getCheck(REPORTED_SPEECH).run(ctx);
    expect(findings).toHaveLength(4);
  });
});

describe('interiority.register — interiority-register LLM check (#3593)', () => {
  // A plain-spoken character whose dialogue and whose rendered thought sit in two
  // different registers — the strongest signal the prompt asks the model for.
  const MANUSCRIPT = '# Issue 1\n\n"Ain\'t no way," Dell said. "Not for that money."\n\nI thought: this represents a supreme opportunity, one whose implications I would do well to consider.';
  const wholeCtx = (overrides = {}) => ({
    manuscript: MANUSCRIPT,
    config: { maxFindings: 12 },
    severityDefault: 'low',
    planManuscriptChunks: async () => [overrides.manuscript ?? MANUSCRIPT],
    callStagedLLM: async () => ({ content: { findings: [] } }),
    ...overrides,
  });

  it('is registered as an issue-scoped manuscript LLM check in the style category', () => {
    const check = getCheck(INTERIORITY_REGISTER);
    expect(check.kind).toBe('llm');
    expect(check.scope).toBe('issue');
    expect(check.category).toBe('style');
    expect(check.severityDefault).toBe('low');
    expect(check.defaultEnabled).toBe(true);
    expect(check.needsManuscript).toBe(true);
    expect(check.sources).toEqual(['manuscript']);
  });

  it('budgets the fixed prompt overhead when planning chunks and stamps findings with the style category', async () => {
    let seenVars = null;
    let seenOverhead = 0;
    const ctx = wholeCtx({
      planManuscriptChunks: async (_stage, opts) => {
        // No trimmable context rides along, so the template reserve is passed as
        // `overheadTokens` — unbudgeted, a long manuscript plans chunks that
        // overflow the provider window once the prompt is added.
        seenOverhead = opts.overheadTokens;
        return [MANUSCRIPT];
      },
      callStagedLLM: async (_stage, vars) => {
        seenVars = vars;
        return {
          content: {
            findings: [{
              severity: 'low',
              issueNumber: 1,
              location: 'Issue 1 — Dell at the table',
              problem: 'Dell speaks in clipped fragments but thinks in balanced essay prose.',
              suggestion: 'Let him think in the same blunt vocabulary he argues in.',
              anchorQuote: 'I thought: this represents a supreme opportunity',
            }],
          },
        };
      },
    });
    const findings = await getCheck(INTERIORITY_REGISTER).run(ctx);
    expect(seenOverhead).toBeGreaterThan(0);
    expect(seenVars.manuscript).toBe(MANUSCRIPT);
    // Manuscript-only check — no scene map or canon voice profiles ride along.
    expect(seenVars.sceneMap).toBeUndefined();
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('style');
    expect(findings[0].issueNumber).toBe(1);
    // The mismatch against how the character SPEAKS is what the finding must cite.
    expect(findings[0].problem).toContain('speaks');
    // The anchor is a verbatim slice of the manuscript so the editor can jump to it.
    expect(MANUSCRIPT).toContain(findings[0].anchorQuote);
  });

  it('returns no findings for a consistently erudite POV character (no false positive on characterized formality)', async () => {
    const findings = await getCheck(INTERIORITY_REGISTER).run(wholeCtx({
      manuscript: '# Issue 1\n\n"The implications are considerable," Dr. Aurel said. "One hesitates to speculate."\n\nOne hesitates, she thought. One always hesitates, and the hesitation is the diagnosis.',
    }));
    expect(findings).toEqual([]);
  });

  it('respects maxFindings as a whole-run cap', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ severity: 'low', problem: `p${i}`, anchorQuote: `a${i}` }));
    const ctx = wholeCtx({
      config: { maxFindings: 4 },
      callStagedLLM: async () => ({ content: { findings: many } }),
    });
    const findings = await getCheck(INTERIORITY_REGISTER).run(ctx);
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
