/**
 * The five-stage evolution lens inside the existing character-arc checks (#6442).
 *
 * Two things this pins that no other suite can:
 *   1. With the lens UNSET, all five checks build byte-identical prompt
 *      variables to the pre-change baseline. The expected strings below were
 *      captured by running these same checks on the commit before the lens was
 *      threaded — they are a snapshot of the OLD behavior, not a restatement of
 *      the new code, so a lens change that perturbs `characterArcs`, `sceneMap`,
 *      `canonTraits`, `secondaryCast`, `authoredPayoffs` or `declaredThemes`
 *      fails here instead of silently changing what every review sees.
 *   2. With the lens AUTHORED, each check receives the declared outcome, the
 *      staged causal chain, and an honest evidence verdict — including the stale
 *      pointer that must never read as proof.
 */
import { describe, it, expect } from 'vitest';

import { getCheck } from '../checkRegistry.js';

const LENS_CHECKS = [
  'character.consistency',
  'character.secondary-arc',
  'arc.transitions',
  'arc.regression',
  'arc.climax-agency',
];

const MANUSCRIPT = '# Issue 1 — Ashfall (prose)\n\nMara struck the match and let the bridge burn.';

const arcs = (evolution) => [{
  characterId: 'chr-mara',
  characterName: 'Mara',
  want: 'revenge',
  need: 'to forgive',
  startState: 'hardened',
  endState: 'open',
  transitions: [{ id: 'trn-burn', kind: 'point-of-no-return', label: 'burns the bridge', atIssue: 1 }],
  ...(evolution ? { evolution } : {}),
}];

const runCheck = async (id, { evolution = null } = {}) => {
  let vars = null;
  await getCheck(id).run({
    manuscript: MANUSCRIPT,
    series: {
      characterArcs: arcs(evolution),
      arc: { readerMap: { payoffs: [{ label: 'Mara forgives', atIssue: 1 }] }, themes: ['forgiveness'] },
    },
    reverseOutline: [{
      sequence: 0,
      issueNumber: 1,
      heading: 'The bridge',
      setting: 'a rope bridge',
      povCharacter: 'Mara',
      charactersPresent: ['Mara', 'Joss'],
    }],
    canon: { characters: [{ id: 'chr-mara', name: 'Mara', personality: 'guarded', mannerisms: 'taps her ring' }] },
    config: { maxFindings: 12, minScenes: 2 },
    severityDefault: 'medium',
    planManuscriptChunks: async () => [MANUSCRIPT],
    callStagedLLM: async (_stage, v) => { vars = v; return { content: { findings: [] } }; },
  });
  return vars;
};

// Captured from the pre-#6442 checks against the fixture above.
const CANON_TRAITS = 'Canon character traits (the established bible — a shift away from these must be earned on the page):\n- Mara — personality: guarded; mannerisms: taps her ring';
const SCENE_MAP = 'Scenes (from the reverse outline):\n- Issue 1: The bridge — setting: a rope bridge — present: Mara, Joss';
const CHARACTER_ARCS = '- Mara; wants: revenge; needs: to forgive; starts: hardened; ends: open\n    • point-of-no-return (issue 1): burns the bridge';

const BASELINE_VARS = {
  'character.consistency': {
    manuscript: MANUSCRIPT,
    canonTraits: CANON_TRAITS,
    sceneMap: SCENE_MAP,
    characterArcs: CHARACTER_ARCS,
  },
  'character.secondary-arc': {
    manuscript: MANUSCRIPT,
    secondaryCast: '',
    canonRoster: 'Known characters (already in the story bible — do NOT flag these or their aliases):\n- Mara',
    canonTraits: CANON_TRAITS,
    finalPart: 'true',
  },
  'arc.transitions': {
    manuscript: MANUSCRIPT,
    sceneMap: SCENE_MAP,
    characterArcs: CHARACTER_ARCS,
  },
  'arc.regression': {
    manuscript: MANUSCRIPT,
    characterArcs: CHARACTER_ARCS,
    sceneMap: SCENE_MAP,
    finalPart: 'true',
  },
  'arc.climax-agency': {
    manuscript: MANUSCRIPT,
    authoredPayoffs: 'Authored payoffs (resolutions the writer logged — what the reader was promised):\n- Mara forgives',
    declaredThemes: 'Declared themes (authored on the story arc):\n- forgiveness',
    sceneMap: SCENE_MAP,
    finalPart: 'true',
  },
};

describe('character-arc checks — five-stage evolution lens (#6442)', () => {
  it.each(LENS_CHECKS)('%s reproduces the pre-lens prompt variables when no lens is authored', async (id) => {
    const vars = await runCheck(id);
    expect(vars).toEqual({ ...BASELINE_VARS[id], characterEvolution: '' });
  });

  it.each(LENS_CHECKS)('%s carries the declared outcome and the staged chain when a lens is authored', async (id) => {
    const vars = await runCheck(id, {
      evolution: {
        outcome: 'tragic-refusal',
        outcomeNote: 'she chooses the grudge',
        stages: [
          { stageId: 'control-strategy-failing', testedBelief: 'only force keeps her safe' },
          { stageId: 'cost-tested', causalConsequence: 'she loses Joss', evidence: { transitionId: 'trn-burn' } },
          { stageId: 'final-proof', characterChoice: 'walks away armed', evidence: { transitionId: 'trn-deleted' } },
        ],
      },
    });
    // The declaration is the part that must not read as a gap downstream.
    expect(vars.characterEvolution).toContain('- Mara');
    expect(vars.characterEvolution).toContain('declared outcome: tragic-refusal — she chooses the grudge');
    expect(vars.characterEvolution).toContain('belief under test: only force keeps her safe');
    // Evidence honesty: the live beat resolves, the deleted one cannot pass as proof.
    expect(vars.characterEvolution).toContain('cost tested: consequence: she loses Joss; evidence: transition trn-burn [anchored]');
    expect(vars.characterEvolution).toContain('evidence: transition trn-deleted [stale]');
    // Threading the lens must not disturb anything the check already sent.
    const { characterEvolution: _lens, ...rest } = vars;
    expect(rest).toEqual(BASELINE_VARS[id]);
  });

  it.each(LENS_CHECKS)('%s declares the lens source token so a lens edit can stale its findings', (id) => {
    expect(getCheck(id).sources).toContain('series.characterArcs.evolution');
  });

  it('renders an undeclared lens as undeclared rather than inventing an outcome', async () => {
    // `isDeclaredEvolution` is false here; the prompt must say so, because an
    // unfinished plan is not a declared flat/tragic ending.
    const vars = await runCheck('arc.transitions', {
      evolution: { stages: [{ stageId: 'commitment-to-change', characterChoice: 'burns it' }] },
    });
    expect(vars.characterEvolution).toContain('declared outcome: undeclared');
    expect(vars.characterEvolution).toContain('commitment to change: choice: burns it');
  });
});
