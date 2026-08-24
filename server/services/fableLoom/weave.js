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
import { analyzeEpisodeGraph, describeGraphForPrompt } from '../../lib/fableLoomGraph.js';
import { getUniverse } from '../universeBuilder.js';
import { LOOM_LIMITS, findEpisode, findNode, getLoom, mutateLoom } from './records.js';
import { asLoomFormat, loomFormatLabel, narrationFormatContract, sceneFormatContract } from './formats.js';

const TRANSCRIPT_TURNS_MAX = 12;

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

const storyContext = (loom, episode) => [
  `Story: ${loom.name}`,
  `Scene format: ${loomFormatLabel(loom.format)}`,
  loom.logline ? `Logline: ${loom.logline}` : '',
  loom.premise ? `Premise: ${loom.premise}` : '',
  episode ? `Episode ${episode.number}: ${episode.title || 'Untitled'}` : '',
  episode?.synopsis ? `Synopsis: ${episode.synopsis}` : '',
].filter(Boolean).join('\n');

// --- Weave: generate a full episode graph -----------------------------------

// Raw generated node fields, passed through for the sanitizer to trim/cap.
const generatedNodeFields = (raw) => ({
  title: raw.title,
  prose: raw.prose,
  imagePrompt: raw.imagePrompt,
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
  guidance = '', nodeTarget, endingTarget, replace = false, providerId, model, effort,
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
    nodeTarget: String(clamp(nodeTarget, 3, 60, 12)),
    endingTarget: String(clamp(endingTarget, 1, 12, 3)),
    sceneFormatContract: sceneFormatContract(loom.format),
  }, llmOptions({ providerId, model, effort }, 'fableloom-weave'));

  const { nodes, startNodeId } = mapGeneratedGraph(content);
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
  const count = clamp(branchCount, 1, 4, 2);

  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runStagedLLM('fableloom-branch-node', {
    storyContext: storyContext(loom, episode),
    canonDigest: canonDigest || '(none — invent what the story needs)',
    graphDigest: describeGraphForPrompt(episode, { proseLimit: 200 }),
    sceneTitle: node.title || 'Untitled scene',
    sceneProse: node.prose || '(no prose yet)',
    branchCount: String(count),
    guidance: guidance || '(none)',
    sceneFormatContract: sceneFormatContract(loom.format),
  }, llmOptions({ providerId, model, effort }, 'fableloom-branch'));

  const branches = Array.isArray(content?.branches)
    ? content.branches.filter((b) => b && typeof b === 'object' && b.node && typeof b.node === 'object').slice(0, count)
    : [];
  if (!branches.length) throw aiShapeError('The model returned no usable branches');

  const updated = await mutateLoom(loomId, (current) => {
    const ep = findEpisode(current, episodeId);
    const source = findNode(ep, nodeId);
    for (const branch of branches) {
      if (ep.nodes.length >= LOOM_LIMITS.NODES_MAX) break;
      const newNode = { id: `node-${randomUUID()}`, ...generatedNodeFields(branch.node), format: asLoomFormat(loom.format), transitions: [], pos: null };
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
  const structural = analyzeEpisodeGraph(episode);
  const { content, runId } = await runStagedLLM('fableloom-review', {
    storyContext: storyContext(loom, episode),
    graphDigest: describeGraphForPrompt(episode),
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

// --- Play: resolve a reader's free-text intent ------------------------------

/** Reader-facing scene shape — trigger phrases stay server-side. */
export const publicNode = (node) => ({
  id: node.id,
  title: node.title,
  prose: node.prose,
  image: node.image,
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
    const taken = node.transitions.find((t) => t.id === transitionId);
    if (!taken) {
      throw new ServerError('That path is not on this scene', { status: 400, code: 'INVALID_TRANSITION' });
    }
    return moveResult(episode, node, taken, { narration: '', resolvedBy: 'choice' });
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
