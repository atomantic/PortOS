/** Generate, validate, expand, and branch FableLoom episode outlines and scene graphs. */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { GRAPH_ISSUE_CODES, analyzeEpisodeGraph, describeGraphForPrompt } from '../../lib/fableLoomGraph.js';
import { fableLoomCameraMovementCatalogForPrompt } from '../../lib/fableLoomCameraMovements.js';
import {
  analyzeSeriesStoryOutlines,
  analyzeStoryOutline,
  analyzeStoryOutlineTeleplaySync,
  describeStoryOutlineForPrompt,
  fableLoomEpisodeChallenges,
  isStoryOutlineTeleplaySyncIssue,
  sanitizeStoryOutline,
} from '../../lib/fableLoomOutline.js';
import { audienceCanParticipate } from '../../lib/fableLoomParticipation.js';
import { LOOM_LIMITS, findEpisode, findNode, mutateLoom } from './records.js';
import { asLoomFormat, sceneFormatContract } from '../../lib/fableLoomFormats.js';
import { isStr } from '../../lib/textUtils.js';
import { aiShapeError, requireLoom, runLoomAi } from './weaveShared.js';
import {
  buildCanonDigest,
  requiresAudienceIntroduction,
  audienceContract,
  storyContext,
  outlineStructuralAnalysis,
  episodeSequenceDigest,
} from './weaveContext.js';

const AUDIENCE_GRAPH_ERROR_CODES = new Set([
  GRAPH_ISSUE_CODES.NO_AUDIENCE_CONNECTION,
  GRAPH_ISSUE_CODES.DISCONNECTED_DECISION,
]);

const clamp = (value, min, max, fallback) =>
  (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);

// Raw generated node fields, passed through for the sanitizer to trim/cap.
const generatedNodeFields = (raw) => ({
  title: raw.title,
  prose: raw.prose,
  plotPointId: raw.plotPointId,
  challengePhase: raw.challengePhase,
  imagePrompt: raw.imagePrompt,
  videoPrompt: raw.videoPrompt,
  cameraMovement: raw.cameraMovement,
  visualCanon: raw.visualCanon,
  playbackMode: raw.playbackMode,
  audienceConnection: raw.audienceConnection,
  protagonistPresence: raw.protagonistPresence,
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
  return { nodes, startNodeId, idByKey };
}

const remapOutlineToExpandedNodeIds = (outline, idByKey) => ({
  ...outline,
  startKey: idByKey.get(outline.startKey) || outline.startKey,
  scenes: outline.scenes.map((scene) => ({
    ...scene,
    key: idByKey.get(scene.key) || scene.key,
    transitions: (scene.transitions || []).map((transition) => ({
      ...transition,
      targetKey: idByKey.get(transition.targetKey) || transition.targetKey,
    })),
  })),
});

const episodeOutlineFingerprint = (loom, episode) => JSON.stringify({
  loom: {
    name: loom.name,
    logline: loom.logline,
    premise: loom.premise,
    format: loom.format,
    universeId: loom.universeId,
    seriesId: loom.seriesId,
    protagonistCharacterId: loom.protagonistCharacterId,
    protagonistWardrobeId: loom.protagonistWardrobeId,
    protagonistWardrobeLocked: loom.protagonistWardrobeLocked,
    seriesPlan: loom.seriesPlan,
  },
  episodes: loom.episodes.map(({ id, number, title, synopsis, startNodeId, nodes, storyOutline }) => ({
    id, number, title, synopsis, startNodeId, nodes, storyOutline,
  })),
  episodeId: episode.id,
});

const outlineInvalidError = (analysis, message = 'The episode outline must be valid before teleplay expansion') => {
  const firstIssue = analysis?.issues?.find((issue) => issue.severity === 'error');
  return new ServerError(firstIssue ? `${message}: ${firstIssue.message}` : message, {
    status: 409,
    code: 'OUTLINE_INVALID',
  });
};

/** Draft one episode's camera-cut beats without writing scene prose. */
export async function generateEpisodeOutline(loomId, episodeId, {
  guidance = '', providerId, model, effort, operationId,
} = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const sourceFingerprint = episodeOutlineFingerprint(loom, episode);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runLoomAi('fableloom-outline-episode', {
    storyContext: storyContext(loom, episode),
    canonDigest: canonDigest || '(none — invent only what the premise needs)',
    episodeSequence: episodeSequenceDigest(loom, episode.id),
    currentGraph: episode.nodes.length
      ? describeGraphForPrompt(episode, { proseLimit: 300, participationMode: loom.participationMode })
      : '(none — this episode has not been expanded yet)',
    currentOutline: episode.storyOutline
      ? describeStoryOutlineForPrompt(episode.storyOutline)
      : '(none — draft the first beat outline)',
    guidance: guidance || '(none)',
    participationContract: audienceContract(loom, episode),
  }, { providerId, model, effort, operationId }, {
    action: 'outline-episode', label: 'Drafting episode outline', source: 'fableloom-outline-episode',
  });

  const outline = sanitizeStoryOutline(content, { participationMode: loom.participationMode });
  if (!outline?.scenes?.length) throw aiShapeError('The model returned no usable episode outline beats');
  const validation = analyzeStoryOutline(outline, {
    participationMode: loom.participationMode,
    requireAudienceIntroduction: requiresAudienceIntroduction(loom, episode),
    challenges: fableLoomEpisodeChallenges(loom, episode.id),
    plotPoints: loom.seriesPlan?.plotPoints,
    episodeId: episode.id,
  });
  const draft = {
    ...outline,
    validation: {
      status: 'draft',
      issues: validation.issues,
    },
  };
  const updated = await mutateLoom(loomId, (current) => {
    if (episodeOutlineFingerprint(current, findEpisode(current, episodeId)) !== sourceFingerprint) {
      throw new ServerError('The episode changed while its outline was being drafted', {
        status: 409,
        code: 'LOOM_CHANGED_DURING_GENERATION',
      });
    }
    const currentEpisode = findEpisode(current, episodeId);
    currentEpisode.storyOutline = draft;
    currentEpisode.updatedAt = new Date().toISOString();
    return current;
  });
  return {
    loom: updated,
    episodeId,
    outline: findEpisode(updated, episodeId).storyOutline,
    validation,
    runId,
  };
}

/** Validate and persist the deterministic status of an episode beat outline. */
export async function validateEpisodeOutline(loomId, episodeId) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const validation = outlineStructuralAnalysis(loom, episode);
  if (!episode.storyOutline) return { loom, episodeId, outline: null, validation };
  const updated = await mutateLoom(loomId, (current) => {
    const currentEpisode = findEpisode(current, episodeId);
    const currentValidation = outlineStructuralAnalysis(current, currentEpisode);
    currentEpisode.storyOutline = {
      ...currentEpisode.storyOutline,
      validation: {
        status: currentValidation.stats.errorCount ? 'invalid' : 'valid',
        issues: currentValidation.issues,
        validatedAt: new Date().toISOString(),
      },
    };
    currentEpisode.updatedAt = new Date().toISOString();
    return current;
  });
  const updatedEpisode = findEpisode(updated, episodeId);
  return {
    loom: updated,
    episodeId,
    outline: updatedEpisode.storyOutline,
    validation,
  };
}

export async function weaveEpisode(loomId, episodeId, {
  guidance = '', replace = false, expandFromOutline = false, providerId, model, effort, operationId,
} = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const outlineValidation = expandFromOutline ? outlineStructuralAnalysis(loom, episode) : null;
  const outlineStoryValidation = expandFromOutline
    ? analyzeStoryOutline(episode.storyOutline, {
      participationMode: loom.participationMode,
      requireAudienceIntroduction: requiresAudienceIntroduction(loom, episode),
      challenges: fableLoomEpisodeChallenges(loom, episode.id),
      plotPoints: loom.seriesPlan?.plotPoints,
      episodeId: episode.id,
    })
    : null;
  const currentOutlineErrors = expandFromOutline
    ? outlineValidation.issues.filter((issue) => issue.severity !== 'warning')
    : [];
  const replacingChangedTeleplay = Boolean(
    expandFromOutline
    && replace
    && episode.nodes.length
    && episode.storyOutline?.validation?.status === 'invalid'
    && outlineStoryValidation?.stats?.errorCount === 0
    && currentOutlineErrors.length
    && currentOutlineErrors.every(isStoryOutlineTeleplaySyncIssue),
  );
  if (expandFromOutline
    && episode.storyOutline?.validation?.status !== 'valid'
    && !replacingChangedTeleplay) {
    throw outlineInvalidError(outlineValidation);
  }
  if (expandFromOutline && outlineValidation.stats.errorCount && !replacingChangedTeleplay) {
    throw outlineInvalidError(outlineValidation);
  }
  if (expandFromOutline) {
    const seriesOutlineValidation = analyzeSeriesStoryOutlines(loom, {
      ...(replacingChangedTeleplay ? { replacingEpisodeId: episode.id } : {}),
    });
    if (seriesOutlineValidation.stats.errorCount) {
      const firstIssue = seriesOutlineValidation.issues.find((issue) => issue.severity === 'error');
      throw new ServerError(`Complete the series beat outlines before expansion: ${firstIssue.message}`, {
        status: 409,
        code: 'SERIES_OUTLINE_INVALID',
      });
    }
  }
  if (episode.nodes.length && !replace) {
    throw new ServerError('Episode already has scenes — pass replace to regenerate', { status: 409, code: 'EPISODE_NOT_EMPTY' });
  }
  const sourceFingerprint = episodeOutlineFingerprint(loom, episode);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runLoomAi('fableloom-weave-episode', {
    storyContext: storyContext(loom, episode),
    canonDigest: canonDigest || '(none — invent what the story needs)',
    guidance: guidance || '(none)',
    existingGraph: episode.nodes.length
      ? describeGraphForPrompt(episode, { proseLimit: 1200, participationMode: loom.participationMode })
      : '(none — create the episode from the story context)',
    outlineDigest: expandFromOutline
      ? describeStoryOutlineForPrompt(episode.storyOutline)
      : '(none — use the story context directly)',
    cameraMovementCatalog: fableLoomCameraMovementCatalogForPrompt(),
    sceneFormatContract: sceneFormatContract(loom.format),
    participationContract: audienceContract(loom, episode),
  }, { providerId, model, effort, operationId }, {
    action: 'weave-episode', label: 'Weaving episode', source: 'fableloom-weave',
  });

  const { nodes: generatedNodes, startNodeId, idByKey } = mapGeneratedGraph(content);
  const remappedOutline = expandFromOutline
    ? remapOutlineToExpandedNodeIds(episode.storyOutline, idByKey)
    : null;
  const remappedOutlineByNodeId = new Map((remappedOutline?.scenes || [])
    .map((scene) => [scene.key, scene]));
  const nodes = generatedNodes.map((node) => {
    const outlineScene = remappedOutlineByNodeId.get(node.id);
    return outlineScene ? {
      ...node,
      title: outlineScene.title,
      endingLabel: outlineScene.endingLabel || '',
      plotPointId: outlineScene.plotPointId || null,
      challengePhase: outlineScene.challengePhase || null,
      // The validated outline owns the contract; the model owns prose and prompts.
      playbackMode: outlineScene.playbackMode,
      audienceConnection: outlineScene.audienceConnection,
      protagonistPresence: outlineScene.protagonistPresence,
      isEnding: outlineScene.isEnding,
      transitions: node.transitions.map((transition) => {
        const paths = outlineScene.transitions.filter((path) => path.targetKey === transition.targetNodeId);
        const planned = paths.find((path) => path.intent === transition.intent) || (paths.length === 1 ? paths[0] : null);
        return { ...transition, intent: planned?.intent || transition.intent };
      }),
    } : node;
  });
  const remappedOutlineValidation = remappedOutline
    ? analyzeStoryOutline(remappedOutline, {
      participationMode: loom.participationMode,
      requireAudienceIntroduction: requiresAudienceIntroduction(loom, episode),
      challenges: fableLoomEpisodeChallenges(loom, episode.id),
      plotPoints: loom.seriesPlan?.plotPoints,
      episodeId: episode.id,
    })
    : null;
  const expandedOutline = remappedOutline
    ? {
      ...remappedOutline,
      validation: {
        status: remappedOutlineValidation.stats.errorCount ? 'invalid' : 'valid',
        issues: remappedOutlineValidation.issues,
        validatedAt: new Date().toISOString(),
      },
    }
    : null;
  if (expandedOutline) {
    const sync = analyzeStoryOutlineTeleplaySync(
      { ...episode, nodes, startNodeId },
      expandedOutline,
      { participationMode: loom.participationMode },
    );
    if (!sync.stats.matches) {
      throw aiShapeError(`The expanded teleplay changed its validated beat contract: ${sync.issues[0].message}`);
    }
  }
  const generatedAnalysis = analyzeEpisodeGraph(
    { ...episode, nodes, startNodeId },
    {
      participationMode: loom.participationMode,
      requireAudienceIntroduction: requiresAudienceIntroduction(loom, episode),
    },
  );
  if (expandFromOutline && generatedAnalysis.issues.some((issue) => issue.severity === 'error')) {
    throw aiShapeError(`The expanded teleplay has structural issues: ${generatedAnalysis.issues.find((issue) => issue.severity === 'error').message}`);
  }
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
    if (episodeOutlineFingerprint(current, ep) !== sourceFingerprint) {
      throw new ServerError('The episode changed while its teleplay was being woven', {
        status: 409,
        code: 'LOOM_CHANGED_DURING_GENERATION',
      });
    }
    // Stamped with the format they were generated in, so a later reformat can
    // tell them apart from scenes already in the target format.
    ep.nodes = nodes.map((n) => ({ ...n, format: asLoomFormat(loom.format) }));
    ep.startNodeId = startNodeId;
    if (expandedOutline) {
      ep.storyOutline = expandedOutline;
    } else if (ep.storyOutline) {
      ep.storyOutline.validation = { status: 'draft', issues: [] };
    }
    ep.updatedAt = new Date().toISOString();
    return current;
  });
  return { loom: updated, episodeId, runId };
}

// --- Branch: grow new paths out of one scene --------------------------------

export async function branchNode(loomId, episodeId, nodeId, {
  guidance = '', branchCount, providerId, model, effort, operationId,
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
  const { content, runId } = await runLoomAi('fableloom-branch-node', {
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
  }, { providerId, model, effort, operationId }, {
    action: 'branch-node', label: 'Growing scene branches', source: 'fableloom-branch',
  });

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
