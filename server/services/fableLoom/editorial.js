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
  analyzeStoryOutlineTeleplaySync,
  describeStoryOutlineForPrompt,
  sanitizeStoryOutline,
} from '../../lib/fableLoomOutline.js';
import {
  analyzeLoomPlaythroughs,
  buildLoomPlaythroughPromptDigest,
} from '../../lib/fableLoomPlaytest.js';
import { computeTopologicalNodeOrder } from '../../lib/fableLoomProduction.js';
import { CHARS_PER_TOKEN, usableInputTokens } from '../../lib/contextBudget.js';
import {
  isFableLoomPlaybackMode,
  FABLELOOM_PROTAGONIST_PRESENCE,
} from '../../lib/fableLoomPlayback.js';
import { trimTo } from '../../lib/storyBible.js';
import { renderCanonForPrompt } from '../../lib/universePromptRenderers.js';
import { normalizeFableLoomCameraMovement } from '../../lib/fableLoomCameraMovements.js';
import { startAIOp } from '../aiStatusEvents.js';
import { buildPrompt } from '../promptService.js';
import { resolveStageContext, runStageScopedInlineLLM } from '../stageRunner.js';
import { getUniverse } from '../universeBuilder.js';
import { listVoiceProfiles } from '../voice/profiles.js';
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
const EDITORIAL_PROMPT_HARD_MAX_CHARS = 1_000_000;
const EDITORIAL_OUTPUT_RESERVE_TOKENS = 8_000;
const INSTRUCTION_PLACEHOLDER_VALUES = new Set([
  'concise whole-series editorial assessment',
  'episode_id_from_input',
  'only when changed',
  'complete replacement only when changed',
  'existing scene id, only when changed',
  'existing scene id or null',
  'existing episode id or null',
  'existing transition id',
  'scene_id_from_input',
  "sharpened one scene's sensory detail without changing its beat.",
  'specific strength worth preserving',
  'the signal shivers through the flooded tunnel walls.',
]);

const asArray = (value) => (Array.isArray(value) ? value : []);
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const hasOwn = (value, key) => Object.hasOwn(value, key);
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
  // The complete path trace is budgeted against this exact resolved route.
  // A smaller proactive/runtime fallback could silently exceed its context.
  allowFallback: false,
  ...(providerId ? { providerOverride: providerId } : {}),
  ...(model ? { modelOverride: model } : {}),
  ...(effort ? { effortOverride: effort } : {}),
});

const runEditorialAi = (stage, prompt, route, { action, label, source }) => {
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
  return runStageScopedInlineLLM(stage, prompt, options).then((result) => {
    return { ...result, status };
  }, (error) => {
    status?.error(error?.message || 'FableLoom editorial operation failed', {
      ...(error?.runId ? { runId: error.runId } : {}),
    });
    throw error;
  });
};

const finalizeEditorialOperation = (status, runId, work) => Promise.resolve()
  .then(work)
  .then((result) => {
    status?.complete('Editorial operation complete', { runId, shellReady: false });
    return result;
  }, (error) => {
    status?.error(error?.message || 'FableLoom editorial operation failed', {
      ...(runId ? { runId } : {}),
    });
    throw error;
  });

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

const withoutTemporalMetadata = (value) => {
  if (Array.isArray(value)) return value.map(withoutTemporalMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['createdAt', 'updatedAt'].includes(key))
    .map(([key, item]) => [key, withoutTemporalMetadata(item)]));
};

const editorialDependencyFingerprint = ({ universe, voiceProfiles, canonDigest }) => JSON.stringify({
  canonDigest,
  continuityUniverse: universe ? withoutTemporalMetadata({
    characters: universe.characters,
    places: universe.places,
    objects: universe.objects,
  }) : null,
  voiceProfiles: asArray(voiceProfiles).map((profile) => ({
    id: profile.id,
    version: profile.version,
    binding: profile.binding,
    approval: profile.approval,
    engine: profile.engine,
    modelRevision: profile.modelRevision,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
});

const loadEditorialDependencies = async (loom, {
  getUniverseFn = getUniverse,
  listVoiceProfilesFn = listVoiceProfiles,
} = {}) => {
  const [universe, voiceProfiles] = await Promise.all([
    loom.universeId ? getUniverseFn(loom.universeId) : null,
    listVoiceProfilesFn(),
  ]);
  return {
    universe,
    voiceProfiles,
    canonDigest: universe ? renderCanonForPrompt(universe) : '',
  };
};

const assertEditorialDependenciesUnchanged = (current, fingerprint, { code, message }) => {
  if (editorialDependencyFingerprint(current) !== fingerprint) {
    throw new ServerError(message, { status: 409, code });
  }
};

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

// Whole-record writes must conflict on every semantic persisted field. Only
// timestamps are excluded: they can change without changing the story input.
const editorialFingerprint = (loom) => {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...semantic } = loom || {};
  return JSON.stringify(semantic);
};

const assertEditorialSnapshotUnchanged = (current, fingerprint, { code, message }) => {
  if (editorialFingerprint(current) !== fingerprint) {
    throw new ServerError(message, { status: 409, code });
  }
};

const editorialPromptBudgetChars = (contextWindow) => Math.min(
  EDITORIAL_PROMPT_HARD_MAX_CHARS,
  usableInputTokens({
    contextWindow,
    outputReserveTokens: EDITORIAL_OUTPUT_RESERVE_TOKENS,
  }) * CHARS_PER_TOKEN,
);

const editorialPromptCharacterCount = (variables) => Object.values(variables).reduce((total, value) => (
    total + (typeof value === 'string' ? value.length : 0)
  ), 0);

const assertEditorialPromptBudget = (variables, maxChars = EDITORIAL_PROMPT_HARD_MAX_CHARS) => {
  const characterCount = editorialPromptCharacterCount(variables);
  if (characterCount > maxChars) {
    throw new ServerError(
      `This story needs ${characterCount.toLocaleString()} prompt characters, above the selected model's ${maxChars.toLocaleString()}-character single-editor limit. Shorten the series, choose a larger-context model, or review it in smaller sections.`,
      { status: 413, code: 'FABLELOOM_EDITORIAL_CONTEXT_TOO_LARGE' },
    );
  }
  return variables;
};

const withCompletePlaythroughDigest = ({ loom, report, variables, maxPromptChars }) => {
  const digest = buildLoomPlaythroughPromptDigest(loom, report, { maxChars: maxPromptChars });
  if (!digest.complete) {
    throw new ServerError(
      `The selected model can hold ${digest.includedVariationCount}/${digest.totalVariationCount} complete playthrough variations after the story context. No paths were silently omitted. Choose a larger-context model or review a smaller series.`,
      { status: 413, code: 'FABLELOOM_PLAYTHROUGH_CONTEXT_TOO_LARGE' },
    );
  }
  return { ...variables, playthroughDigest: digest.text };
};

const renderEditorialPrompt = async (
  stage,
  variables,
  maxPromptChars,
  { buildPromptFn = buildPrompt } = {},
) => {
  const prompt = await buildPromptFn(stage, variables);
  assertEditorialPromptBudget({ renderedPrompt: prompt }, maxPromptChars);
  return prompt;
};

const resolveEditorialPromptBudgetChars = async (stage, route, source) => {
  const { contextWindow } = await resolveStageContext(stage, llmOptions(route, source));
  return editorialPromptBudgetChars(contextWindow);
};

/** Assemble every deterministic series-level authoring/playthrough signal. */
export async function collectFableLoomEditorialDiagnostics(
  loom,
  dependencySnapshot = null,
  { playthroughReport = null } = {},
) {
  const { universe, voiceProfiles } = dependencySnapshot || await loadEditorialDependencies(loom);
  const outline = analyzeSeriesStoryOutlines(loom);
  const playthrough = playthroughReport || analyzeLoomPlaythroughs(loom);
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
  diagnostics.outline.issues.forEach((issue) => {
    lines.push(`- [outline/${issue.severity}] episode=${issue.episodeId || 'series'} scene=${issue.sceneKey || '-'} code=${issue.code}: ${issue.message}`);
  });
  diagnostics.episodes.forEach((episode) => {
    episode.graph.issues.forEach((issue) => {
      lines.push(`- [graph/${issue.severity}] episode=${episode.episodeId} node=${issue.nodeId || '-'} code=${issue.code}: ${issue.message}`);
    });
    episode.continuity.findings.forEach((finding) => {
      lines.push(`- [continuity/${finding.severity}] episode=${episode.episodeId} node=${finding.nodeId || '-'} code=${finding.code}: ${finding.message} Fix: ${finding.remediation}`);
    });
    asArray(episode.playtest?.issues).forEach((issue) => {
      lines.push(`- [playthrough/${issue.severity}] episode=${episode.episodeId} path=${issue.pathId || '-'} node=${issue.nodeId || '-'} code=${issue.code}: ${issue.message}`);
    });
  });
  return lines.join('\n');
};

const compactEditorialDiagnostics = (diagnostics) => {
  const findings = [
    ...diagnostics.outline.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => ({
        severity: 'high',
        category: 'structure',
        episodeId: issue.episodeId || null,
        nodeId: issue.sceneKey || null,
        pathId: null,
        problem: issue.message,
        suggestion: 'Repair and revalidate the complete episode beat outline.',
      })),
    ...diagnostics.episodes.flatMap((episode) => episode.graph.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => ({
        severity: 'high',
        category: 'structure',
        episodeId: episode.episodeId,
        nodeId: issue.nodeId || null,
        pathId: null,
        problem: issue.message,
        suggestion: 'Repair the episode graph contract before another playthrough review.',
      }))),
    ...diagnostics.episodes.flatMap((episode) => episode.continuity.findings
      .filter((finding) => finding.severity === 'error'
        || finding.code === CONTINUITY_CODES.AMBIGUOUS_CONVERGENCE)
      .map((finding) => ({
        severity: finding.severity === 'error' ? 'high' : 'medium',
        category: 'continuity',
        episodeId: episode.episodeId,
        nodeId: finding.nodeId || null,
        pathId: null,
        problem: finding.message,
        suggestion: finding.remediation || 'Repair the continuity break.',
      }))),
  ];
  return {
    passed: diagnostics.passed,
    stats: diagnostics.stats,
    findings: findings.slice(0, 80),
  };
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
const clearableSeriesPlanFields = new Set([
  'plotPoints', 'sideQuests', 'deliveryOptions', 'interEpisodeVoicemails', 'nextSeasonTeaser',
]);

const containsInstructionPlaceholder = (value) => {
  if (typeof value === 'string') return INSTRUCTION_PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.some(containsInstructionPlaceholder);
  if (value && typeof value === 'object') return Object.values(value).some(containsInstructionPlaceholder);
  return false;
};

const collectionHasContent = (value) => (
  (Array.isArray(value) && value.length > 0)
  || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0)
);

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const isOptionalId = (value) => value === undefined
  || (typeof value === 'string' && value.trim().length > 0);
const isPlanItem = (value) => isPlainObject(value)
  && isOptionalId(value.id)
  && typeof value.title === 'string'
  && typeof value.description === 'string';
const isEpisodeRef = (value, episodeIds) => value === undefined
  || value === null
  || (typeof value === 'string' && episodeIds.has(value));

const seriesPlanFieldValueIsValid = (key, value, episodeIds) => {
  if (key === 'storyArc') return typeof value === 'string';
  if (key === 'plotPoints') {
    return Array.isArray(value) && value.every((item) => (
      isPlanItem(item) && isEpisodeRef(item.episodeId, episodeIds)
    ));
  }
  if (key === 'sideQuests') {
    return Array.isArray(value) && value.every((item) => (
      isPlanItem(item)
      && ['idea', 'planned', 'active', 'resolved'].includes(item.status)
      && isEpisodeRef(item.startEpisodeId, episodeIds)
      && isEpisodeRef(item.endEpisodeId, episodeIds)
    ));
  }
  if (key === 'deliveryOptions') {
    return isPlainObject(value)
      && Object.keys(value).every((field) => ['overnightVoicemails', 'nextSeasonTeaser'].includes(field))
      && Object.values(value).every((field) => typeof field === 'boolean');
  }
  if (key === 'interEpisodeVoicemails') {
    return Array.isArray(value) && value.every((item) => (
      isPlainObject(item)
      && isOptionalId(item.id)
      && isEpisodeRef(item.fromEpisodeId, episodeIds)
      && isEpisodeRef(item.toEpisodeId, episodeIds)
      && typeof item.title === 'string'
      && typeof item.transcript === 'string'
    ));
  }
  if (key === 'nextSeasonTeaser') {
    return value === null || (isPlainObject(value)
      && typeof value.title === 'string'
      && typeof value.transcript === 'string');
  }
  return false;
};

const seriesPlanFieldValueIsClear = (key, value) => (
  (['plotPoints', 'sideQuests', 'interEpisodeVoicemails'].includes(key)
    && Array.isArray(value) && value.length === 0)
  || (key === 'deliveryOptions'
    && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  || (key === 'nextSeasonTeaser' && (
    value === null
    || (isPlainObject(value)
      && !value.title.trim()
      && !value.transcript.trim())
  ))
);

const applySeriesPlanPatch = (currentPlan, raw, explicitClears, episodeIds) => {
  if (!raw || typeof raw !== 'object') return currentPlan;
  const next = { ...currentPlan };
  for (const key of [
    'storyArc', 'plotPoints', 'sideQuests', 'deliveryOptions',
    'interEpisodeVoicemails', 'nextSeasonTeaser',
  ]) {
    if (!hasOwn(raw, key)) continue;
    if (!seriesPlanFieldValueIsValid(key, raw[key], episodeIds)) {
      throw aiShapeError(`The model returned an invalid value for seriesPlan.${key}`);
    }
    if (clearableSeriesPlanFields.has(key)
      && seriesPlanFieldValueIsClear(key, raw[key])
      && collectionHasContent(currentPlan?.[key])
      && !explicitClears.has(`seriesPlan.${key}`)) {
      throw aiShapeError(`The model tried to clear seriesPlan.${key} without listing it in clears`);
    }
    next[key] = key === 'deliveryOptions' && !seriesPlanFieldValueIsClear(key, raw[key])
      ? { ...(currentPlan?.deliveryOptions || {}), ...raw[key] }
      : raw[key];
  }
  return next;
};

const outlineRelevantEpisodeFingerprint = (episode) => JSON.stringify({
  title: episode.title,
  synopsis: episode.synopsis,
  startNodeId: episode.startNodeId,
  nodes: episode.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    playbackMode: node.playbackMode,
    audienceConnection: node.audienceConnection,
    protagonistPresence: node.protagonistPresence,
    isEnding: node.isEnding,
    endingLabel: node.endingLabel,
    transitions: asArray(node.transitions).map((transition) => ({
      targetNodeId: transition.targetNodeId,
      intent: transition.intent,
    })),
  })),
});

const assertOutlineMatchesExpandedEpisode = (episode, outline, participationMode) => {
  const sync = analyzeStoryOutlineTeleplaySync(episode, outline, { participationMode });
  if (sync.stats.matches) return;
  throw aiShapeError(`The model returned a stale outline for episode ${episode.id}: ${sync.issues[0].message}`);
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
  if (hasOwn(rawScene, 'transitions') && !Array.isArray(rawScene.transitions)) {
    throw aiShapeError(`The model returned invalid transitions for scene ${scene.id}`);
  }
  const returnedTransitionIds = new Set();
  for (const rawTransition of asArray(rawScene.transitions)) {
    if (!isPlainObject(rawTransition) || !hasText(rawTransition.id)) {
      throw aiShapeError(`The model returned a transition without an existing id for scene ${scene.id}`);
    }
    const transition = transitionsById.get(rawTransition?.id);
    if (!transition) {
      throw aiShapeError(`The model returned unknown transition id ${rawTransition.id} for scene ${scene.id}`);
    }
    if (returnedTransitionIds.has(transition.id)) {
      throw aiShapeError(`The model returned duplicate transition id ${transition.id} for scene ${scene.id}`);
    }
    returnedTransitionIds.add(transition.id);
    for (const key of allowedTransitionFields) {
      if (!hasOwn(rawTransition, key)) continue;
      const value = rawTransition[key];
      if (key === 'targetNodeId') {
        if (typeof value !== 'string' || !nodeIds.has(value)) {
          throw aiShapeError(`The model returned an invalid transition target for ${transition.id}`);
        }
        transition.targetNodeId = value;
      }
      if (['intent', 'description'].includes(key) && typeof value === 'string') transition[key] = value;
      if (key === 'triggers') {
        if (!Array.isArray(value) || value.some((trigger) => typeof trigger !== 'string')) {
          throw aiShapeError(`The model returned invalid triggers for transition ${transition.id}`);
        }
        transition.triggers = value;
      }
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

const graphErrorIdentities = (loom) => new Set(loom.episodes.flatMap((episode, index) => (
  analyzeEpisodeGraph(episode, {
    participationMode: loom.participationMode,
    requireAudienceIntroduction: index === 0,
  }).issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => JSON.stringify([
      episode.id,
      issue.code,
      issue.nodeId || null,
      issue.transitionId || null,
    ]))
)));

const outlineErrorIdentities = (loom) => new Set(analyzeSeriesStoryOutlines(loom).issues
  .filter((issue) => issue.severity === 'error')
  .map((issue) => JSON.stringify([
    issue.episodeId || null,
    issue.code,
    issue.sceneKey || null,
    Number.isInteger(issue.transitionIndex) ? issue.transitionIndex : null,
  ])));

const playthroughErrorIdentities = (report) => new Set(report.episodes.flatMap((episode) => (
  episode.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => JSON.stringify([
      episode.episodeId,
      issue.code,
      issue.nodeId || null,
      issue.transitionId || null,
    ]))
)));

const continuityBlockers = (loom, { universe = null, voiceProfiles = [] } = {}) => (
  loom.episodes.flatMap((episode) => analyzeEpisodeContinuity({
    loom,
    episode,
    universe,
    localVoiceProfiles: voiceProfiles,
  }).findings
    .filter((finding) => finding.severity === 'error'
      || finding.code === CONTINUITY_CODES.AMBIGUOUS_CONVERGENCE)
    .map((finding) => ({ episodeId: episode.id, ...finding })))
);

const continuityBlockerIdentities = (findings) => new Set(findings.map((finding) => JSON.stringify([
  finding.episodeId,
  finding.code,
  finding.severity,
  finding.nodeId || null,
  finding.characterId || null,
  finding.assetId || null,
])));

const hasIntroducedIdentity = (before, after) => [...after].some((identity) => !before.has(identity));

/**
 * Apply a model response to an in-memory loom while preserving graph
 * membership. Exported for focused contract tests and the persistence wrapper.
 */
export function applyFableLoomEditorialPatch(
  loom,
  content,
  { universe = null, voiceProfiles = [] } = {},
) {
  if (!content || typeof content !== 'object') throw aiShapeError('The model returned no editorial response');
  if (containsInstructionPlaceholder(content)) {
    throw aiShapeError('The model copied an instructional placeholder instead of returning authored story data');
  }
  const candidate = structuredClone(loom);
  const beforeGraphErrors = countGraphErrors(candidate);
  const beforeOutlineErrors = analyzeSeriesStoryOutlines(candidate).stats.errorCount;
  const beforePlaythrough = analyzeLoomPlaythroughs(candidate);
  const beforeContinuityBlockers = continuityBlockers(candidate, { universe, voiceProfiles });
  const beforeGraphErrorIdentities = graphErrorIdentities(candidate);
  const beforeOutlineErrorIdentities = outlineErrorIdentities(candidate);
  const beforePlaythroughErrorIdentities = playthroughErrorIdentities(beforePlaythrough);
  const beforeContinuityBlockerIdentities = continuityBlockerIdentities(beforeContinuityBlockers);
  const explicitClears = new Set(asArray(content.clears).filter((value) => typeof value === 'string'));
  if (hasOwn(content, 'episodes') && !Array.isArray(content.episodes)) {
    throw aiShapeError('The model returned an invalid episode patch list');
  }

  if (content.seriesPlan && typeof content.seriesPlan === 'object') {
    const episodeIds = new Set(candidate.episodes.map((episode) => episode.id));
    candidate.seriesPlan = applySeriesPlanPatch(
      candidate.seriesPlan,
      content.seriesPlan,
      explicitClears,
      episodeIds,
    );
  }
  const episodesById = new Map(candidate.episodes.map((episode) => [episode.id, episode]));
  const returnedEpisodeIds = new Set();
  for (const rawEpisode of asArray(content.episodes)) {
    if (!isPlainObject(rawEpisode) || !hasText(rawEpisode.id)) {
      throw aiShapeError('The model returned an episode patch without an existing id');
    }
    const episode = episodesById.get(rawEpisode?.id);
    if (!episode) throw aiShapeError(`The model returned unknown episode id ${rawEpisode.id}`);
    if (returnedEpisodeIds.has(episode.id)) {
      throw aiShapeError(`The model returned duplicate episode id ${episode.id}`);
    }
    returnedEpisodeIds.add(episode.id);
    const beforeOutlineContract = outlineRelevantEpisodeFingerprint(episode);
    const replacementOutline = hasOwn(rawEpisode, 'storyOutline')
      ? rawEpisode.storyOutline
      : undefined;
    for (const key of allowedEpisodeFields) {
      if (!hasOwn(rawEpisode, key)) continue;
      const value = rawEpisode[key];
      if (['title', 'synopsis'].includes(key) && typeof value === 'string') episode[key] = value;
      if (key === 'startNodeId') {
        if (typeof value !== 'string' || !episode.nodes.some((node) => node.id === value)) {
          throw aiShapeError(`The model returned an invalid opening scene for episode ${episode.id}`);
        }
        episode.startNodeId = value;
      }
    }
    const scenesById = new Map(episode.nodes.map((scene) => [scene.id, scene]));
    const continuitySourcePatches = [];
    if (hasOwn(rawEpisode, 'scenes') && !Array.isArray(rawEpisode.scenes)) {
      throw aiShapeError(`The model returned an invalid scene patch list for episode ${episode.id}`);
    }
    const returnedSceneIds = new Set();
    for (const rawScene of asArray(rawEpisode.scenes)) {
      if (!isPlainObject(rawScene) || !hasText(rawScene.id)) {
        throw aiShapeError(`The model returned a scene patch without an existing id for episode ${episode.id}`);
      }
      const scene = scenesById.get(rawScene?.id);
      if (!scene) throw aiShapeError(`The model returned unknown scene id ${rawScene.id}`);
      if (returnedSceneIds.has(scene.id)) {
        throw aiShapeError(`The model returned duplicate scene id ${scene.id}`);
      }
      returnedSceneIds.add(scene.id);
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
    const outlineContractChanged = beforeOutlineContract !== outlineRelevantEpisodeFingerprint(episode);
    if (replacementOutline !== undefined) {
      const storyOutline = sanitizeStoryOutline(replacementOutline, {
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
      assertOutlineMatchesExpandedEpisode(episode, storyOutline, candidate.participationMode);
      episode.storyOutline = {
        ...storyOutline,
        validation: {
          status: 'valid',
          issues: analysis.issues,
          validatedAt: new Date().toISOString(),
        },
      };
    } else if (outlineContractChanged && episode.storyOutline?.validation?.status === 'valid') {
      throw aiShapeError(`The model changed episode ${episode.id}'s outline contract without returning a synchronized storyOutline`);
    } else if (outlineContractChanged && episode.storyOutline) {
      episode.storyOutline.validation = { status: 'draft', issues: [] };
    }
  }

  for (const episode of candidate.episodes) {
    if (!episode.nodes.length || episode.storyOutline?.validation?.status !== 'valid') continue;
    const sync = analyzeStoryOutlineTeleplaySync(episode, episode.storyOutline, {
      participationMode: candidate.participationMode,
    });
    if (!sync.stats.matches) {
      throw aiShapeError(`Episode ${episode.id} has a stale validated outline; return a synchronized storyOutline before applying other edits`);
    }
  }

  const sanitized = sanitizeLoom(candidate);
  if (!sanitized) throw aiShapeError('The editorial response produced an invalid loom');
  const afterGraphErrors = countGraphErrors(sanitized);
  const afterOutlineErrors = analyzeSeriesStoryOutlines(sanitized).stats.errorCount;
  const afterPlaythrough = analyzeLoomPlaythroughs(sanitized);
  const afterContinuityBlockers = continuityBlockers(sanitized, { universe, voiceProfiles });
  const afterGraphErrorIdentities = graphErrorIdentities(sanitized);
  const afterOutlineErrorIdentities = outlineErrorIdentities(sanitized);
  const afterPlaythroughErrorIdentities = playthroughErrorIdentities(afterPlaythrough);
  const afterContinuityBlockerIdentities = continuityBlockerIdentities(afterContinuityBlockers);
  if (afterGraphErrors > beforeGraphErrors
    || hasIntroducedIdentity(beforeGraphErrorIdentities, afterGraphErrorIdentities)) {
    throw aiShapeError('The editorial response introduced new episode graph errors');
  }
  if (afterOutlineErrors > beforeOutlineErrors
    || hasIntroducedIdentity(beforeOutlineErrorIdentities, afterOutlineErrorIdentities)) {
    throw aiShapeError('The editorial response introduced new series-outline errors');
  }
  if ((beforePlaythrough.passed && !afterPlaythrough.passed)
    || afterPlaythrough.stats.errorCount > beforePlaythrough.stats.errorCount
    || afterPlaythrough.stats.nonEndingVariationCount > beforePlaythrough.stats.nonEndingVariationCount
    || hasIntroducedIdentity(beforePlaythroughErrorIdentities, afterPlaythroughErrorIdentities)) {
    throw aiShapeError('The editorial response introduced new playthrough failures');
  }
  if (afterContinuityBlockers.length > beforeContinuityBlockers.length
    || hasIntroducedIdentity(
      beforeContinuityBlockerIdentities,
      afterContinuityBlockerIdentities,
    )) {
    throw aiShapeError('The editorial response introduced new continuity blockers');
  }

  const before = editorialFingerprint(loom);
  const after = editorialFingerprint(sanitized);
  if (before === after && analysisStrings(content?.changes).length) {
    throw aiShapeError('The model claimed editorial changes but returned no applicable patch');
  }
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
  const dependencies = await loadEditorialDependencies(loom);
  const dependencyFingerprint = editorialDependencyFingerprint(dependencies);
  const diagnostics = await collectFableLoomEditorialDiagnostics(loom, dependencies);
  const stage = 'fableloom-editorial-remediate';
  const maxPromptChars = await resolveEditorialPromptBudgetChars(
    stage,
    { providerId, model, effort },
    'fableloom-editorial-remediate',
  );
  const variables = withCompletePlaythroughDigest({
    loom,
    report: diagnostics.playthrough,
    maxPromptChars,
    variables: {
      storyContext: storyContext(loom),
      canonDigest: dependencies.canonDigest || '(none)',
      seriesPlanJson: seriesPlanDigest(loom),
      teleplayDigest: teleplayDigest(loom),
      deterministicDigest: diagnosticLines(diagnostics),
      guidance: trimTo(guidance, 4000) || '(none)',
    },
  });
  const prompt = await renderEditorialPrompt(stage, variables, maxPromptChars);
  const { content, runId, status } = await runEditorialAi(stage, prompt, {
    providerId, model, effort, operationId,
  }, {
    action: 'editorial-remediate',
    label: 'Evaluating and remediating the FableLoom series',
    source: 'fableloom-editorial-remediate',
  });
  return finalizeEditorialOperation(status, runId, async () => {
    const evaluation = sanitizeEvaluation(content, loom);
    if (!evaluation.summary && !evaluation.strengths.length && !evaluation.findings.length) {
      throw aiShapeError('The model returned no usable editorial evaluation');
    }
    const applied = applyFableLoomEditorialPatch(loom, content, dependencies);
    let verifiedDependencies;
    const updated = applied.changed ? await mutateLoom(loomId, async (current) => {
      assertEditorialSnapshotUnchanged(current, fingerprint, {
        code: 'LOOM_CHANGED_DURING_GENERATION',
        message: 'The story changed while the editorial pass was running',
      });
      verifiedDependencies = await loadEditorialDependencies(current);
      assertEditorialDependenciesUnchanged(verifiedDependencies, dependencyFingerprint, {
        code: 'LOOM_DEPENDENCIES_CHANGED_DURING_GENERATION',
        message: 'Linked canon or voice profiles changed while the editorial pass was running',
      });
      return applied.loom;
    }) : await requireLoom(loomId);
    if (!applied.changed) {
      assertEditorialSnapshotUnchanged(updated, fingerprint, {
        code: 'LOOM_CHANGED_DURING_GENERATION',
        message: 'The story changed while the editorial pass was running',
      });
      verifiedDependencies = await loadEditorialDependencies(updated);
      assertEditorialDependenciesUnchanged(verifiedDependencies, dependencyFingerprint, {
        code: 'LOOM_DEPENDENCIES_CHANGED_DURING_GENERATION',
        message: 'Linked canon or voice profiles changed while the editorial pass was running',
      });
    }
    const afterDiagnostics = await collectFableLoomEditorialDiagnostics(
      updated,
      verifiedDependencies || dependencies,
    );
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
  });
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
  const fingerprint = editorialFingerprint(loom);
  const deterministic = analyzeLoomPlaythroughs(loom, { maxPaths });
  if (!aiReview) return { passed: deterministic.passed, deterministic, review: null, runId: null };
  const dependencies = await loadEditorialDependencies(loom);
  const dependencyFingerprint = editorialDependencyFingerprint(dependencies);
  const diagnostics = await collectFableLoomEditorialDiagnostics(
    loom,
    dependencies,
    { playthroughReport: deterministic },
  );
  const stage = 'fableloom-review-playthroughs';
  const maxPromptChars = await resolveEditorialPromptBudgetChars(
    stage,
    { providerId, model, effort },
    'fableloom-review-playthroughs',
  );
  const variables = withCompletePlaythroughDigest({
    loom,
    report: deterministic,
    maxPromptChars,
    variables: {
      storyContext: storyContext(loom),
      canonDigest: dependencies.canonDigest || '(none)',
      seriesPlanJson: seriesPlanDigest(loom),
      teleplayDigest: teleplayDigest(loom),
      deterministicDigest: diagnosticLines(diagnostics),
    },
  });
  const prompt = await renderEditorialPrompt(stage, variables, maxPromptChars);
  const { content, runId, status } = await runEditorialAi(stage, prompt, {
    providerId, model, effort, operationId,
  }, {
    action: 'review-playthroughs',
    label: 'Reviewing FableLoom playthrough variations',
    source: 'fableloom-review-playthroughs',
  });
  return finalizeEditorialOperation(status, runId, async () => {
    const current = await requireLoom(loomId);
    assertEditorialSnapshotUnchanged(current, fingerprint, {
      code: 'LOOM_CHANGED_DURING_REVIEW',
      message: 'The story changed while the playthrough review was running',
    });
    const currentDependencies = await loadEditorialDependencies(current);
    assertEditorialDependenciesUnchanged(currentDependencies, dependencyFingerprint, {
      code: 'LOOM_DEPENDENCIES_CHANGED_DURING_REVIEW',
      message: 'Linked canon or voice profiles changed while the playthrough review was running',
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
      diagnostics: compactEditorialDiagnostics(diagnostics),
      review,
      runId,
      qualityThreshold: AUTOPILOT_QUALITY_THRESHOLD,
    };
  });
}

export const __testing = {
  assertEditorialDependenciesUnchanged,
  assertEditorialPromptBudget,
  assertEditorialSnapshotUnchanged,
  compactEditorialDiagnostics,
  diagnosticLines,
  editorialDependencyFingerprint,
  editorialPromptBudgetChars,
  editorialPromptCharacterCount,
  editorialFingerprint,
  finalizeEditorialOperation,
  loadEditorialDependencies,
  renderEditorialPrompt,
  sanitizeEvaluation,
  sanitizePlaythroughReview,
  withCompletePlaythroughDigest,
};
