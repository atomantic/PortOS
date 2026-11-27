import './checkRegistry.test.fixture.js';
import { describe, it, expect } from 'vitest';
import {
  getCheck,
  authoredSetupPayoffSummary,
  authoredPayoffsSummary,
  authoredCliffhangerSummary,
  plotlineCoverageSummary,
  conflictIntensityTally,
  secondaryCharacterPresenceSummary,
  declaredThemesSummary,
  canonCharacterStatesSummary,
  canonCharacterTraitsSummary,
  continuityLedgerSummary,
} from './checkRegistry.js';

const CHEKHOV = 'chekhov.setups-payoffs';

const ENDINGS_CLIFF = 'endings.cliffhanger';

const POV_SWITCH = 'endings.pov-switch';

const PLOT_STRUCTURE = 'plot.structure-momentum';

const PACING_ESCALATION = 'pacing.escalation-curve';

const THEME_COHERENCE = 'theme.coherence';

const TIMELINE_CONTRADICTION = 'continuity.timeline-contradiction';

const CHARACTER_CONSISTENCY = 'character.consistency';

const CLIMAX_AGENCY = 'arc.climax-agency';

const REACTION_PROPORTIONALITY = 'emotion.reaction-proportionality';

const SECONDARY_ARC = 'character.secondary-arc';

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

  it('passes the manuscript, scene map, plotline coverage, and authored setups to the model and forces the plot category', async () => {
    let seenVars = null;
    const ctx = wholeCtx({
      series: { arc: { readerMap: { hooks: [{ label: 'Where is the brother?', note: 'planted Issue 1' }], payoffs: [] } } },
      planManuscriptChunks: async (_stage, opts) => {
        // Scene map + plotline coverage + authored setups all ride as trimmable context (#1459).
        expect(opts.context).toHaveProperty('sceneMap');
        expect(opts.context).toHaveProperty('plotlineMap');
        expect(opts.context).toHaveProperty('authoredSetups');
        expect(opts.fixedOverheadTokens).toBe(2_750);
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

  it('normalizes and deduplicates an anchored repeated-tactic finding across manuscript parts', async () => {
    let calls = 0;
    const rawFinding = {
      severity: 'medium',
      issueNumber: 7,
      location: 'Stalled scene — the kitchen appeal',
      problem: 'Mara repeats the same appeal after each refusal, so neither tactic nor leverage changes.',
      suggestion: 'Have Mara produce the receipt, forcing Ivo to choose between exposure and cooperation.',
      anchorQuote: 'You have to trust me this time.',
    };
    const ctx = wholeCtx({
      config: { maxFindings: 2 },
      planManuscriptChunks: async () => [
        '# Issue 7\n\nYou have to trust me this time.',
        '# Issue 7\n\nI am asking you again to trust me.',
      ],
      callStagedLLM: async () => {
        calls += 1;
        return { content: { findings: [rawFinding] } };
      },
    });

    const findings = await getCheck(PLOT_STRUCTURE).run(ctx);

    expect(findings).toEqual([{
      ...rawFinding,
      category: 'plot',
      subtype: null,
    }]);
    expect(calls).toBe(2);
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
    expect(check.sources).toEqual(['manuscript', 'canon', 'reverseOutline', 'series.characterArcs', 'series.characterArcs.evolution']);
    expect(check.needsManuscript).toBe(true);
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

  it('surfaces authored character-framework fields for arc reconciliation (#2175)', () => {
    const out = canonCharacterTraitsSummary({ characters: [
      { name: 'Vale', lie: 'I only matter if I win', want: 'seize command', need: 'I matter regardless', arcType: 'positive' },
    ] });
    expect(out).toContain('believes (Lie): I only matter if I win');
    expect(out).toContain('wants: seize command');
    expect(out).toContain('needs (Truth): I matter regardless');
    expect(out).toContain('declared arc: positive');
  });

  it('omits framework fields that are absent (pre-#2175 records)', () => {
    const out = canonCharacterTraitsSummary({ characters: [
      { name: 'Legacy', personality: 'stoic' },
    ] });
    expect(out).toContain('personality: stoic');
    expect(out).not.toContain('believes (Lie)');
    expect(out).not.toContain('declared arc');
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
    expect(check.sources).toEqual(['manuscript', 'reverseOutline', 'series.arc.readerMap', 'series.arc.themes', 'series.characterArcs.evolution']);
    expect(check.needsManuscript).toBe(true);
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
    expect(check.sources).toEqual(['manuscript', 'reverseOutline', 'canon', 'series.characterArcs.evolution']);
    expect(check.needsManuscript).toBe(true);
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
    expect(check.sources).toEqual(['manuscript', 'reverseOutline', 'series.characterArcs', 'series.characterArcs.evolution']);
    expect(check.needsManuscript).toBe(true);
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
