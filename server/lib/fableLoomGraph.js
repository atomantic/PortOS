/**
 * FableLoom — pure graph analysis for branching-narrative episodes.
 *
 * A FableLoom episode is a directed graph of scene nodes. Each node carries
 * prose plus a list of intent-triggered transitions (the reader expresses an
 * intent in free text; the play LLM matches it to a transition). Ending nodes
 * terminate a read-through. This module holds the deterministic (no-LLM)
 * validation, traversal, and prompt-rendering helpers shared by the service,
 * routes, and tests.
 *
 * Issue severities: 'error' blocks play (the graph cannot be read through
 * coherently); 'warning' is an authoring smell the UI surfaces but never
 * blocks on.
 */

const asArray = (v) => (Array.isArray(v) ? v : []);
const isStr = (v) => typeof v === 'string' && v.length > 0;

export const GRAPH_ISSUE_CODES = Object.freeze({
  MISSING_START: 'MISSING_START',
  START_NOT_FOUND: 'START_NOT_FOUND',
  NO_NODES: 'NO_NODES',
  NO_ENDINGS: 'NO_ENDINGS',
  UNREACHABLE_NODE: 'UNREACHABLE_NODE',
  DEAD_END: 'DEAD_END',
  DANGLING_TRANSITION: 'DANGLING_TRANSITION',
  ENDING_WITH_TRANSITIONS: 'ENDING_WITH_TRANSITIONS',
  EMPTY_INTENT: 'EMPTY_INTENT',
  DUPLICATE_INTENT: 'DUPLICATE_INTENT',
  ENDING_UNREACHABLE: 'ENDING_UNREACHABLE',
  SELF_LOOP: 'SELF_LOOP',
  CUT_TRANSITION_COUNT: 'CUT_TRANSITION_COUNT',
  DISCONNECTED_DECISION: 'DISCONNECTED_DECISION',
  NO_AUDIENCE_CONNECTION: 'NO_AUDIENCE_CONNECTION',
  LATE_AUDIENCE_CONNECTION: 'LATE_AUDIENCE_CONNECTION',
});

/**
 * Breadth-first layering from the episode's start node. Returns
 * `{ layers, depthById }` where `layers` is an array of node-id arrays
 * (layer 0 = start) and `depthById` maps nodeId → BFS depth. Nodes not
 * reachable from the start are absent from both — callers that need them
 * (layout, validation) diff against the full node list.
 */
export function computeGraphLayers(episode) {
  const nodes = asArray(episode?.nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const startId = episode?.startNodeId;
  const layers = [];
  const depthById = new Map();
  if (!byId.has(startId)) return { layers, depthById };

  let frontier = [startId];
  depthById.set(startId, 0);
  while (frontier.length) {
    layers.push(frontier);
    const next = [];
    for (const id of frontier) {
      for (const tr of asArray(byId.get(id)?.transitions)) {
        const target = tr?.targetNodeId;
        if (byId.has(target) && !depthById.has(target)) {
          depthById.set(target, layers.length);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return { layers, depthById };
}

/**
 * Deterministic structural validation of one episode graph. Returns
 * `{ issues, stats }`; `issues` entries are
 * `{ code, severity: 'error'|'warning', message, nodeId?, transitionId? }`.
 */
export function analyzeEpisodeGraph(episode, {
  participationMode = 'protagonist', requireAudienceIntroduction = false,
} = {}) {
  const nodes = asArray(episode?.nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const issues = [];
  const push = (code, severity, message, extra = {}) => issues.push({ code, severity, message, ...extra });

  if (!nodes.length) {
    push(GRAPH_ISSUE_CODES.NO_NODES, 'error', 'The episode has no scenes yet.');
  }
  if (!isStr(episode?.startNodeId)) {
    if (nodes.length) push(GRAPH_ISSUE_CODES.MISSING_START, 'error', 'No opening scene is set.');
  } else if (nodes.length && !byId.has(episode.startNodeId)) {
    push(GRAPH_ISSUE_CODES.START_NOT_FOUND, 'error', 'The opening scene points at a scene that no longer exists.');
  }

  const { depthById } = computeGraphLayers(episode);
  const endings = nodes.filter((n) => n?.isEnding);
  if (nodes.length && !endings.length) {
    push(GRAPH_ISSUE_CODES.NO_ENDINGS, 'error', 'The episode has no endings — every path loops forever.');
  }

  const reachableEndings = endings.filter((n) => depthById.has(n.id));
  if (endings.length && depthById.size && !reachableEndings.length) {
    push(GRAPH_ISSUE_CODES.ENDING_UNREACHABLE, 'error', 'No ending is reachable from the opening scene.');
  }

  if (participationMode === 'helper' && requireAudienceIntroduction && nodes.length) {
    const connected = nodes.filter((node) => node?.audienceConnection === 'connected' && depthById.has(node.id));
    if (!connected.length) {
      push(
        GRAPH_ISSUE_CODES.NO_AUDIENCE_CONNECTION,
        'error',
        'The audience is never invited into the story through its communication medium.',
      );
    } else {
      const firstDepth = Math.min(...connected.map((node) => depthById.get(node.id)));
      if (firstDepth > 3) {
        push(
          GRAPH_ISSUE_CODES.LATE_AUDIENCE_CONNECTION,
          'warning',
          'The audience communication channel is not activated until late in the opening sequence.',
          { nodeId: connected.find((node) => depthById.get(node.id) === firstDepth)?.id },
        );
      }
    }
  }

  for (const node of nodes) {
    const transitions = asArray(node?.transitions);
    const label = node?.title || node?.id;

    if (depthById.size && !depthById.has(node.id)) {
      push(GRAPH_ISSUE_CODES.UNREACHABLE_NODE, 'warning', `"${label}" cannot be reached from the opening scene.`, { nodeId: node.id });
    }
    if (!node?.isEnding && !transitions.length) {
      push(GRAPH_ISSUE_CODES.DEAD_END, 'error', `"${label}" has no paths out and is not marked as an ending.`, { nodeId: node.id });
    }
    if (node?.isEnding && transitions.length) {
      push(GRAPH_ISSUE_CODES.ENDING_WITH_TRANSITIONS, 'warning', `Ending "${label}" still has outgoing paths — they will never fire.`, { nodeId: node.id });
    }
    if (!node?.isEnding && node?.playbackMode === 'cut' && transitions.length !== 1) {
      push(
        GRAPH_ISSUE_CODES.CUT_TRANSITION_COUNT,
        'error',
        `Automatic cut "${label}" must have exactly one path to the next camera cut.`,
        { nodeId: node.id },
      );
    }
    if (participationMode === 'helper' && !node?.isEnding
      && node?.audienceConnection !== 'connected' && node?.playbackMode !== 'cut') {
      push(
        GRAPH_ISSUE_CODES.DISCONNECTED_DECISION,
        'error',
        `"${label}" waits for viewer input while the audience communication channel is disconnected.`,
        { nodeId: node.id },
      );
    }

    const seenIntents = new Set();
    for (const tr of transitions) {
      const intent = typeof tr?.intent === 'string' ? tr.intent.trim().toLowerCase() : '';
      if (!intent) {
        push(GRAPH_ISSUE_CODES.EMPTY_INTENT, 'error', `A path out of "${label}" has no intent label.`, { nodeId: node.id, transitionId: tr?.id });
      } else if (seenIntents.has(intent)) {
        push(GRAPH_ISSUE_CODES.DUPLICATE_INTENT, 'warning', `"${label}" has two paths with the intent "${tr.intent}".`, { nodeId: node.id, transitionId: tr?.id });
      } else {
        seenIntents.add(intent);
      }
      if (!byId.has(tr?.targetNodeId)) {
        push(GRAPH_ISSUE_CODES.DANGLING_TRANSITION, 'error', `A path out of "${label}" points at a scene that no longer exists.`, { nodeId: node.id, transitionId: tr?.id });
      } else if (tr.targetNodeId === node.id) {
        push(GRAPH_ISSUE_CODES.SELF_LOOP, 'warning', `"${label}" has a path that loops straight back to itself.`, { nodeId: node.id, transitionId: tr?.id });
      }
    }
  }

  const stats = {
    nodeCount: nodes.length,
    automaticCutCount: nodes.filter((node) => !node?.isEnding && node?.playbackMode === 'cut').length,
    decisionCount: nodes.filter((node) => !node?.isEnding && node?.playbackMode !== 'cut').length,
    endingCount: endings.length,
    reachableCount: depthById.size,
    reachableEndingCount: reachableEndings.length,
    maxDepth: depthById.size ? Math.max(...depthById.values()) : 0,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
  };
  return { issues, stats };
}

/**
 * Render an episode graph as compact text for LLM prompts (generation context,
 * play turns, and the story review). One block per node:
 *
 *   [n1] Title (START) (ENDING: label)
 *   prose…
 *   -> [n2] intent "search the wreck" (triggers: poke around; investigate)
 *
 * `proseLimit` truncates each node's prose so a large graph stays inside the
 * stage's context window.
 */
export function describeGraphForPrompt(episode, {
  proseLimit = 400, participationMode = 'protagonist',
} = {}) {
  const nodes = asArray(episode?.nodes);
  const lines = [];
  for (const node of nodes) {
    const flags = [
      node.id === episode?.startNodeId ? 'START' : null,
      node?.isEnding ? `ENDING${isStr(node?.endingLabel) ? `: ${node.endingLabel}` : ''}` : null,
      node?.isEnding ? null : (node?.playbackMode === 'cut' ? 'AUTO CUT' : 'DECISION LOOP'),
      participationMode === 'helper'
        ? (node?.audienceConnection === 'connected' ? 'AUDIENCE CONNECTED' : 'AUDIENCE DISCONNECTED')
        : null,
      node?.protagonistPresence === 'offscreen' ? 'PROTAGONIST OFF-SCREEN' : null,
      node?.protagonistPresence === 'onscreen' ? 'PROTAGONIST ON-SCREEN' : null,
    ].filter(Boolean);
    lines.push(`[${node.id}] ${node.title || 'Untitled scene'}${flags.length ? ` (${flags.join(') (')})` : ''}`);
    const prose = typeof node.prose === 'string' ? node.prose.trim() : '';
    if (prose) lines.push(prose.length > proseLimit ? `${prose.slice(0, proseLimit)}…` : prose);
    if (isStr(node.videoPrompt)) {
      lines.push(`Video: ${node.videoPrompt.length > proseLimit ? `${node.videoPrompt.slice(0, proseLimit)}…` : node.videoPrompt}`);
    }
    if (isStr(node.cameraMovement)) lines.push(`Camera movement: ${node.cameraMovement}`);
    for (const tr of asArray(node.transitions)) {
      const triggers = asArray(tr?.triggers).filter(isStr);
      lines.push(`-> [${tr?.targetNodeId}] intent "${tr?.intent || ''}"${triggers.length ? ` (triggers: ${triggers.join('; ')})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
