/**
 * FableLoom AI operations — weave (generate a full episode graph), branch
 * (grow new paths out of one scene), review (LLM story critique layered over
 * the deterministic graph analysis), and play (resolve a reader's free-text
 * intent into a graph transition).
 *
 * Every call here is triggered by a direct user action in the same request
 * (button click / chat message), per the AI Provider Usage Policy — nothing
 * fires at boot or in the background. LLM execution rides `runStagedLLM`, so
 * provider/model resolution, run records, and JSON extraction follow the same
 * rules as every other stage. Generated content is passed to `mutateLoom`
 * raw — the record sanitizer owns id minting, trims, and caps.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { runStagedLLM } from '../stageRunner.js';
import { isStr, trimTo } from '../../lib/storyBible.js';
import { resolveLlmRoutePin } from '../../lib/llmRoutePin.js';
import { renderCanonForPrompt } from '../../lib/universePromptRenderers.js';
import { GRAPH_ISSUE_CODES, analyzeEpisodeGraph, describeGraphForPrompt } from '../../lib/fableLoomGraph.js';
import {
  FABLELOOM_CAMERA_MOVEMENT_VALUES,
  fableLoomCameraMovementCatalogForPrompt,
  normalizeFableLoomCameraMovement,
} from '../../lib/fableLoomCameraMovements.js';
import { isFableLoomPlaybackMode } from '../../lib/fableLoomPlayback.js';
import {
  asFableLoomAudienceConnection,
  audienceCanParticipate,
  participationContractForPrompt,
} from '../../lib/fableLoomParticipation.js';
import { getUniverse } from '../universeBuilder.js';
import { LOOM_LIMITS, findEpisode, findNode, getLoom, mutateLoom } from './records.js';
import { asLoomFormat, loomFormatLabel, narrationFormatContract, sceneFormatContract } from './formats.js';

const TRANSCRIPT_TURNS_MAX = 12;
const AUDIENCE_GRAPH_ERROR_CODES = new Set([
  GRAPH_ISSUE_CODES.NO_AUDIENCE_CONNECTION,
  GRAPH_ISSUE_CODES.DISCONNECTED_DECISION,
]);

const clamp = (value, min, max, fallback) =>
  (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);

const aiShapeError = (message) =>
  new ServerError(message, { status: 502, code: 'AI_RESPONSE_INVALID' });

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

/**
 * Routing for a play turn: an explicit per-call pick beats the loom's saved
 * play settings, which beat the stage pin. The loom's settings use the HARD
 * overrides deliberately — the author chose this narrator for this story, so
 * it outranks a global stage pin the same way a per-call pick does.
 *
 * The never-cross-providers rule (a pinned model/effort is inherited only
 * while the effective provider still matches) comes from the shared resolver
 * in `server/lib/llmRoutePin.js`.
 */
const playRouting = (loom, perCall) => resolveLlmRoutePin(loom.playSettings, perCall);

/**
 * Render the linked universe's canon as a prompt digest via the shared
 * renderer (field precedence, per-kind caps, and the "+ N more" truncation
 * footer every generative prompt gets). Empty string when the loom has no
 * universe — the stages treat it as optional.
 */
export async function buildCanonDigest(loom) {
  if (!loom.universeId) return '';
  const universe = await getUniverse(loom.universeId).catch(() => null);
  return universe ? renderCanonForPrompt(universe) : '';
}

const seriesPlanContext = (loom, episode) => {
  const plan = loom.seriesPlan;
  if (!plan) return [];
  const episodeLabels = new Map(loom.episodes.map((item) => [item.id, `Episode ${item.number}: ${item.title || 'Untitled'}`]));
  const relevantFirst = (items, matchesEpisode) => episode
    ? [...items].sort((a, b) => Number(matchesEpisode(b, episode.id)) - Number(matchesEpisode(a, episode.id)))
    : items;
  const plotPoints = relevantFirst(plan.plotPoints || [], (item, id) => item.episodeId === id)
    .slice(0, 12)
    .map((item, index) => {
      const assignment = item.episodeId ? ` [planned for ${episodeLabels.get(item.episodeId) || item.episodeId}]` : ' [unassigned]';
      return `Plot point ${index + 1}${assignment}: ${item.title || 'Untitled'}${item.description ? ` — ${trimTo(item.description, 300)}` : ''}`;
    });
  const sideQuests = relevantFirst(plan.sideQuests || [], (item, id) => item.startEpisodeId === id || item.endEpisodeId === id)
    .slice(0, 12)
    .map((item) => {
      const start = item.startEpisodeId ? episodeLabels.get(item.startEpisodeId) || item.startEpisodeId : 'unassigned';
      const end = item.endEpisodeId ? episodeLabels.get(item.endEpisodeId) || item.endEpisodeId : 'unassigned';
      return `Side quest (${item.status}; starts ${start}; ends ${end}): ${item.title || 'Untitled'}${item.description ? ` — ${trimTo(item.description, 300)}` : ''}`;
    });
  return [
    plan.storyArc ? `Series arc: ${trimTo(plan.storyArc, 4000)}` : '',
    ...plotPoints,
    ...sideQuests,
  ].filter(Boolean);
};

const requiresAudienceIntroduction = (loom, episode) => (
  !episode || episode.id === loom.episodes[0]?.id
);

const audienceContract = (loom, episode) => participationContractForPrompt(loom, {
  requiresIntroduction: requiresAudienceIntroduction(loom, episode),
});

const storyContext = (loom, episode) => [
  `Story: ${loom.name}`,
  `Scene format: ${loomFormatLabel(loom.format)}`,
  `Audience participation: ${audienceContract(loom, episode)}`,
  loom.logline ? `Logline: ${loom.logline}` : '',
  loom.premise ? `Premise: ${loom.premise}` : '',
  ...seriesPlanContext(loom, episode),
  episode ? `Episode ${episode.number}: ${episode.title || 'Untitled'}` : '',
  episode?.synopsis ? `Synopsis: ${episode.synopsis}` : '',
].filter(Boolean).join('\n');

const seriesPlanDigest = (loom) => JSON.stringify({
  storyArc: trimTo(loom.seriesPlan?.storyArc, 6000),
  plotPoints: (loom.seriesPlan?.plotPoints || []).map((item) => ({
    ...item, description: trimTo(item.description, 400),
  })),
  sideQuests: (loom.seriesPlan?.sideQuests || []).map((item) => ({
    ...item, description: trimTo(item.description, 400),
  })),
  episodes: loom.episodes.map(({ id, number, title, synopsis }) => ({
    id, number, title, synopsis: trimTo(synopsis, 300),
  })),
}, null, 2);

// A full-plan draft replaces the whole scaffold after a potentially slow
// provider call. Capture every authored input the stage read so a save made
// while that call is in flight cannot be overwritten by a stale response.
const seriesPlanGenerationFingerprint = (loom) => JSON.stringify({
  name: loom.name,
  logline: loom.logline,
  premise: loom.premise,
  format: loom.format,
  universeId: loom.universeId,
  seriesPlan: loom.seriesPlan,
  episodes: loom.episodes.map(({ id, number, title, synopsis }) => ({ id, number, title, synopsis })),
});

// --- Weave: generate a full episode graph -----------------------------------

// Raw generated node fields, passed through for the sanitizer to trim/cap.
const generatedNodeFields = (raw) => ({
  title: raw.title,
  prose: raw.prose,
  imagePrompt: raw.imagePrompt,
  videoPrompt: raw.videoPrompt,
  cameraMovement: raw.cameraMovement,
  playbackMode: raw.playbackMode,
  audienceConnection: raw.audienceConnection,
  isEnding: raw.isEnding === true,
  endingLabel: raw.endingLabel,
});

/**
 * Map an LLM graph (`{ startKey, nodes: [{ key, …, transitions: [{ targetKey,
 * … }] }] }`) onto server-minted node ids. Transitions pointing at unknown
 * keys or back at their own node are dropped. Throws AI_RESPONSE_INVALID when
 * the shape is unusable (too few scenes, no ending).
 */
export function mapGeneratedGraph(parsed) {
  // First occurrence wins on a duplicated key — keeping both would mint two
  // nodes sharing one id, which corrupts every by-id lookup downstream.
  const seenKeys = new Set();
  const rawNodes = (Array.isArray(parsed?.nodes) ? parsed.nodes : [])
    .filter((n) => n && typeof n === 'object' && isStr(n.key)
      && !seenKeys.has(n.key) && seenKeys.add(n.key));
  if (rawNodes.length < 2) throw aiShapeError('The model returned too few scenes to form a story graph');
  const idByKey = new Map();
  for (const raw of rawNodes.slice(0, LOOM_LIMITS.NODES_MAX)) {
    idByKey.set(raw.key, `node-${randomUUID()}`);
  }
  const nodes = rawNodes.slice(0, LOOM_LIMITS.NODES_MAX).map((raw) => ({
    id: idByKey.get(raw.key),
    ...generatedNodeFields(raw),
    transitions: (Array.isArray(raw.transitions) ? raw.transitions : [])
      .filter((t) => t && typeof t === 'object' && idByKey.has(t.targetKey) && idByKey.get(t.targetKey) !== idByKey.get(raw.key))
      .map(({ targetKey, intent, triggers, description }) => ({
        targetNodeId: idByKey.get(targetKey), intent, triggers, description,
      })),
    pos: null,
  }));
  if (!nodes.some((n) => n.isEnding)) throw aiShapeError('The model returned a graph with no endings');
  const startNodeId = idByKey.get(parsed?.startKey) ?? nodes[0].id;
  return { nodes, startNodeId };
}

export async function weaveEpisode(loomId, episodeId, {
  guidance = '', replace = false, providerId, model, effort,
} = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  if (episode.nodes.length && !replace) {
    throw new ServerError('Episode already has scenes — pass replace to regenerate', { status: 409, code: 'EPISODE_NOT_EMPTY' });
  }
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runStagedLLM('fableloom-weave-episode', {
    storyContext: storyContext(loom, episode),
    canonDigest: canonDigest || '(none — invent what the story needs)',
    guidance: guidance || '(none)',
    existingGraph: episode.nodes.length
      ? describeGraphForPrompt(episode, { proseLimit: 1200, participationMode: loom.participationMode })
      : '(none — create the episode from the story context)',
    cameraMovementCatalog: fableLoomCameraMovementCatalogForPrompt(),
    sceneFormatContract: sceneFormatContract(loom.format),
    participationContract: audienceContract(loom, episode),
  }, llmOptions({ providerId, model, effort }, 'fableloom-weave'));

  const { nodes, startNodeId } = mapGeneratedGraph(content);
  if (loom.participationMode === 'helper') {
    const audienceErrors = analyzeEpisodeGraph(
      { ...episode, nodes, startNodeId },
      {
        participationMode: 'helper',
        requireAudienceIntroduction: requiresAudienceIntroduction(loom, episode),
      },
    ).issues.filter((issue) => issue.severity === 'error' && (
      AUDIENCE_GRAPH_ERROR_CODES.has(issue.code)
      || (issue.code === GRAPH_ISSUE_CODES.CUT_TRANSITION_COUNT
        && nodes.find((node) => node.id === issue.nodeId)?.audienceConnection !== 'connected')
    ));
    if (audienceErrors.length) {
      throw aiShapeError(`The model returned an invalid audience connection graph: ${audienceErrors[0].message}`);
    }
  }
  const updated = await mutateLoom(loomId, (current) => {
    const ep = findEpisode(current, episodeId);
    // Stamped with the format they were generated in, so a later reformat can
    // tell them apart from scenes already in the target format.
    ep.nodes = nodes.map((n) => ({ ...n, format: asLoomFormat(loom.format) }));
    ep.startNodeId = startNodeId;
    ep.updatedAt = new Date().toISOString();
    return current;
  });
  return { loom: updated, episodeId, runId };
}

// --- Branch: grow new paths out of one scene --------------------------------

export async function branchNode(loomId, episodeId, nodeId, {
  guidance = '', branchCount, providerId, model, effort,
} = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const node = findNode(episode, nodeId);
  if (!audienceCanParticipate(loom, node)) {
    throw new ServerError('The audience cannot branch this scene until its communication channel is connected', {
      status: 409,
      code: 'AUDIENCE_DISCONNECTED',
    });
  }
  const count = clamp(branchCount, 1, 4, 2);

  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runStagedLLM('fableloom-branch-node', {
    storyContext: storyContext(loom, episode),
    canonDigest: canonDigest || '(none — invent what the story needs)',
    graphDigest: describeGraphForPrompt(episode, {
      proseLimit: 200,
      participationMode: loom.participationMode,
    }),
    sceneTitle: node.title || 'Untitled scene',
    sceneProse: node.prose || '(no prose yet)',
    branchCount: String(count),
    cameraMovementCatalog: fableLoomCameraMovementCatalogForPrompt(),
    guidance: guidance || '(none)',
    sceneFormatContract: sceneFormatContract(loom.format),
    participationContract: audienceContract(loom, episode),
  }, llmOptions({ providerId, model, effort }, 'fableloom-branch'));

  const branches = Array.isArray(content?.branches)
    ? content.branches.filter((b) => b && typeof b === 'object' && b.node && typeof b.node === 'object').slice(0, count)
    : [];
  if (!branches.length) throw aiShapeError('The model returned no usable branches');

  const updated = await mutateLoom(loomId, (current) => {
    const ep = findEpisode(current, episodeId);
    const source = findNode(ep, nodeId);
    // Asking for branches turns the source into an interactive choice point.
    // This prevents an automatic cut from retaining ambiguous outgoing paths.
    source.playbackMode = 'decision';
    for (const branch of branches) {
      if (ep.nodes.length >= LOOM_LIMITS.NODES_MAX) break;
      const newNode = {
        id: `node-${randomUUID()}`,
        ...generatedNodeFields(branch.node),
        playbackMode: 'decision',
        audienceConnection: 'connected',
        format: asLoomFormat(loom.format),
        transitions: [],
        pos: null,
      };
      ep.nodes.push(newNode);
      source.transitions = [...(source.transitions || []), {
        targetNodeId: newNode.id,
        intent: branch.intent,
        triggers: branch.triggers,
        description: branch.description,
      }];
    }
    ep.updatedAt = new Date().toISOString();
    return current;
  });
  return { loom: updated, episodeId, nodeId, runId };
}

// --- Review: LLM critique over the deterministic analysis -------------------

const REVIEW_SEVERITIES = new Set(['high', 'medium', 'low']);

export async function reviewEpisode(loomId, episodeId, { providerId, model, effort } = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const structural = analyzeEpisodeGraph(episode, {
    participationMode: loom.participationMode,
    requireAudienceIntroduction: requiresAudienceIntroduction(loom, episode),
  });
  const { content, runId } = await runStagedLLM('fableloom-review', {
    storyContext: storyContext(loom, episode),
    graphDigest: describeGraphForPrompt(episode, { participationMode: loom.participationMode }),
    structuralDigest: structural.issues.length
      ? structural.issues.map((i) => `- [${i.severity}] ${i.message}`).join('\n')
      : '(no structural issues)',
  }, llmOptions({ providerId, model, effort }, 'fableloom-review'));

  const nodeIds = new Set(episode.nodes.map((n) => n.id));
  const findings = (Array.isArray(content?.findings) ? content.findings : [])
    .filter((f) => f && typeof f === 'object' && isStr(f.problem))
    .map((f) => ({
      severity: REVIEW_SEVERITIES.has(f.severity) ? f.severity : 'medium',
      nodeId: nodeIds.has(f.nodeId) ? f.nodeId : null,
      problem: trimTo(f.problem, 1000),
      suggestion: trimTo(f.suggestion, 1000),
    }));
  return {
    structural,
    review: { summary: trimTo(content?.summary, 2000), findings },
    runId,
  };
}

// --- Feedback: apply a conversational episode edit --------------------------

const FEEDBACK_NODE_FIELDS = [
  'title', 'prose', 'imagePrompt', 'videoPrompt', 'cameraMovement', 'playbackMode',
  'audienceConnection', 'isEnding', 'endingLabel',
];
const FEEDBACK_TRANSITION_FIELDS = ['targetNodeId', 'intent', 'triggers', 'description'];
const FEEDBACK_STRING_NODE_FIELDS = new Set(['title', 'prose', 'imagePrompt', 'videoPrompt', 'endingLabel']);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Keep feedback edits sparse and graph-safe. The model may revise metadata,
 * scene content, and the labels/details of existing paths, but it cannot mint
 * or delete scene/transition records. This makes a conversational edit useful
 * without allowing a malformed response to silently change graph membership.
 */
const normalizeFeedbackPatch = (content, episode) => {
  if (!content || typeof content !== 'object') throw aiShapeError('The model returned no episode feedback edits');

  const episodePatch = {};
  for (const key of ['title', 'synopsis']) {
    if (hasOwn(content, key) && typeof content[key] === 'string') episodePatch[key] = content[key];
  }

  const nodeIds = new Set(episode.nodes.map((node) => node.id));
  const scenePatches = [];
  for (const rawScene of Array.isArray(content.scenes) ? content.scenes : []) {
    if (!rawScene || typeof rawScene !== 'object' || !nodeIds.has(rawScene.id)) continue;
    const nodePatch = { id: rawScene.id };
    for (const key of FEEDBACK_NODE_FIELDS) {
      const value = rawScene[key];
      if (!hasOwn(rawScene, key)) continue;
      if (FEEDBACK_STRING_NODE_FIELDS.has(key) && typeof value === 'string') {
        nodePatch[key] = value;
      } else if (key === 'cameraMovement' && typeof value === 'string') {
        const movement = normalizeFableLoomCameraMovement(value);
        if (!movement || FABLELOOM_CAMERA_MOVEMENT_VALUES.includes(movement)) nodePatch[key] = movement;
      } else if (key === 'playbackMode' && isFableLoomPlaybackMode(value)) {
        nodePatch[key] = value;
      } else if (key === 'audienceConnection' && ['connected', 'disconnected'].includes(value)) {
        nodePatch[key] = value;
      } else if (key === 'isEnding' && typeof value === 'boolean') {
        nodePatch[key] = value;
      }
    }

    const node = episode.nodes.find((candidate) => candidate.id === rawScene.id);
    const transitionIds = new Set((node.transitions || []).map((transition) => transition.id));
    const transitions = [];
    if (hasOwn(rawScene, 'transitions') && Array.isArray(rawScene.transitions)) {
      for (const rawTransition of rawScene.transitions) {
        if (!rawTransition || typeof rawTransition !== 'object' || !transitionIds.has(rawTransition.id)) continue;
        const transitionPatch = { id: rawTransition.id };
        for (const key of FEEDBACK_TRANSITION_FIELDS) {
          const value = rawTransition[key];
          if (!hasOwn(rawTransition, key)) continue;
          if (key === 'targetNodeId' && typeof value === 'string' && nodeIds.has(value)) transitionPatch[key] = value;
          if (key === 'intent' && typeof value === 'string') transitionPatch[key] = value;
          if (key === 'description' && typeof value === 'string') transitionPatch[key] = value;
          if (key === 'triggers' && Array.isArray(value)) transitionPatch[key] = value;
        }
        if (Object.keys(transitionPatch).length > 1) transitions.push(transitionPatch);
      }
    }
    if (transitions.length) nodePatch.transitions = transitions;
    if (Object.keys(nodePatch).length > 1) scenePatches.push(nodePatch);
  }

  if (!Object.keys(episodePatch).length && !scenePatches.length) {
    throw aiShapeError('The model returned no usable episode feedback edits');
  }
  return { episodePatch, scenePatches };
};

/**
 * Apply one natural-language author instruction to an existing episode. The
 * prompt asks for sparse edits, so omitted fields preserve their authored
 * values while present empty strings intentionally clear them. The graph's
 * scene and path membership stays stable; use the scene/branch controls when
 * records need to be added or removed.
 */
export async function feedbackEpisode(loomId, episodeId, {
  feedback, providerId, model, effort,
} = {}) {
  const instruction = trimTo(feedback, LOOM_LIMITS.FEEDBACK_MAX);
  if (!instruction) {
    throw new ServerError('Episode feedback is required', { status: 400, code: 'FEEDBACK_REQUIRED' });
  }
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runStagedLLM('fableloom-feedback-episode', {
    storyContext: storyContext(loom, episode),
    canonDigest: canonDigest || '(none)',
    graphDigest: describeGraphForPrompt(episode, {
      proseLimit: 1200,
      participationMode: loom.participationMode,
    }),
    cameraMovementCatalog: fableLoomCameraMovementCatalogForPrompt(),
    feedback: instruction,
  }, llmOptions({ providerId, model, effort }, 'fableloom-feedback'));

  const { episodePatch, scenePatches } = normalizeFeedbackPatch(content, episode);
  const updated = await mutateLoom(loomId, (current) => {
    const currentEpisode = findEpisode(current, episodeId);
    for (const key of ['title', 'synopsis']) {
      if (hasOwn(episodePatch, key)) currentEpisode[key] = episodePatch[key];
    }
    for (const scenePatch of scenePatches) {
      const node = currentEpisode.nodes.find((candidate) => candidate.id === scenePatch.id);
      if (!node) continue;
      for (const key of FEEDBACK_NODE_FIELDS) {
        if (hasOwn(scenePatch, key)) node[key] = scenePatch[key];
      }
      for (const transitionPatch of scenePatch.transitions || []) {
        const transition = (node.transitions || []).find((candidate) => candidate.id === transitionPatch.id);
        if (!transition) continue;
        for (const key of FEEDBACK_TRANSITION_FIELDS) {
          if (hasOwn(transitionPatch, key)) transition[key] = transitionPatch[key];
        }
      }
    }
    currentEpisode.updatedAt = new Date().toISOString();
    return current;
  });
  return {
    loom: updated,
    episodeId,
    changedScenes: scenePatches.length,
    runId,
  };
}

// --- Series plan: generation, holistic guidance, and conversational editing --

const analysisStrings = (value) => (Array.isArray(value) ? value : [])
  .filter((item) => typeof item === 'string')
  .map((item) => trimTo(item, 1000))
  .filter(Boolean)
  .slice(0, 12);

/**
 * Draft the complete series-level scaffold from the story metadata, linked
 * universe canon, current episode outline, and any useful ideas already in the
 * plan. This intentionally replaces only `seriesPlan`; episode records and
 * scene graphs remain untouched.
 */
export async function generateSeriesPlan(loomId, { providerId, model, effort } = {}) {
  const loom = await requireLoom(loomId);
  const sourceFingerprint = seriesPlanGenerationFingerprint(loom);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runStagedLLM('fableloom-generate-series-plan', {
    storyContext: storyContext(loom),
    canonDigest: canonDigest || '(none — invent only what the premise needs)',
    seriesPlanJson: seriesPlanDigest(loom),
  }, llmOptions({ providerId, model, effort }, 'fableloom-generate-series-plan'));

  const storyArc = isStr(content?.storyArc) ? content.storyArc : '';
  const isUsablePlanItem = (item) => item && typeof item === 'object'
    && ((isStr(item.title) && item.title.trim()) || (isStr(item.description) && item.description.trim()));
  const plotPoints = (Array.isArray(content?.plotPoints) ? content.plotPoints : [])
    .filter(isUsablePlanItem);
  const sideQuests = (Array.isArray(content?.sideQuests) ? content.sideQuests : [])
    .filter(isUsablePlanItem);
  if (!storyArc.trim() || !plotPoints.length || !sideQuests.length) {
    throw aiShapeError('The model did not return a complete series-plan scaffold');
  }

  const updated = await mutateLoom(loomId, (current) => {
    if (seriesPlanGenerationFingerprint(current) !== sourceFingerprint) {
      throw new ServerError('The story changed while its plan was being drafted', {
        status: 409,
        code: 'LOOM_CHANGED_DURING_GENERATION',
      });
    }
    current.seriesPlan = { storyArc, plotPoints, sideQuests };
    return current;
  });
  return { loom: updated, runId };
}

/** Read-only story-editor pass over the arc, tentpole beats, side quests, and episode outline. */
export async function reviewSeriesPlan(loomId, { providerId, model, effort } = {}) {
  const loom = await requireLoom(loomId);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runStagedLLM('fableloom-review-series-plan', {
    storyContext: storyContext(loom),
    canonDigest: canonDigest || '(none)',
    seriesPlanJson: seriesPlanDigest(loom),
  }, llmOptions({ providerId, model, effort }, 'fableloom-review-series-plan'));
  const analysis = {
    summary: trimTo(content?.summary, 2000),
    strengths: analysisStrings(content?.strengths),
    risks: analysisStrings(content?.risks),
    recommendations: analysisStrings(content?.recommendations),
  };
  if (!analysis.summary && !analysis.strengths.length && !analysis.risks.length && !analysis.recommendations.length) {
    throw aiShapeError('The model returned no usable series analysis');
  }
  return {
    analysis,
    runId,
  };
}

/** Apply one author instruction to the series-level plan without touching episode scene graphs. */
export async function feedbackSeriesPlan(loomId, {
  feedback, providerId, model, effort,
} = {}) {
  const instruction = trimTo(feedback, LOOM_LIMITS.FEEDBACK_MAX);
  if (!instruction) {
    throw new ServerError('Series-plan feedback is required', { status: 400, code: 'FEEDBACK_REQUIRED' });
  }
  const loom = await requireLoom(loomId);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runStagedLLM('fableloom-feedback-series-plan', {
    storyContext: storyContext(loom),
    canonDigest: canonDigest || '(none)',
    seriesPlanJson: seriesPlanDigest(loom),
    feedback: instruction,
  }, llmOptions({ providerId, model, effort }, 'fableloom-feedback-series-plan'));

  if (!content || typeof content !== 'object') {
    throw aiShapeError('The model returned no series-plan edits');
  }
  const hasPlanEdit = (hasOwn(content, 'storyArc') && typeof content.storyArc === 'string')
    || Array.isArray(content.plotPointEdits) || Array.isArray(content.plotPointOrder)
    || Array.isArray(content.sideQuestEdits) || Array.isArray(content.sideQuestOrder);
  if (!hasPlanEdit) throw aiShapeError('The model returned no usable series-plan edits');

  const updated = await mutateLoom(loomId, (current) => {
    const plan = { ...current.seriesPlan };
    if (hasOwn(content, 'storyArc') && typeof content.storyArc === 'string') plan.storyArc = content.storyArc;
    plan.plotPoints = applyPlanItemEdits(plan.plotPoints, content.plotPointEdits, content.plotPointOrder, {
      prefix: 'plot', fields: ['title', 'description', 'episodeId'],
    });
    plan.sideQuests = applyPlanItemEdits(plan.sideQuests, content.sideQuestEdits, content.sideQuestOrder, {
      prefix: 'quest', fields: ['title', 'description', 'status', 'startEpisodeId', 'endEpisodeId'],
    });
    current.seriesPlan = plan;
    return current;
  });
  return {
    loom: updated,
    changes: analysisStrings(content.changes),
    runId,
  };
}

function applyPlanItemEdits(currentItems = [], rawEdits, rawOrder, { prefix, fields }) {
  const items = currentItems.map((item) => ({ ...item }));
  const byId = new Map(items.map((item) => [item.id, item]));
  const removed = new Set();
  for (const edit of (Array.isArray(rawEdits) ? rawEdits : []).slice(0, LOOM_LIMITS.PLAN_ITEMS_MAX)) {
    if (!edit || typeof edit !== 'object') continue;
    if (typeof edit.id === 'string' && byId.has(edit.id)) {
      if (edit.remove === true) {
        removed.add(edit.id);
        continue;
      }
      const item = byId.get(edit.id);
      for (const field of fields) {
        if (hasOwn(edit, field)) item[field] = edit[field];
      }
      continue;
    }
    if (!edit.id && edit.remove !== true) {
      const item = { id: `${prefix}-${randomUUID()}` };
      for (const field of fields) {
        if (hasOwn(edit, field)) item[field] = edit[field];
      }
      items.push(item);
      byId.set(item.id, item);
    }
  }
  const kept = items.filter((item) => !removed.has(item.id));
  if (!Array.isArray(rawOrder)) return kept;
  const order = rawOrder.filter((id) => typeof id === 'string' && byId.has(id) && !removed.has(id));
  const ranked = new Map(order.map((id, index) => [id, index]));
  return [...kept].sort((a, b) => (ranked.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ranked.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

// --- Play: resolve a reader's free-text intent ------------------------------

/** Reader-facing scene shape — trigger phrases stay server-side. */
export const publicNode = (node) => ({
  id: node.id,
  title: node.title,
  prose: node.prose,
  image: node.image,
  videoHistoryId: node.videoHistoryId,
  playbackMode: node.playbackMode,
  audienceConnection: asFableLoomAudienceConnection(node.audienceConnection),
  isEnding: node.isEnding,
  endingLabel: node.endingLabel,
  choices: (node.transitions || []).map((t) => ({ id: t.id, intent: t.intent })),
});

const transcriptDigest = (transcript) =>
  (Array.isArray(transcript) ? transcript : [])
    .filter((t) => t && typeof t === 'object' && isStr(t.text))
    .slice(-TRANSCRIPT_TURNS_MAX)
    .map((t) => `${t.role === 'reader' ? 'Reader' : 'Narrator'}: ${trimTo(t.text, 500)}`)
    .join('\n');

/**
 * Advance one play turn.
 *
 * Two lanes, and the cheap one is the default: when the reader TAPPED a path
 * (`transitionId`), there is no intent to map, so the move resolves straight
 * off the graph — no provider call, no latency, no spend. Free text goes
 * through the play stage, which either matches a path or answers in-world.
 */
export async function playTurn(loomId, episodeId, {
  nodeId, message, transitionId, transcript = [], providerId, model, effort,
} = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const node = findNode(episode, nodeId);
  if (node.isEnding || !(node.transitions || []).length) {
    return { action: 'stay', narration: '', node: publicNode(node), ended: true, resolvedBy: 'graph' };
  }

  if (transitionId) {
    const interactive = audienceCanParticipate(loom, node);
    const taken = interactive
      ? node.transitions.find((t) => t.id === transitionId)
      : node.transitions[0];
    if (!taken) {
      throw new ServerError('That path is not on this scene', { status: 400, code: 'INVALID_TRANSITION' });
    }
    return moveResult(episode, node, taken, {
      narration: '',
      resolvedBy: interactive ? 'choice' : 'graph',
    });
  }

  if (!audienceCanParticipate(loom, node)) {
    throw new ServerError('The audience communication channel is not connected in this scene', {
      status: 409,
      code: 'AUDIENCE_DISCONNECTED',
    });
  }

  const choicesDigest = node.transitions.map((t) => [
    `- id: ${t.id}`,
    `  intent: ${t.intent}`,
    t.triggers.length ? `  example phrasings: ${t.triggers.join('; ')}` : null,
    t.description ? `  leads to: ${t.description}` : null,
  ].filter(Boolean).join('\n')).join('\n');

  const { content, runId } = await runStagedLLM('fableloom-play-turn', {
    storyContext: storyContext(loom, episode),
    sceneProse: node.prose || node.title || '',
    choicesDigest,
    transcriptDigest: transcriptDigest(transcript) || '(start of the read-through)',
    readerMessage: trimTo(message, 1000),
    narrationFormatContract: narrationFormatContract(loom.format),
  }, llmOptions(playRouting(loom, { providerId, model, effort }), 'fableloom-play'));

  const narration = trimTo(content?.narration, 4000);
  const chosen = content?.action === 'move'
    ? node.transitions.find((t) => t.id === content?.transitionId)
    : null;
  // No usable choice — including a dangling edge whose target was deleted —
  // stays in place rather than crashing the read.
  if (!chosen) {
    return { action: 'stay', narration, node: publicNode(node), ended: false, resolvedBy: 'llm', runId };
  }
  return moveResult(episode, node, chosen, { narration, resolvedBy: 'llm', runId });
}

/**
 * Resolve a chosen transition to its target scene. A dangling edge (target
 * deleted since the graph was woven) keeps the reader where they are rather
 * than ending the read-through on a crash.
 */
function moveResult(episode, node, transition, { narration = '', resolvedBy, runId } = {}) {
  const next = episode.nodes.find((n) => n.id === transition.targetNodeId);
  const common = { narration, resolvedBy, ...(runId ? { runId } : {}) };
  return next
    ? { action: 'move', transitionId: transition.id, node: publicNode(next), ended: next.isEnding === true, ...common }
    : { action: 'stay', node: publicNode(node), ended: false, ...common };
}

// --- Reformat: rewrite existing scenes into another format ------------------

// Scenes per LLM call. Small enough that one refusal or truncation costs a
// handful of scenes rather than the episode, large enough that a 13-scene
// episode is three calls, not thirteen.
const REFORMAT_CHUNK = 5;
// Hard ceiling on provider calls per request: 20 scenes. Enough that an
// ordinary episode is one round trip, few enough that a 200-scene episode (the
// record's own cap) can't hold a connection open for the 40 sequential calls it
// would otherwise take. A run that stops here says so with `capped`, and the
// caller simply asks again: each scene is stamped with the format it was written
// in as it lands, so the next pass picks up exactly where this one stopped
// instead of re-sending converted scenes and stalling in the same place forever.
const REFORMAT_CHUNKS_MAX = 4;

// A scene needs rewriting when it HAS prose and that prose isn't already in the
// target format. Title-only placeholders are skipped, not sent: a rewrite
// prompt whose rule is "every beat must survive" has nothing to preserve in an
// empty scene, so the model invents one and it lands on the node as if authored.
const needsReformat = (node, target) => isStr(node.prose) && !!node.prose.trim() && node.format !== target;

/** Scenes across the WHOLE loom still waiting to be rewritten into `target`. */
const unconvertedSceneCount = (loom, target) => loom.episodes.reduce(
  (total, ep) => total + ep.nodes.filter((n) => needsReformat(n, target)).length, 0,
);

/**
 * Rewrite one episode's scenes into `format` (prose ⇄ teleplay), and pin the
 * loom to that format once — and only once — every episode is converted.
 *
 * Episode-scoped on purpose: rewriting a whole loom in one request meant tens
 * of sequential provider calls behind a single held connection, long enough for
 * a proxy or fetch timeout to kill the response while the server kept writing
 * (#4794). The client walks the episodes and shows which one is in flight; each
 * request is bounded by one episode's scenes.
 *
 * Each chunk is persisted as it lands: a provider failure halfway through
 * leaves the already-rewritten scenes rewritten, and re-running finishes the
 * job rather than starting over. The format pin is written LAST and only once
 * EVERY scene in the loom is converted — a loom still holding unconverted
 * scenes must not claim a format its story isn't in, or every later
 * weave/branch/play generates against a contract that story doesn't follow.
 * Keeping that check on the server rather than in the client's loop means a
 * browser closed mid-walk can't leave the loom pinned to a format half its
 * scenes are not in.
 */
export async function reformatEpisodeScenes(loomId, episodeId, { format, providerId, model, effort } = {}) {
  const target = asLoomFormat(format);
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const canonDigest = await buildCanonDigest(loom);
  const runIds = [];
  const nodes = episode.nodes.filter((n) => needsReformat(n, target));
  let rewritten = 0;
  let chunks = 0;

  for (let i = 0; i < nodes.length && chunks < REFORMAT_CHUNKS_MAX; i += REFORMAT_CHUNK) {
    const batch = nodes.slice(i, i + REFORMAT_CHUNK);
    chunks += 1;
    const { content, runId } = await runStagedLLM('fableloom-reformat-scenes', {
      // The TARGET format, not the loom's current one: the pin is written
      // last, so passing `loom` would assert the source format as fact in
      // the same prompt that asks for the target — and would render
      // differently on a resumed run than on the first one.
      storyContext: storyContext({ ...loom, format: target }, episode),
      canonDigest: canonDigest || '(none)',
      formatLabel: loomFormatLabel(target),
      sceneFormatContract: sceneFormatContract(target),
      scenesJson: JSON.stringify(batch.map((n) => ({ id: n.id, title: n.title, prose: n.prose })), null, 2),
    }, llmOptions({ providerId, model, effort }, 'fableloom-reformat'));
    if (runId) runIds.push(runId);

    // Only ids from THIS batch count. A model that invents an id, echoes a
    // typo, or names a scene from another episode writes nothing — counting
    // those would report scenes as rewritten that still hold their old prose
    // and would satisfy the no-response guard below on a total miss.
    const batchIds = new Set(batch.map((n) => n.id));
    const byId = new Map((Array.isArray(content?.scenes) ? content.scenes : [])
      .filter((sc) => sc && typeof sc === 'object' && isStr(sc.id) && batchIds.has(sc.id)
        && isStr(sc.prose) && sc.prose.trim())
      .map((sc) => [sc.id, sc]));
    if (!byId.size) continue;
    await mutateLoom(loomId, (current) => {
      const ep = findEpisode(current, episode.id);
      for (const sceneNode of ep.nodes) {
        const rewrite = byId.get(sceneNode.id);
        if (!rewrite) continue;
        sceneNode.prose = rewrite.prose;
        sceneNode.format = target;
        if (isStr(rewrite.title) && rewrite.title.trim()) sceneNode.title = rewrite.title;
      }
      ep.updatedAt = new Date().toISOString();
      return current;
    });
    rewritten += byId.size;
  }

  // An episode with nothing to rewrite is a no-op, not a failure — the client
  // walks every episode, and the pin below is still the point. Only an episode
  // that HAD scenes and got none back is a bad response.
  if (nodes.length && !rewritten) throw aiShapeError('The model returned no rewritten scenes');

  // Counted off the RECORD rather than accumulated in the loop, because scenes
  // go unconverted for two unrelated reasons: the per-request ceiling stopped
  // early, or the model simply didn't return them (it can drop 2 of a 5-scene
  // batch). Tracking only the first would report a partial rewrite as complete
  // and pin the loom to a format some of its scenes are not in.
  const after = await getLoom(loomId);
  const episodeRemaining = findEpisode(after, episodeId).nodes.filter((n) => needsReformat(n, target)).length;
  const remaining = unconvertedSceneCount(after, target);
  // `capped` separates the two reasons an episode can come back unfinished: this
  // run hit its ceiling with scenes it never SENT (ask again and it continues
  // from there), or the model dropped scenes it was given (asking again just
  // re-sends them, and a second refusal is an error, not progress). Only the
  // first earns an automatic follow-up request — and since a capped run always
  // rewrote at least one scene, following it up strictly makes progress.
  const capped = nodes.length > chunks * REFORMAT_CHUNK;
  // Only a fully-converted loom gets the pin.
  const updated = remaining
    ? after
    : await mutateLoom(loomId, (current) => ({ ...current, format: target }));
  return { loom: updated, format: target, rewritten, episodeRemaining, remaining, capped, runIds };
}
