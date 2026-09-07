import { describe, expect, it } from 'vitest';

import {
  analyzeCharacterEvolutionCoverage,
  EVOLUTION_COVERAGE_CODES,
} from './characterEvolutionCoverage.js';
import { analyzeLoomPlaythroughs, FABLELOOM_PLAYTEST_LIMITS } from './fableLoomPlaytest.js';

const EPISODE_ID = 'ep-00000000-0000-4000-8000-000000000001';

const scene = (id, title, targets, extra = {}) => ({
  id,
  title,
  playbackMode: targets.length > 1 ? 'decision' : 'cut',
  audienceConnection: 'connected',
  isEnding: false,
  transitions: targets.map((targetNodeId) => ({
    id: `${id}-to-${targetNodeId}`,
    targetNodeId,
    intent: `Go to ${targetNodeId}`,
  })),
  ...extra,
});

const ending = (id, title, endingLabel) => ({
  id,
  title,
  playbackMode: 'cut',
  audienceConnection: 'connected',
  isEnding: true,
  endingLabel,
  transitions: [],
});

/**
 * Two branches that reconverge — the exact graph the epic's sharpest
 * requirement is about. `opening` splits into `left` / `right`, both rejoin at
 * `merge`, and `merge` runs to the single ending.
 */
const reconvergingEpisode = (id = EPISODE_ID) => ({
  id,
  number: 1,
  title: 'The Divided Signal',
  startNodeId: 'opening',
  nodes: [
    scene('opening', 'The Split', ['left', 'right']),
    scene('left', 'Glass Bridge', ['merge']),
    scene('right', 'Buried Wire', ['merge']),
    scene('merge', 'The Junction', ['finale']),
    ending('finale', 'The Beacon', 'Signal found'),
  ],
});

/** Two branches that never rejoin, ending separately. */
const forkingEpisode = () => ({
  id: EPISODE_ID,
  number: 1,
  title: 'Two Roads',
  startNodeId: 'opening',
  nodes: [
    scene('opening', 'The Split', ['left', 'right']),
    scene('left', 'Glass Bridge', ['ending-a']),
    scene('right', 'Buried Wire', ['ending-b']),
    ending('ending-a', 'The Beacon', 'Signal found'),
    ending('ending-b', 'The Silence', 'Signal lost'),
  ],
});

// The sanitized shape `sanitizeCharacterEvolutionList` persists, built by hand
// so this stays a pure-lib test with no record store behind it.
const stage = (stageId, sceneKey, episodeId = EPISODE_ID) => ({
  stageId,
  testedBelief: 'Control is safety.',
  externalPressure: '',
  characterChoice: '',
  causalConsequence: '',
  evidence: sceneKey === null && episodeId === null
    ? null
    : {
      atIssue: null,
      atSceneAnchor: '',
      transitionId: '',
      episodeId: episodeId || '',
      sceneKey: sceneKey || '',
    },
});

const loomWith = (episodes, stages, outcome = 'full-change') => ({
  id: 'loom-example',
  name: 'Example Story',
  participationMode: 'protagonist',
  episodes,
  seriesPlan: {
    storyArc: '',
    plotPoints: [],
    sideQuests: [],
    characterEvolutions: [{
      characterId: 'chr-00000000-0000-4000-8000-0000000000aa',
      characterName: 'Mara',
      evolution: { outcome, outcomeNote: '', stages },
    }],
  },
});

const codes = (report) => report.findings.map((finding) => finding.code);
const findingFor = (report, code) => report.findings.find((finding) => finding.code === code);

describe('analyzeCharacterEvolutionCoverage', () => {
  it('returns null for a loom that never opted into the lens', () => {
    // The optional-lens non-negotiable: an install with no lens must add
    // nothing at all to its diagnostics, not an empty report object.
    const plain = loomWith([reconvergingEpisode()], []);
    delete plain.seriesPlan.characterEvolutions;

    expect(analyzeCharacterEvolutionCoverage(plain)).toBeNull();
    expect(analyzeCharacterEvolutionCoverage({ ...plain, seriesPlan: {} })).toBeNull();
  });

  it('flags a stage proved on only one incoming branch of a reconvergence', () => {
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [reconvergingEpisode()],
      [stage('commitment-to-change', 'left'), stage('final-proof', 'finale')],
    ));

    const finding = findingFor(report, EVOLUTION_COVERAGE_CODES.UNEARNED_INHERITANCE);
    expect(finding).toBeDefined();
    // The convergence scene is named by its stable node id, never by an
    // ephemeral `path-N`, and the message points at the branch that did not
    // earn it so the repair is actionable without re-deriving the graph.
    expect(finding.nodeId).toBe('merge');
    expect(finding.episodeId).toBe(EPISODE_ID);
    expect(finding.stageId).toBe('commitment-to-change');
    expect(finding.message).toContain('Buried Wire');
    expect(finding.remediation).toContain('The Junction');
    // `final-proof` is anchored downstream of the junction, so the story
    // declares that content after it depends on the inherited change.
    expect(finding.severity).toBe('error');
    expect(report.stats.unearnedInheritanceCount).toBe(1);
  });

  it('accepts a stage proved before the branch point as a shared prerequisite', () => {
    // The regression most likely to reappear: an over-eager convergence check
    // that flags every reconvergence, including the legitimate case where the
    // stage was earned before the branches ever split.
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [reconvergingEpisode()],
      [stage('commitment-to-change', 'opening'), stage('final-proof', 'finale')],
    ));

    expect(codes(report)).not.toContain(EVOLUTION_COVERAGE_CODES.UNEARNED_INHERITANCE);
    expect(report.stats.unearnedInheritanceCount).toBe(0);
  });

  it('accepts a stage proved at the convergence itself', () => {
    // Every incoming branch plays that scene, so nothing is inherited — the
    // second shape of the shared-prerequisite case.
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [reconvergingEpisode()],
      [stage('commitment-to-change', 'merge')],
    ));

    expect(codes(report)).not.toContain(EVOLUTION_COVERAGE_CODES.UNEARNED_INHERITANCE);
  });

  it('downgrades an inherited stage with nothing anchored after the convergence', () => {
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [reconvergingEpisode()],
      [stage('commitment-to-change', 'left')],
    ));

    expect(findingFor(report, EVOLUTION_COVERAGE_CODES.UNEARNED_INHERITANCE).severity)
      .toBe('warning');
  });

  it('names the ending a declared full-change never proves', () => {
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [forkingEpisode()],
      [stage('final-proof', 'left')],
    ));

    const finding = findingFor(report, EVOLUTION_COVERAGE_CODES.ENDING_UNPROVEN);
    expect(finding.nodeId).toBe('ending-b');
    expect(finding.message).toContain('Signal lost');
    expect(finding.message).not.toContain('Signal found');
    expect(report.stats.unprovenEndingCount).toBe(1);
  });

  it('never asks a tragic refusal or a flat arc to transform, only to be tested', () => {
    const stages = [stage('control-strategy-failing', 'left'), stage('cost-tested', 'right')];
    for (const outcome of ['tragic-refusal', 'flat-testing']) {
      // Each branch plays one stage, so the belief IS put under test on both —
      // a declared refusal or constancy must produce no finding here.
      const tested = analyzeCharacterEvolutionCoverage(
        loomWith([forkingEpisode()], stages, outcome),
      );
      expect(tested.findings).toEqual([]);
      expect(tested.status).toBe('verified');

      // ...and one branch that never stages the belief at all is still
      // reported, because a refusal the viewer never watched is not earned.
      const untested = analyzeCharacterEvolutionCoverage(loomWith(
        [forkingEpisode()],
        [stage('control-strategy-failing', 'left')],
        outcome,
      ));
      expect(codes(untested)).toEqual([EVOLUTION_COVERAGE_CODES.ENDING_UNPROVEN]);
      expect(findingFor(untested, EVOLUTION_COVERAGE_CODES.ENDING_UNPROVEN).message)
        .toContain('Signal lost');
    }
  });

  it('reports a cyclic graph as unreviewed rather than as a defect', () => {
    const cyclic = {
      id: EPISODE_ID,
      number: 1,
      title: 'The Loop',
      startNodeId: 'opening',
      nodes: [
        scene('opening', 'The Split', ['loop', 'finale']),
        scene('loop', 'The Return', ['opening']),
        ending('finale', 'The Beacon', 'Signal found'),
      ],
    };
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [cyclic],
      [stage('final-proof', 'loop')],
    ));

    expect(report.status).toBe('unreviewed');
    expect(report.findings).toEqual([]);
    expect(report.episodes[0]).toMatchObject({ enumerated: false, reason: 'cycle', pathCount: null });
    expect(report.characters[0].stages[0].provenPathCount).toBeNull();
  });

  it('reports a bounded-out enumeration as unreviewed and reuses the caller report', () => {
    const wide = {
      id: EPISODE_ID,
      number: 1,
      title: 'Wide',
      startNodeId: 'opening',
      nodes: [
        scene('opening', 'The Split', ['left', 'right']),
        scene('left', 'Glass Bridge', ['finale']),
        scene('right', 'Buried Wire', ['finale']),
        ending('finale', 'The Beacon', 'Signal found'),
      ],
    };
    const loom = loomWith([wide], [stage('final-proof', 'left')]);
    const truncated = analyzeLoomPlaythroughs(loom, { maxPaths: 1 });
    expect(truncated.complete).toBe(false);

    const report = analyzeCharacterEvolutionCoverage(loom, { playthroughReport: truncated });

    expect(report.status).toBe('unreviewed');
    expect(report.episodes[0].reason).toBe('variation-limit');
    // Truncated coverage must not manufacture the ending finding a complete
    // enumeration would have produced from the same partial evidence.
    expect(report.findings).toEqual([]);
    expect(analyzeCharacterEvolutionCoverage(loom).status).toBe('findings');
  });

  it('keeps a dead evidence pointer reportable and never satisfied', () => {
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [reconvergingEpisode()],
      [stage('final-proof', 'a-deleted-scene')],
    ));

    const finding = findingFor(report, EVOLUTION_COVERAGE_CODES.EVIDENCE_STALE);
    expect(finding.message).toContain('a-deleted-scene');
    expect(report.characters[0].stages[0]).toMatchObject({
      resolution: 'stale', nodeId: null, provenPathCount: null,
    });
    expect(report.characters[0].status).toBe('unreviewed');
    expect(report.status).toBe('unreviewed');

    // A pointer at an episode that no longer exists is the same class of dead.
    const goneEpisode = analyzeCharacterEvolutionCoverage(loomWith(
      [reconvergingEpisode()],
      [stage('final-proof', 'left', 'ep-00000000-0000-4000-8000-00000000ffff')],
    ));
    expect(goneEpisode.characters[0].status).toBe('unreviewed');
    expect(codes(goneEpisode)).toContain(EVOLUTION_COVERAGE_CODES.EVIDENCE_STALE);
  });

  it('separates "proved on no path" from "never computed"', () => {
    // The sentinel rule: an unreachable-but-live scene is a real zero, and a
    // `null` next to it must mean the analyzer never looked. Collapsing the two
    // is how a partial review starts reading as a clean one.
    const withOrphan = reconvergingEpisode();
    withOrphan.nodes.push(scene('orphan', 'The Cut Scene', ['finale']));
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [withOrphan],
      [stage('final-proof', 'orphan')],
    ));

    expect(report.characters[0].stages[0]).toMatchObject({
      resolution: 'resolved', provenPathCount: 0,
    });
    expect(report.characters[0].stages[0].pathCount).toBeGreaterThan(0);
  });

  it('reports an out-of-sequence anchor instead of silently crediting it', () => {
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [reconvergingEpisode()],
      // The commitment is anchored to the opening, before the scene where the
      // control strategy is shown failing: the path plays the arc backwards.
      [stage('control-strategy-failing', 'merge'), stage('commitment-to-change', 'opening')],
    ));

    const finding = findingFor(report, EVOLUTION_COVERAGE_CODES.STAGE_OUT_OF_ORDER);
    expect(finding.stageId).toBe('commitment-to-change');
    expect(finding.message).toContain('control strategy failing');
    // One finding per stage, not one per enumerated path.
    expect(codes(report).filter((code) => code === finding.code)).toHaveLength(1);
  });

  it('leaves an undeclared lens uncharged for an outcome its author never made', () => {
    const undeclared = analyzeCharacterEvolutionCoverage(loomWith(
      [forkingEpisode()],
      [stage('final-proof', 'left')],
      null,
    ));

    expect(codes(undeclared)).not.toContain(EVOLUTION_COVERAGE_CODES.ENDING_UNPROVEN);
    expect(undeclared.characters[0].outcome).toBeNull();
    // Structural inheritance is still checked — it is a defect regardless of
    // what the author eventually declares.
    const converging = analyzeCharacterEvolutionCoverage(loomWith(
      [reconvergingEpisode()],
      [stage('commitment-to-change', 'left')],
      null,
    ));
    expect(codes(converging)).toContain(EVOLUTION_COVERAGE_CODES.UNEARNED_INHERITANCE);
  });

  it('reports an episode with no expanded scenes as unreviewed', () => {
    const outlineOnly = {
      id: EPISODE_ID,
      number: 1,
      title: 'Planned only',
      startNodeId: null,
      nodes: [],
      storyOutline: { version: 1, startKey: 'beat-1', scenes: [{ key: 'beat-1' }] },
    };
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [outlineOnly],
      [stage('final-proof', 'beat-1')],
    ));

    expect(report.status).toBe('unreviewed');
    expect(report.episodes[0].reason).toBe('no-scenes');
    expect(report.findings).toEqual([]);
  });

  it('stays inside the playthrough limits on a branch-heavy graph', () => {
    // Ten binary decisions is 1024 paths; the analyzer must inherit the
    // harness's bound rather than walking them all.
    const nodes = [];
    for (let level = 0; level < 10; level += 1) {
      nodes.push(scene(`d${level}`, `Decision ${level}`, [`l${level}`, `r${level}`]));
      for (const side of ['l', 'r']) {
        nodes.push(scene(`${side}${level}`, `${side}${level}`, [level === 9 ? 'finale' : `d${level + 1}`]));
      }
    }
    nodes.push(ending('finale', 'The Beacon', 'Signal found'));
    const report = analyzeCharacterEvolutionCoverage(loomWith(
      [{
        id: EPISODE_ID, number: 1, title: 'Wide', startNodeId: 'd0', nodes,
      }],
      [stage('final-proof', 'l0')],
    ));

    expect(report.episodes[0]).toMatchObject({ enumerated: false, reason: 'variation-limit' });
    expect(report.status).toBe('unreviewed');
    expect(FABLELOOM_PLAYTEST_LIMITS.DEFAULT_MAX_PATHS).toBeLessThan(1024);
  });
});
