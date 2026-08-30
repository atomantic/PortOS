/**
 * FableLoom whole-series editorial automation.
 *
 * One editor call can diagnose and repair the series plan, missing/invalid beat
 * outlines, existing scene metadata, path labels/targets, and convergence
 * continuity without changing episode, scene, or transition membership. A
 * separate playthrough judge reviews the deterministic variation harness after
 * edits land; the autopilot composes the two bounded operations.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { analyzeEpisodeContinuity, CONTINUITY_CODES } from '../../lib/fableLoomContinuity.js';
import { analyzeEpisodeGraph, describeGraphForPrompt } from '../../lib/fableLoomGraph.js';
import {
  analyzeSeriesStoryOutlines,
  analyzeStoryOutline,
  describeStoryOutlineForPrompt,
  sanitizeStoryOutline,
} from '../../lib/fableLoomOutline.js';
import {
  analyzeLoomPlaythroughs,
  describeLoomPlaythroughsForPrompt,
} from '../../lib/fableLoomPlaytest.js';
import { computeTopologicalNodeOrder } from '../../lib/fableLoomProduction.js';
import {
  isFableLoomPlaybackMode,
  FABLELOOM_PROTAGONIST_PRESENCE,
} from '../../lib/fableLoomPlayback.js';
import { trimTo } from '../../lib/storyBible.js';
import { normalizeFableLoomCameraMovement } from '../../lib/fableLoomCameraMovements.js';
import { startAIOp } from '../aiStatusEvents.js';
import { runStagedLLM } from '../stageRunner.js';
import { getUniverse } from '../universeBuilder.js';
import { listVoiceProfiles } from '../voice/profiles.js';
import { buildCanonDigest } from './weave.js';
import {
  getLoom,
  mutateLoom,
  sanitizeLoom,
} from './records.js';

const REVIEW_SEVERITIES = new Set(['high', 'medium', 'low']);
const REVIEW_CATEGORIES = new Set([
  'coherence', 'character', 'choice', 'pacing', 'ending', 'continuity', 'canon', 'structure',
]);
const AUTOPILOT_QUALITY_THRESHOLD = 8;

const asArray = (value) => (Array.isArray(value) ? value : []);
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clampScore = (value) => (Number.isFinite(value)
  ? Math.max(0, Math.min(10, Math.round(value * 10) / 10))
  : null);

const aiShapeError = (message) => new ServerError(message, {
  status: 502,
  code: 'AI_RESPONSE_INVALID',
});

const requireLoom = async (loomId) => {
  const loom = await getLoom(loomId);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  return loom;
};

const llmOptions = ({ providerId, model, effort } = {}, source) => ({
  source,
  returnsJson: true,
  ...(providerId ? { providerOverride: providerId } : {}),
  ...(model ? { modelOverride: model } : {}),
  ...(effort ? { effortOverride: effort } : {}),
});

const runEditorialAi = (stage, variables, route, { action, label, source }) => {
  const status = route.operationId ? startAIOp({
    op: `fableloom-${action}`,
    label,
    operationId: route.operationId,
    localOnly: true,
    silent: true,
  }) : null;
  const options = llmOptions(route, source);
  if (status) {
    options.onRunCreated = (runId, meta = {}) => status.update(
      'running',
      `${label} is running…`,
      { ...meta, runId, shellReady: false },
    );
    options.onRunReady = (meta = {}) => status.update(
      'ready',
      'TUI run is ready — open Shell to watch and interact',
      meta,
    );
    options.onRunSettled = (runId) => status.update(
      'applying',
      'AI response received — validating the story changes…',
      { runId },
    );
  }
  return runStagedLLM(stage, variables, options).then((result) => {
    status?.complete('Editorial result ready', { runId: result.runId, shellReady: false });
    return result;
  }, (error) => {
    status?.error(error?.message || 'FableLoom editorial operation failed', {
      ...(error?.runId ? { runId: error.runId } : {}),
    });
    throw error;
  });
};

const storyContext = (loom) => [
  `Story: ${loom.name}`,
  loom.logline ? `Logline: ${loom.logline}` : '',
  loom.premise ? `Premise: ${loom.premise}` : '',
  loom.styleNotes ? `Style: ${loom.styleNotes}` : '',
  `Audience participation mode: ${loom.participationMode || 'protagonist'}`,
  loom.audienceCommunicationMedium
    ? `Audience communication medium: ${loom.audienceCommunicationMedium}`
    : '',
  loom.protagonistCharacterId
    ? `Canonical protagonist id: ${loom.protagonistCharacterId}`
    : '',
  loom.protagonistWardrobeId
    ? `Canonical protagonist wardrobe id: ${loom.protagonistWardrobeId}`
    : '',
].filter(Boolean).join('\n');

const seriesPlanDigest = (loom) => JSON.stringify({
  storyArc: trimTo(loom.seriesPlan?.storyArc, 6000),
  plotPoints: asArray(loom.seriesPlan?.plotPoints),
  sideQuests: asArray(loom.seriesPlan?.sideQuests),
  deliveryOptions: loom.seriesPlan?.deliveryOptions || null,
  interEpisodeVoicemails: asArray(loom.seriesPlan?.interEpisodeVoicemails),
  nextSeasonTeaser: loom.seriesPlan?.nextSeasonTeaser || null,
  episodes: asArray(loom.episodes).map((episode) => ({
    id: episode.id,
    number: episode.number,
    title: episode.title,
    synopsis: trimTo(episode.synopsis, 600),
    storyOutline: episode.storyOutline
      ? describeStoryOutlineForPrompt(episode.storyOutline)
      : '(missing)',
  })),
}, null, 2);

const teleplayDigest = (loom) => asArray(loom.episodes).map((episode) => [
  `## Episode ${episode.number}: ${episode.title || 'Untitled'}`,
  `Episode id: ${episode.id}`,
  episode.synopsis ? `Synopsis: ${trimTo(episode.synopsis, 600)}` : '',
  episode.storyOutline
    ? `Beat outline:\n${describeStoryOutlineForPrompt(episode.storyOutline)}`
    : 'Beat outline: (missing)',
  episode.nodes.length
    ? describeGraphForPrompt(episode, { proseLimit: 1000, participationMode: loom.participationMode })
    : '(no expanded teleplay scenes)',
].filter(Boolean).join('\n')).join('\n\n');

const editorialFingerprint = (loom) => JSON.stringify({
  name: loom.name,
  logline: loom.logline,
  premise: loom.premise,
  styleNotes: loom.styleNotes,
  participationMode: loom.participationMode,
  audienceCommunicationMedium: loom.audienceCommunicationMedium,
  protagonistCharacterId: loom.protagonistCharacterId,
  protagonistWardrobeId: loom.protagonistWardrobeId,
  protagonistWardrobeLocked: loom.protagonistWardrobeLocked,
  seriesPlan: loom.seriesPlan,
  episodes: loom.episodes,
});

/** Assemble every deterministic series-level authoring/playthrough signal. */
export async function collectFableLoomEditorialDiagnostics(loom) {
  const [universe, voiceProfiles] = await Promise.all([
    loom.universeId ? getUniverse(loom.universeId).catch(() => null) : null,
    listVoiceProfiles().catch(() => []),
  ]);
  const outline = analyzeSeriesStoryOutlines(loom);
  const playthrough = analyzeLoomPlaythroughs(loom);
  const episodes = loom.episodes.map((episode, index) => {
    const graph = analyzeEpisodeGraph(episode, {
      participationMode: loom.participationMode,
      requireAudienceIntroduction: index === 0,
    });
    const continuity = analyzeEpisodeContinuity({
      loom,
      episode,
      universe,
      localVoiceProfiles: voiceProfiles,
    });
    const playtest = playthrough.episodes.find((item) => item.episodeId === episode.id);
    return {
      episodeId: episode.id,
      number: episode.number || index + 1,
      title: episode.title || `Episode ${episode.number || index + 1}`,
      graph,
      continuity,
      playtest,
    };
  });
  const graphErrors = episodes.reduce((total, episode) => total + episode.graph.stats.errorCount, 0);
  const graphWarnings = episodes.reduce((total, episode) => total + episode.graph.stats.warningCount, 0);
  const continuityErrors = episodes.reduce((total, episode) => total + episode.continuity.summary.errors, 0);
  const continuityWarnings = episodes.reduce((total, episode) => total + episode.continuity.summary.warnings, 0);
  const convergenceIssues = episodes.reduce((total, episode) => total + episode.continuity.findings.filter((finding) => (
    finding.code === CONTINUITY_CODES.AMBIGUOUS_CONVERGENCE
  )).length, 0);
  const playthroughErrors = episodes.reduce((total, episode) => (
    total + (episode.playtest?.stats.errorCount || 0)
  ), 0);
  const stats = {
    outlineErrors: outline.stats.errorCount,
    outlineWarnings: outline.stats.warningCount,
    graphErrors,
    graphWarnings,
    continuityErrors,
    continuityWarnings,
    convergenceIssues,
    playthroughErrors,
    variationCount: playthrough.stats.variationCount,
    endingVariationCount: playthrough.stats.endingVariationCount,
    visitedTransitionCount: playthrough.stats.visitedTransitionCount,
    transitionCount: playthrough.stats.transitionCount,
  };
  return {
    passed: outline.stats.ready
      && graphErrors === 0
      && continuityErrors === 0
      && convergenceIssues === 0
      && playthrough.passed,
    outline,
    playthrough,
    episodes,
    stats,
  };
}

const diagnosticLines = (diagnostics) => {
  const lines = [
    `Series outlines: ${diagnostics.stats.outlineErrors} error(s), ${diagnostics.stats.outlineWarnings} warning(s).`,
    `Episode graphs: ${diagnostics.stats.graphErrors} error(s), ${diagnostics.stats.graphWarnings} warning(s).`,
    `Continuity: ${diagnostics.stats.continuityErrors} error(s), ${diagnostics.stats.continuityWarnings} warning(s), ${diagnostics.stats.convergenceIssues} ambiguous convergence scene(s).`,
    `Playthroughs: ${diagnostics.stats.variationCount} variation(s), ${diagnostics.stats.endingVariationCount} ending path(s), ${diagnostics.stats.visitedTransitionCount}/${diagnostics.stats.transitionCount} transitions exercised.`,
  ];
  diagnostics.outline.issues.forEach((issue) => lines.push(
    `- [outline/${issue.severity}] episode=${issue.episodeId || 'series'} scene=${issue.sceneKey || '-'} code=${issue.code}: ${issue.message}`,
  ));
  diagnostics.episodes.forEach((episode) => {
    episode.graph.issues.forEach((issue) => lines.push(
      `- [graph/${issue.severity}] episode=${episode.episodeId} node=${issue.nodeId || '-'} code=${issue.code}: ${issue.message}`,
    ));
    episode.continuity.findings.forEach((finding) => lines.push(
      `- [continuity/${finding.severity}] episode=${episode.episodeId} node=${finding.nodeId || '-'} code=${finding.code}: ${finding.message} Fix: ${finding.remediation}`,
    ));
    asArray(episode.playtest?.issues).forEach((issue) => lines.push(
      `- [playthrough/${issue.severity}] episode=${episode.episodeId} path=${issue.pathId || '-'} node=${issue.nodeId || '-'} code=${issue.code}: ${issue.message}`,
    ));
  });
  return lines.join('\n');
};

const analysisStrings = (value) => asArray(value)
  .filter((item) => typeof item === 'string')
  .map((item) => trimTo(item, 1000))
  .filter(Boolean)
  .slice(0, 20);

const sanitizeEvaluation = (content, loom) => {
  const episodeIds = new Set(loom.episodes.map((episode) => episode.id));
  const nodesByEpisode = new Map(loom.episodes.map((episode) => [
    episode.id,
    new Set(episode.nodes.map((node) => node.id)),
  ]));
  const findings = asArray(content?.findings)
    .filter((finding) => finding && typeof finding === 'object' && hasText(finding.problem))
    .slice(0, 40)
    .map((finding) => {
      const episodeId = episodeIds.has(finding.episodeId) ? finding.episodeId : null;
      const nodeId = episodeId && nodesByEpisode.get(episodeId).has(finding.nodeId)
        ? finding.nodeId
        : null;
      return {
        severity: REVIEW_SEVERITIES.has(finding.severity) ? finding.severity : 'medium',
        category: REVIEW_CATEGORIES.has(finding.category) ? finding.category : 'coherence',
        episodeId,
        nodeId,
        problem: trimTo(finding.problem, 1200),
        suggestion: trimTo(finding.suggestion, 1200),
      };
    });
  return {
    summary: trimTo(content?.summary, 2500),
    strengths: analysisStrings(content?.strengths),
    findings,
  };
};

const allowedEpisodeFields = ['title', 'synopsis', 'startNodeId'];
const allowedSceneFields = [
  'title', 'prose', 'imagePrompt', 'videoPrompt', 'cameraMovement', 'playbackMode',
  'audienceConnection', 'protagonistPresence', 'isEnding', 'endingLabel',
];
const allowedTransitionFields = ['targetNodeId', 'intent', 'triggers', 'description'];

const applySeriesPlanPatch = (currentPlan, raw) => {
  if (!raw || typeof raw !== 'object') return currentPlan;
  const next = { ...currentPlan };
  for (const key of [
    'storyArc', 'plotPoints', 'sideQuests', 'deliveryOptions',
    'interEpisodeVoicemails', 'nextSeasonTeaser',
  ]) {
    if (hasOwn(raw, key)) next[key] = raw[key];
  }
  return next;
};

const applyScenePatch = (episode, scene, rawScene) => {
  for (const key of allowedSceneFields) {
    if (!hasOwn(rawScene, key)) continue;
    const value = rawScene[key];
    if (['title', 'prose', 'imagePrompt', 'videoPrompt', 'endingLabel'].includes(key)
      && typeof value === 'string') scene[key] = value;
    if (key === 'cameraMovement' && typeof value === 'string') {
      scene.cameraMovement = normalizeFableLoomCameraMovement(value);
    }
    if (key === 'playbackMode' && isFableLoomPlaybackMode(value)) scene.playbackMode = value;
    if (key === 'audienceConnection' && ['connected', 'disconnected'].includes(value)) {
      scene.audienceConnection = value;
    }
    if (key === 'protagonistPresence' && FABLELOOM_PROTAGONIST_PRESENCE.includes(value)) {
      scene.protagonistPresence = value;
    }
    if (key === 'isEnding' && typeof value === 'boolean') scene.isEnding = value;
  }

  const transitionsById = new Map(asArray(scene.transitions).map((transition) => [transition.id, transition]));
  const nodeIds = new Set(episode.nodes.map((node) => node.id));
  for (const rawTransition of asArray(rawScene.transitions)) {
    const transition = transitionsById.get(rawTransition?.id);
    if (!transition) continue;
    for (const key of allowedTransitionFields) {
      if (!hasOwn(rawTransition, key)) continue;
      const value = rawTransition[key];
      if (key === 'targetNodeId' && typeof value === 'string' && nodeIds.has(value)) {
        transition.targetNodeId = value;
      }
      if (['intent', 'description'].includes(key) && typeof value === 'string') transition[key] = value;
      if (key === 'triggers' && Array.isArray(value)) transition.triggers = value;
    }
  }
};

const applyContinuitySourcePatch = (scene, sourceId, predecessorsByNodeId) => {
  const validPredecessors = new Set(
    asArray(predecessorsByNodeId.get(scene.id)).map((item) => item.nodeId),
  );
  if (sourceId !== null && (!hasText(sourceId) || !validPredecessors.has(sourceId))) {
    throw aiShapeError(`The model selected an invalid continuity predecessor for scene ${scene.id}`);
  }
  scene.visualCanon = {
    ...(scene.visualCanon || {}),
    continuitySourceNodeId: sourceId,
  };
};

const countGraphErrors = (loom) => loom.episodes.reduce((total, episode, index) => (
  total + analyzeEpisodeGraph(episode, {
    participationMode: loom.participationMode,
    requireAudienceIntroduction: index === 0,
  }).stats.errorCount
), 0);

/**
 * Apply a model response to an in-memory loom while preserving graph
 * membership. Exported for focused contract tests and the persistence wrapper.
 */
export function applyFableLoomEditorialPatch(loom, content) {
  if (!content || typeof content !== 'object') throw aiShapeError('The model returned no editorial response');
  const candidate = structuredClone(loom);
  const beforeGraphErrors = countGraphErrors(candidate);
  const beforeOutlineErrors = analyzeSeriesStoryOutlines(candidate).stats.errorCount;

  if (content.seriesPlan && typeof content.seriesPlan === 'object') {
    candidate.seriesPlan = applySeriesPlanPatch(candidate.seriesPlan, content.seriesPlan);
  }
  const episodesById = new Map(candidate.episodes.map((episode) => [episode.id, episode]));
  const returnedEpisodeIds = new Set();
  for (const rawEpisode of asArray(content.episodes)) {
    const episode = episodesById.get(rawEpisode?.id);
    if (!episode || returnedEpisodeIds.has(episode.id)) continue;
    returnedEpisodeIds.add(episode.id);
    for (const key of allowedEpisodeFields) {
      if (!hasOwn(rawEpisode, key)) continue;
      const value = rawEpisode[key];
      if (['title', 'synopsis'].includes(key) && typeof value === 'string') episode[key] = value;
      if (key === 'startNodeId' && typeof value === 'string'
        && episode.nodes.some((node) => node.id === value)) episode.startNodeId = value;
    }
    if (hasOwn(rawEpisode, 'storyOutline')) {
      const storyOutline = sanitizeStoryOutline(rawEpisode.storyOutline, {
        participationMode: candidate.participationMode,
      });
      if (!storyOutline) throw aiShapeError(`The model returned an unusable outline for episode ${episode.id}`);
      const analysis = analyzeStoryOutline(storyOutline, {
        participationMode: candidate.participationMode,
        requireAudienceIntroduction: candidate.episodes[0]?.id === episode.id,
      });
      if (analysis.stats.errorCount) {
        throw aiShapeError(`The model returned an invalid outline for episode ${episode.id}: ${analysis.issues.find((issue) => issue.severity === 'error')?.message}`);
      }
      episode.storyOutline = {
        ...storyOutline,
        validation: {
          status: 'valid',
          issues: analysis.issues,
          validatedAt: new Date().toISOString(),
        },
      };
    }
    const scenesById = new Map(episode.nodes.map((scene) => [scene.id, scene]));
    const continuitySourcePatches = [];
    for (const rawScene of asArray(rawEpisode.scenes)) {
      const scene = scenesById.get(rawScene?.id);
      if (!scene) continue;
      applyScenePatch(episode, scene, rawScene);
      if (rawScene.visualCanon && typeof rawScene.visualCanon === 'object'
        && hasOwn(rawScene.visualCanon, 'continuitySourceNodeId')) {
        continuitySourcePatches.push({
          scene,
          sourceId: rawScene.visualCanon.continuitySourceNodeId,
        });
      }
    }
    // Transition targets are patchable, so predecessor validation must run
    // against the resulting graph rather than the graph the model inspected.
    const { predecessorsByNodeId } = computeTopologicalNodeOrder(episode);
    for (const { scene, sourceId } of continuitySourcePatches) {
      applyContinuitySourcePatch(scene, sourceId, predecessorsByNodeId);
    }
  }

  const sanitized = sanitizeLoom(candidate);
  if (!sanitized) throw aiShapeError('The editorial response produced an invalid loom');
  const afterGraphErrors = countGraphErrors(sanitized);
  const afterOutlineErrors = analyzeSeriesStoryOutlines(sanitized).stats.errorCount;
  if (afterGraphErrors > beforeGraphErrors) {
    throw aiShapeError('The editorial response introduced new episode graph errors');
  }
  if (afterOutlineErrors > beforeOutlineErrors) {
    throw aiShapeError('The editorial response introduced new series-outline errors');
  }

  const before = editorialFingerprint(loom);
  const after = editorialFingerprint(sanitized);
  return {
    loom: sanitized,
    changed: before !== after,
    before: { graphErrors: beforeGraphErrors, outlineErrors: beforeOutlineErrors },
    after: { graphErrors: afterGraphErrors, outlineErrors: afterOutlineErrors },
  };
}

/** One AI call that evaluates and repairs the complete existing loom. */
export async function evaluateAndRemediateFableLoom(loomId, {
  guidance = '', providerId, model, effort, operationId,
} = {}) {
  const loom = await requireLoom(loomId);
  const fingerprint = editorialFingerprint(loom);
  const diagnostics = await collectFableLoomEditorialDiagnostics(loom);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runEditorialAi('fableloom-editorial-remediate', {
    storyContext: storyContext(loom),
    canonDigest: canonDigest || '(none)',
    seriesPlanJson: seriesPlanDigest(loom),
    teleplayDigest: teleplayDigest(loom),
    playthroughDigest: describeLoomPlaythroughsForPrompt(loom, diagnostics.playthrough),
    deterministicDigest: diagnosticLines(diagnostics),
    guidance: trimTo(guidance, 4000) || '(none)',
  }, { providerId, model, effort, operationId }, {
    action: 'editorial-remediate',
    label: 'Evaluating and remediating the FableLoom series',
    source: 'fableloom-editorial-remediate',
  });
  const evaluation = sanitizeEvaluation(content, loom);
  if (!evaluation.summary && !evaluation.strengths.length && !evaluation.findings.length) {
    throw aiShapeError('The model returned no usable editorial evaluation');
  }
  const applied = applyFableLoomEditorialPatch(loom, content);
  const updated = applied.changed ? await mutateLoom(loomId, (current) => {
    if (editorialFingerprint(current) !== fingerprint) {
      throw new ServerError('The story changed while the editorial pass was running', {
        status: 409,
        code: 'LOOM_CHANGED_DURING_GENERATION',
      });
    }
    return applied.loom;
  }) : loom;
  const afterDiagnostics = await collectFableLoomEditorialDiagnostics(updated);
  return {
    loom: updated,
    changed: applied.changed,
    changes: analysisStrings(content?.changes),
    evaluation,
    before: diagnostics.stats,
    after: afterDiagnostics.stats,
    diagnostics: afterDiagnostics,
    runId,
  };
}

const sanitizePlaythroughReview = (content, loom, deterministic) => {
  const episodeById = new Map(loom.episodes.map((episode) => [episode.id, episode]));
  const pathsByEpisode = new Map(deterministic.episodes.map((episode) => [
    episode.episodeId,
    new Set(episode.paths.map((path) => path.id)),
  ]));
  const findings = asArray(content?.findings)
    .filter((finding) => finding && typeof finding === 'object' && hasText(finding.problem))
    .slice(0, 60)
    .map((finding) => {
      const episode = episodeById.get(finding.episodeId);
      const episodeId = episode?.id || null;
      const nodeId = episode?.nodes.some((node) => node.id === finding.nodeId)
        ? finding.nodeId
        : null;
      const pathId = episodeId && pathsByEpisode.get(episodeId)?.has(finding.pathId)
        ? finding.pathId
        : null;
      return {
        severity: REVIEW_SEVERITIES.has(finding.severity) ? finding.severity : 'medium',
        category: REVIEW_CATEGORIES.has(finding.category) ? finding.category : 'coherence',
        episodeId,
        nodeId,
        pathId,
        problem: trimTo(finding.problem, 1200),
        suggestion: trimTo(finding.suggestion, 1200),
      };
    });
  const qualityScore = clampScore(content?.qualityScore);
  if (qualityScore === null || !hasText(content?.summary)) {
    throw aiShapeError('The model returned no usable playthrough quality verdict');
  }
  return {
    passed: content?.passed === true,
    qualityScore,
    summary: trimTo(content.summary, 2500),
    strengths: analysisStrings(content?.strengths),
    findings,
  };
};

/** Run the deterministic variations and optionally one AI quality review. */
export async function reviewFableLoomPlaythroughs(loomId, {
  aiReview = true, maxPaths, providerId, model, effort, operationId,
} = {}) {
  const loom = await requireLoom(loomId);
  const deterministic = analyzeLoomPlaythroughs(loom, { maxPaths });
  if (!aiReview) return { passed: deterministic.passed, deterministic, review: null, runId: null };
  const canonDigest = await buildCanonDigest(loom);
  const diagnostics = await collectFableLoomEditorialDiagnostics(loom);
  const { content, runId } = await runEditorialAi('fableloom-review-playthroughs', {
    storyContext: storyContext(loom),
    canonDigest: canonDigest || '(none)',
    seriesPlanJson: seriesPlanDigest(loom),
    teleplayDigest: teleplayDigest(loom),
    playthroughDigest: describeLoomPlaythroughsForPrompt(loom, deterministic),
    deterministicDigest: diagnosticLines(diagnostics),
  }, { providerId, model, effort, operationId }, {
    action: 'review-playthroughs',
    label: 'Reviewing FableLoom playthrough variations',
    source: 'fableloom-review-playthroughs',
  });
  const review = sanitizePlaythroughReview(content, loom, deterministic);
  const hasHighFinding = review.findings.some((finding) => finding.severity === 'high');
  return {
    passed: diagnostics.passed
      && deterministic.passed
      && review.passed
      && !hasHighFinding
      && review.qualityScore >= AUTOPILOT_QUALITY_THRESHOLD,
    deterministic,
    review,
    runId,
    qualityThreshold: AUTOPILOT_QUALITY_THRESHOLD,
  };
}

export const __testing = {
  diagnosticLines,
  editorialFingerprint,
  sanitizeEvaluation,
  sanitizePlaythroughReview,
};
