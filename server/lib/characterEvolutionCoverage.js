/**
 * Branch coverage for the five-stage character evolution lens (#6444, epic #6418).
 *
 * `characterEvolution.js` models what a story DECLARES about a character's
 * transformation. This module asks the branching question that declaration
 * cannot answer on its own: *on the path the viewer actually played*, was the
 * change earned?
 *
 * In a branching story transformation is not one timeline. If the commitment
 * stage is proved only on branch A, and A and B reconverge at a shared scene,
 * then a viewer who played B arrives at that scene inheriting a change they
 * never watched the character earn. That is the sharpest requirement in #6418
 * and nothing else in the codebase detects it.
 *
 * DETERMINISTIC AND PROVIDER-FREE. It is graph analysis over authored data:
 * no LLM call, no boot-time work, no background schedule. It runs from the
 * existing user-triggered review entry point
 * (`collectFableLoomEditorialDiagnostics`).
 *
 * Three rules this module deliberately does NOT break:
 *   - **The lens is optional and never a gate.** A loom with no authored lens
 *     returns `null` — no report, no findings, no stats — so its diagnostics
 *     are byte-identical to a pre-#6444 install's. Findings it does emit are
 *     reported, never folded into any pass/fail contract.
 *   - **A declared flat or tragic arc is not a defect.** `tragic-refusal` and
 *     `flat-testing` are checked for whether the refusal/constancy was TESTED
 *     on each path, never for the absence of a transformation.
 *   - **Partial coverage never reads as a pass.** Bounded-out enumeration, a
 *     cycle, or an anchor that does not resolve produces `unreviewed`, which
 *     is explicitly neither `verified` nor a defect finding.
 *
 * Reuse, not re-implementation: paths come from
 * `enumerateEpisodePlaythroughs` (already bounded by
 * `FABLELOOM_PLAYTEST_LIMITS`), and reconvergence comes from
 * `computeTopologicalNodeOrder`'s `convergenceNodeIds`. The editorial
 * collector hands its existing playthrough report straight in, so the review
 * path pays for exactly one enumeration, not two.
 *
 * `analyzeStoryOutline` is intentionally NOT consulted: the outline/teleplay
 * sync contract makes an expanded scene key identical to its node id, so the
 * node graph is the only playable surface, and an episode that has an outline
 * but no expanded scenes has nothing to walk — it reports `unreviewed` rather
 * than being judged against a second, non-playable graph.
 */

import { EVOLUTION_STAGES, EVOLUTION_STAGE_LABELS, isDeclaredEvolution } from './characterEvolution.js';
import { computeTopologicalNodeOrder } from './fableLoomProduction.js';
import { enumerateEpisodePlaythroughs } from './fableLoomPlaytest.js';

const asArray = (value) => (Array.isArray(value) ? value : []);
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Per-lens and whole-report coverage. Mirrors `CHARACTER_REVIEW_STATUSES` in
 * `characterIntegrity.js` on purpose — the two answer the same shaped question
 * about a cast, and a second vocabulary for "we did not actually look" is how
 * one of them quietly starts meaning "clean".
 *   - `verified`   — every stage resolved, every reachable path enumerated,
 *                    nothing found.
 *   - `findings`   — fully enumerated, and at least one finding.
 *   - `unreviewed` — coverage could not be established. NOT a pass, and NOT a
 *                    defect. Wins over `findings` when both apply, because a
 *                    partial review that reported two findings must not read
 *                    as "those two and no more".
 */
export const EVOLUTION_COVERAGE_STATUSES = Object.freeze(['verified', 'findings', 'unreviewed']);

/** Why an episode's paths could not be reasoned about. `null` = they could. */
export const EVOLUTION_UNREVIEWED_REASONS = Object.freeze([
  'no-scenes', // the episode is still an outline; there is no playable graph
  'no-paths', // nothing walks from the opening scene (a broken/absent start)
  'variation-limit', // FABLELOOM_PLAYTEST_LIMITS truncated the enumeration
  'cycle', // a path repeats without terminating; prefixes are unreliable
  'step-limit', // a path hit the per-path scene ceiling
]);

/**
 * How far one stage's evidence anchor got. Narrower than
 * `EVOLUTION_EVIDENCE_STATUSES` because coverage needs a NODE, not just a
 * resolvable pointer: an anchor naming a live episode but no scene resolves
 * for the prompt renderer and still cannot be placed on a path.
 *   - `unanchored` — nothing authored.
 *   - `unverified` — authored, but it cannot be placed on a scene in a
 *                    playable graph (episode-only anchor, an ambiguous scene
 *                    key with no episode, or a beat the teleplay never
 *                    expanded).
 *   - `stale`      — authored and DEAD: it names an episode or a scene that
 *                    does not exist. Preserved and reported, never satisfied.
 *   - `resolved`   — placed on a concrete node in a concrete episode.
 */
export const EVOLUTION_ANCHOR_RESOLUTIONS = Object.freeze([
  'unanchored', 'unverified', 'stale', 'resolved',
]);

export const EVOLUTION_COVERAGE_CODES = Object.freeze({
  EVIDENCE_STALE: 'EVOLUTION_EVIDENCE_STALE',
  STAGE_OUT_OF_ORDER: 'EVOLUTION_STAGE_OUT_OF_ORDER',
  ENDING_UNPROVEN: 'EVOLUTION_ENDING_UNPROVEN',
  UNEARNED_INHERITANCE: 'EVOLUTION_UNEARNED_INHERITANCE',
});

// Findings are a bounded diagnostic block, not a list of every path. The
// editorial compactor caps the WHOLE series at 80, so an unbounded lens block
// would push the graph and continuity findings it is appended after out of the
// report entirely.
export const EVOLUTION_COVERAGE_FINDINGS_MAX = 40;

const STAGE_INDEX = new Map(EVOLUTION_STAGES.map((stageId, index) => [stageId, index]));
const stageLabel = (stageId) => EVOLUTION_STAGE_LABELS[stageId] || stageId;
const nodeLabel = (node, nodeId) => (hasText(node?.title) ? node.title : nodeId);

/**
 * The scenes each episode can anchor evidence to, and the nodes that are
 * actually playable.
 *
 * `sceneKeys` is the union of expanded node ids and authored outline keys:
 * after expansion the sync contract makes them the same string, and before it
 * only the outline exists — so a lens authored at either stage of the pipeline
 * resolves, and only a pointer at something genuinely deleted reads stale.
 */
const buildSceneIndex = (loom) => new Map(asArray(loom?.episodes).map((episode) => {
  const nodeIds = new Set(asArray(episode?.nodes).map((node) => node?.id).filter(hasText));
  const sceneKeys = new Set(nodeIds);
  for (const scene of asArray(episode?.storyOutline?.scenes)) {
    if (hasText(scene?.key)) sceneKeys.add(scene.key);
  }
  return [episode.id, { episode, nodeIds, sceneKeys }];
}));

/**
 * Place one stage's evidence on a concrete node, or say why it could not be.
 *
 * Resolution is EPISODE-SCOPED, which `evolutionEvidenceStatus` cannot be: it
 * checks a loom-wide scene-key set, so an anchor naming episode 1 and a scene
 * that only exists in episode 3 resolves there and is dead here. This resolver
 * is therefore never more permissive than that one — only ever stricter, which
 * is the direction the "never silently verified" rule allows.
 */
const resolveStageAnchor = (evidence, sceneIndex) => {
  const episodeId = hasText(evidence?.episodeId) ? evidence.episodeId : '';
  const sceneKey = hasText(evidence?.sceneKey) ? evidence.sceneKey : '';
  if (!episodeId && !sceneKey) return { resolution: 'unanchored', episodeId: null, nodeId: null };
  if (episodeId && !sceneIndex.has(episodeId)) {
    return {
      resolution: 'stale', episodeId, nodeId: null, dead: `episode ${episodeId}`,
    };
  }
  if (!sceneKey) {
    // A live episode with no scene named. Real authored intent, but there is
    // no position on a path to test it at.
    return { resolution: 'unverified', episodeId, nodeId: null };
  }
  let owner = episodeId ? sceneIndex.get(episodeId) : null;
  if (!owner) {
    // No episode authored: accept the scene key only when exactly one episode
    // owns it. Two owners is genuinely ambiguous, and guessing an episode is
    // how a stage gets credited to a branch it was never written for.
    const owners = [...sceneIndex.values()].filter((entry) => entry.sceneKeys.has(sceneKey));
    if (owners.length !== 1) {
      return owners.length === 0
        ? { resolution: 'stale', episodeId: null, nodeId: null, dead: `scene "${sceneKey}"` }
        : { resolution: 'unverified', episodeId: null, nodeId: null };
    }
    [owner] = owners;
  }
  if (!owner.sceneKeys.has(sceneKey)) {
    return {
      resolution: 'stale',
      episodeId: owner.episode.id,
      nodeId: null,
      dead: `scene "${sceneKey}" in episode ${owner.episode.id}`,
    };
  }
  // Known to the outline but never expanded into a playable scene. The
  // outline/teleplay sync check already reports that drift; here it just means
  // the stage cannot be placed on a path.
  if (!owner.nodeIds.has(sceneKey)) {
    return { resolution: 'unverified', episodeId: owner.episode.id, nodeId: null };
  }
  return { resolution: 'resolved', episodeId: owner.episode.id, nodeId: sceneKey };
};

/**
 * The paths for one episode, or the reason there are none to reason about.
 * `paths: null` is the sentinel for "not enumerated"; `[]` never occurs
 * alongside `enumerated: true` because an episode that produced no path at all
 * is itself a reason.
 */
const episodePaths = (episode, playtest) => {
  const unreviewed = (reason) => ({ enumerated: false, reason, paths: null });
  if (!asArray(episode?.nodes).length) return unreviewed('no-scenes');
  if (playtest.stats.enumerationComplete === false) return unreviewed('variation-limit');
  const paths = asArray(playtest.paths);
  if (!paths.length) return unreviewed('no-paths');
  // A cycle or a step-limit stop means the walk was CUT SHORT, so a stage that
  // is missing from a prefix may simply be past the cut. Reasoning about
  // inheritance on a truncated prefix is exactly the false defect the epic
  // forbids, so the whole episode reads unreviewed instead.
  const bounded = paths.find((path) => path.termination === 'cycle' || path.termination === 'step-limit');
  if (bounded) return unreviewed(bounded.termination === 'cycle' ? 'cycle' : 'step-limit');
  return { enumerated: true, reason: null, paths };
};

/** First visit index per node on one path (a node may repeat under the visit cap). */
const firstVisitIndex = (nodeIds) => {
  const index = new Map();
  nodeIds.forEach((nodeId, position) => {
    if (!index.has(nodeId)) index.set(nodeId, position);
  });
  return index;
};

/**
 * For ONE anchor node, how every reachable convergence scene sees it.
 *
 * Keyed by node rather than by (character, stage) on purpose: two characters
 * anchoring the same scene ask the identical graph question, and the record
 * caps (60 lenses x 5 stages against 200 scenes and 96 variations) make the
 * per-stage form the one shape of this analysis that could get expensive.
 */
const convergenceViewOfAnchor = (anchorNodeId, paths, convergenceOnPath) => {
  const provedBefore = new Set();
  const unprovedBefore = new Set();
  const anchoredAtOrAfter = new Set();
  const example = new Map();
  paths.forEach((path, pathIndex) => {
    const anchorIndex = path.firstIndex.get(anchorNodeId);
    for (const { nodeId, index } of convergenceOnPath[pathIndex]) {
      if (anchorIndex !== undefined && anchorIndex < index) {
        provedBefore.add(nodeId);
        continue;
      }
      if (anchorIndex !== undefined) anchoredAtOrAfter.add(nodeId);
      unprovedBefore.add(nodeId);
      if (!example.has(nodeId)) {
        example.set(nodeId, { pathId: path.id, viaNodeId: path.nodeIds[index - 1] || null });
      }
    }
  });
  return { provedBefore, unprovedBefore, anchoredAtOrAfter, example };
};

/**
 * Which of a character's stages this path actually proves, IN STAGE ORDER.
 *
 * Order is load-bearing: a path that plays the commitment scene before the
 * scene where the old strategy fails did not show the arc, it showed two
 * scenes. The out-of-order stage is reported separately and, on this path,
 * counts as unproven rather than being silently credited.
 */
const provedStagesOnPath = (stages, firstIndex) => {
  const proved = new Set();
  const outOfOrder = [];
  let lastIndex = -1;
  let lastStageId = null;
  for (const stage of stages) {
    const index = firstIndex.get(stage.nodeId);
    if (index === undefined) continue;
    if (index < lastIndex) {
      outOfOrder.push({ stageId: stage.stageId, afterStageId: lastStageId });
      continue;
    }
    lastIndex = index;
    lastStageId = stage.stageId;
    proved.add(stage.stageId);
  }
  return { proved, outOfOrder };
};

/**
 * What one declared outcome needs a path to have shown by its ending.
 *
 * `full-change` is the only outcome that asks for the LAST authored stage: the
 * declaration is that the change endures, so an ending reached without the
 * closing proof is an ending where the viewer never saw it endure. Every other
 * outcome — including the two that deliberately end in no transformation —
 * asks only that SOME authored stage was played, i.e. that the belief was put
 * under test on this branch. That is the difference between checking a refusal
 * was earned and demanding a transformation the author never declared.
 *
 * The requirement is drawn from the stages anchored in THIS episode, so a lens
 * whose closing proof lands in a later episode is not charged for it here.
 */
const requiredStageForEnding = (outcome, stages) => (
  outcome === 'full-change' ? stages[stages.length - 1]?.stageId || null : null
);

/**
 * Deterministic branch coverage for a loom's authored evolution lenses.
 *
 * Returns `null` when the plan has no lens at all — the caller adds nothing to
 * its report, so an install that never opted in is byte-identical.
 *
 * @param {object} loom                       sanitized loom record
 * @param {object} [options]
 * @param {object} [options.playthroughReport] an `analyzeLoomPlaythroughs`
 *   result to reuse. Omit and each episode is enumerated here instead.
 */
export function analyzeCharacterEvolutionCoverage(loom, { playthroughReport = null } = {}) {
  const lenses = asArray(loom?.seriesPlan?.characterEvolutions);
  if (!lenses.length) return null;

  const sceneIndex = buildSceneIndex(loom);
  const findings = [];
  // Counted even when the cap drops the finding itself, so a lens whose only
  // findings fell off the end can never roll up as `verified`.
  let lensFindingCount = 0;
  const pushFinding = (finding) => {
    lensFindingCount += 1;
    if (findings.length < EVOLUTION_COVERAGE_FINDINGS_MAX) findings.push(finding);
  };

  // ---- per-episode path context (one enumeration, shared by every lens) ----
  const episodes = [];
  const contextById = new Map();
  for (const episode of asArray(loom?.episodes)) {
    // Reuse the caller's report when it covers this episode; an episode it
    // does not carry is enumerated here rather than being reported unreviewed
    // for a bookkeeping reason that has nothing to do with the graph.
    const playtest = asArray(playthroughReport?.episodes)
      .find((item) => item.episodeId === episode.id)
      || enumerateEpisodePlaythroughs(episode);
    const { enumerated, reason, paths } = episodePaths(episode, playtest);
    const { convergenceNodeIds } = computeTopologicalNodeOrder(episode);
    const nodeById = new Map(asArray(episode.nodes).map((node) => [node.id, node]));
    const walked = enumerated
      ? paths.map((path) => ({ ...path, firstIndex: firstVisitIndex(path.nodeIds) }))
      : [];
    const convergenceOnPath = walked.map((path) => path.nodeIds
      .map((nodeId, index) => ({ nodeId, index }))
      .filter(({ nodeId, index }) => convergenceNodeIds.has(nodeId)
        && path.firstIndex.get(nodeId) === index));
    contextById.set(episode.id, {
      episode, enumerated, nodeById, paths: walked, convergenceOnPath, anchorViews: new Map(),
    });
    episodes.push({
      episodeId: episode.id,
      enumerated,
      reason,
      // Sentinel, not truthiness: `0` cannot occur here (an episode with no
      // path is `no-paths`), so `null` unambiguously means "not enumerated".
      pathCount: enumerated ? paths.length : null,
      convergenceCount: convergenceNodeIds.size,
    });
  }
  const anchorView = (context, anchorNodeId) => {
    if (!context.anchorViews.has(anchorNodeId)) {
      context.anchorViews.set(anchorNodeId, convergenceViewOfAnchor(
        anchorNodeId, context.paths, context.convergenceOnPath,
      ));
    }
    return context.anchorViews.get(anchorNodeId);
  };

  // ---- per-character coverage ----
  const characters = [];
  for (const lens of lenses) {
    const { characterId, characterName, evolution } = lens;
    lensFindingCount = 0;
    const who = characterName || characterId || 'This character';
    const declared = isDeclaredEvolution(evolution);
    const outcome = declared ? evolution.outcome : null;
    const stages = [];
    const resolvedByEpisode = new Map();
    let unreviewed = false;

    for (const stage of asArray(evolution?.stages)) {
      // `sanitizeEvolutionStage` rejects an unknown stage id rather than
      // coercing it, so this only fires on an unsanitized caller — and a beat
      // that cannot be placed in the sequence cannot be reasoned about, which
      // is unreviewed, never verified.
      if (!STAGE_INDEX.has(stage?.stageId)) {
        unreviewed = true;
        continue;
      }
      const anchor = resolveStageAnchor(stage.evidence, sceneIndex);
      const context = anchor.nodeId ? contextById.get(anchor.episodeId) : null;
      const enumerated = Boolean(context?.enumerated);
      if (anchor.resolution !== 'resolved' || !enumerated) unreviewed = true;
      if (anchor.resolution === 'stale') {
        pushFinding({
          code: EVOLUTION_COVERAGE_CODES.EVIDENCE_STALE,
          severity: 'error',
          message: `${who}'s "${stageLabel(stage.stageId)}" stage points at ${anchor.dead}, which no longer exists, so the stage can never be proved on any path.`,
          remediation: 'Re-anchor the stage to a scene that still exists, or clear the evidence pointer.',
          ...(characterId ? { characterId } : {}),
          ...(anchor.episodeId ? { episodeId: anchor.episodeId } : {}),
          stageId: stage.stageId,
        });
      }
      const record = {
        stageId: stage.stageId,
        resolution: anchor.resolution,
        episodeId: anchor.episodeId,
        nodeId: anchor.nodeId,
        // `null` = not computed (unresolved anchor, or an episode whose paths
        // were bounded out); `0` = computed and proved on no path at all.
        provenPathCount: null,
        pathCount: enumerated ? context.paths.length : null,
      };
      stages.push(record);
      if (anchor.resolution === 'resolved' && enumerated) {
        const bucket = resolvedByEpisode.get(anchor.episodeId) || [];
        bucket.push(record);
        resolvedByEpisode.set(anchor.episodeId, bucket);
      }
    }
    // A lens with no stages at all is a declaration with nothing behind it.
    if (!stages.length) unreviewed = true;

    for (const [episodeId, anchored] of resolvedByEpisode) {
      const context = contextById.get(episodeId);
      anchored.sort((a, b) => STAGE_INDEX.get(a.stageId) - STAGE_INDEX.get(b.stageId));
      const requiredStageId = requiredStageForEnding(outcome, anchored);
      const provenCounts = new Map(anchored.map((stage) => [stage.stageId, 0]));
      const reportedOutOfOrder = new Set();
      const uncoveredEndings = new Map();

      for (const path of context.paths) {
        const { proved, outOfOrder } = provedStagesOnPath(anchored, path.firstIndex);
        for (const stageId of proved) provenCounts.set(stageId, provenCounts.get(stageId) + 1);
        for (const { stageId, afterStageId } of outOfOrder) {
          if (reportedOutOfOrder.has(stageId)) continue;
          reportedOutOfOrder.add(stageId);
          pushFinding({
            code: EVOLUTION_COVERAGE_CODES.STAGE_OUT_OF_ORDER,
            severity: 'warning',
            message: `${who}'s "${stageLabel(stageId)}" stage is anchored to a scene the viewer reaches before "${stageLabel(afterStageId)}", so this path plays the arc out of sequence.`,
            remediation: `Re-anchor "${stageLabel(stageId)}" to a scene later than "${stageLabel(afterStageId)}", or re-order the stages to match the story.`,
            ...(characterId ? { characterId } : {}),
            episodeId,
            stageId,
            pathId: path.id,
          });
        }
        // Only a DECLARED outcome states what an ending owes the viewer. An
        // undeclared lens is unfinished planning, and charging it for an
        // outcome the author never made would invent the declaration.
        if (!declared || path.termination !== 'ending') continue;
        const covered = requiredStageId ? proved.has(requiredStageId) : proved.size > 0;
        if (covered) continue;
        const key = path.endingNodeId || 'unlabeled-ending';
        const seen = uncoveredEndings.get(key);
        if (seen) seen.count += 1;
        else {
          uncoveredEndings.set(key, {
            count: 1,
            pathId: path.id,
            endingNodeId: path.endingNodeId,
            endingLabel: path.endingLabel,
          });
        }
      }
      for (const stage of anchored) stage.provenPathCount = provenCounts.get(stage.stageId);

      for (const ending of uncoveredEndings.values()) {
        const label = ending.endingLabel
          || nodeLabel(context.nodeById.get(ending.endingNodeId), ending.endingNodeId);
        const what = requiredStageId
          ? `never reaches the "${stageLabel(requiredStageId)}" stage`
          : 'never puts the tested belief on screen';
        pushFinding({
          code: EVOLUTION_COVERAGE_CODES.ENDING_UNPROVEN,
          severity: 'warning',
          message: `${ending.count} playthrough(s) reach the ending "${label}" on a branch that ${what} for ${who}, so the declared "${outcome}" outcome is unproven there.`,
          remediation: `Anchor an evolution stage to a scene on the branches that reach "${label}", or route those branches through the scene that already proves it.`,
          ...(characterId ? { characterId } : {}),
          episodeId,
          ...(ending.endingNodeId ? { nodeId: ending.endingNodeId } : {}),
          pathId: ending.pathId,
        });
      }

      // ---- unearned inheritance at a reconvergence ----
      for (const stage of anchored) {
        const view = anchorView(context, stage.nodeId);
        for (const convergenceNodeId of view.provedBefore) {
          if (!view.unprovedBefore.has(convergenceNodeId)) continue; // a shared prerequisite
          const laterAnchored = anchored.some((other) => (
            STAGE_INDEX.get(other.stageId) > STAGE_INDEX.get(stage.stageId)
            && anchorView(context, other.nodeId).anchoredAtOrAfter.has(convergenceNodeId)
          ));
          const { pathId, viaNodeId } = view.example.get(convergenceNodeId) || {};
          const where = nodeLabel(context.nodeById.get(convergenceNodeId), convergenceNodeId);
          const via = viaNodeId
            ? ` (for example the branch arriving from "${nodeLabel(context.nodeById.get(viaNodeId), viaNodeId)}")`
            : '';
          pushFinding({
            code: EVOLUTION_COVERAGE_CODES.UNEARNED_INHERITANCE,
            // An arc the author declared CONTINUES past this scene is the case
            // where the inheritance actually corrupts later content; a
            // convergence with nothing anchored after it is a gap, not a lie.
            severity: laterAnchored ? 'error' : 'warning',
            message: `Branches reconverge at "${where}" with ${who}'s "${stageLabel(stage.stageId)}" stage proved on some incoming branches and not others${via}, so a viewer can arrive having never watched that change be earned.`,
            remediation: `Prove "${stageLabel(stage.stageId)}" on every branch that reaches "${where}" (or before they split), or write a variant of "${where}" for the branches that have not earned it.`,
            ...(characterId ? { characterId } : {}),
            episodeId,
            nodeId: convergenceNodeId,
            stageId: stage.stageId,
            ...(pathId ? { pathId } : {}),
          });
        }
      }
    }

    characters.push({
      characterId: characterId || '',
      characterName: characterName || '',
      outcome,
      // `unreviewed` outranks `findings`: a lens with one dead anchor and one
      // real finding has not been fully looked at, and saying `findings` there
      // would present that one finding as the complete answer.
      status: unreviewed ? 'unreviewed' : (lensFindingCount ? 'findings' : 'verified'),
      stages,
    });
  }

  const unreviewedCharacterCount = characters.filter((c) => c.status === 'unreviewed').length;
  return {
    status: unreviewedCharacterCount
      ? 'unreviewed'
      : (findings.length ? 'findings' : 'verified'),
    findings,
    characters,
    episodes,
    stats: {
      lensCount: characters.length,
      declaredLensCount: characters.filter((c) => c.outcome).length,
      unreviewedLensCount: unreviewedCharacterCount,
      unreviewedEpisodeCount: episodes.filter((e) => !e.enumerated).length,
      findingCount: findings.length,
      unearnedInheritanceCount: findings.filter((f) => (
        f.code === EVOLUTION_COVERAGE_CODES.UNEARNED_INHERITANCE
      )).length,
      unprovenEndingCount: findings.filter((f) => (
        f.code === EVOLUTION_COVERAGE_CODES.ENDING_UNPROVEN
      )).length,
      staleAnchorCount: findings.filter((f) => (
        f.code === EVOLUTION_COVERAGE_CODES.EVIDENCE_STALE
      )).length,
    },
  };
}

