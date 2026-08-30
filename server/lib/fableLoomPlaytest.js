/**
 * FableLoom branching-playthrough test harness.
 *
 * This is intentionally deterministic and side-effect free: it walks every
 * bounded path through an episode graph, records the exact choices taken, and
 * reports coverage/non-termination before an optional AI story editor judges
 * the resulting narrative paths. The service layer owns that AI review.
 */

import { analyzeEpisodeGraph } from './fableLoomGraph.js';

const asArray = (value) => (Array.isArray(value) ? value : []);
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

export const FABLELOOM_PLAYTEST_LIMITS = Object.freeze({
  DEFAULT_MAX_PATHS: 96,
  MAX_PATHS: 256,
  DEFAULT_MAX_STEPS: 256,
  MAX_STEPS: 1000,
  MAX_NODE_VISITS: 2,
});

export const PLAYTEST_ISSUE_CODES = Object.freeze({
  NO_START: 'NO_START',
  DANGLING_PATH: 'DANGLING_PATH',
  DEAD_END: 'DEAD_END',
  NON_TERMINATING_CYCLE: 'NON_TERMINATING_CYCLE',
  STEP_LIMIT: 'STEP_LIMIT',
  VARIATION_LIMIT: 'VARIATION_LIMIT',
  UNCOVERED_TRANSITION: 'UNCOVERED_TRANSITION',
});

const boundedInteger = (value, fallback, max) => (
  Number.isInteger(value) ? Math.max(1, Math.min(max, value)) : fallback
);

const transitionKey = (nodeId, transition, index) => (
  hasText(transition?.id) ? transition.id : `${nodeId}:transition-${index + 1}`
);

const publicPath = (path, index) => ({
  id: `path-${index + 1}`,
  nodeIds: path.nodeIds,
  transitionIds: path.transitionIds,
  choices: path.choices,
  termination: path.termination,
  ended: path.termination === 'ending',
  endingNodeId: path.endingNodeId || null,
  endingLabel: path.endingLabel || '',
  sceneCount: path.nodeIds.length,
  ...(path.problemNodeId ? { problemNodeId: path.problemNodeId } : {}),
  ...(path.problemTransitionId ? { problemTransitionId: path.problemTransitionId } : {}),
});

/** Enumerate every bounded variation through one episode graph. */
export function enumerateEpisodePlaythroughs(episode, options = {}) {
  const nodes = asArray(episode?.nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const maxPaths = boundedInteger(
    options.maxPaths,
    FABLELOOM_PLAYTEST_LIMITS.DEFAULT_MAX_PATHS,
    FABLELOOM_PLAYTEST_LIMITS.MAX_PATHS,
  );
  const maxSteps = boundedInteger(
    options.maxSteps,
    FABLELOOM_PLAYTEST_LIMITS.DEFAULT_MAX_STEPS,
    FABLELOOM_PLAYTEST_LIMITS.MAX_STEPS,
  );
  const maxNodeVisits = boundedInteger(
    options.maxNodeVisits,
    FABLELOOM_PLAYTEST_LIMITS.MAX_NODE_VISITS,
    10,
  );
  const structural = analyzeEpisodeGraph(episode, options.graphOptions);
  const rawPaths = [];
  let capped = false;

  const record = (path) => {
    if (rawPaths.length >= maxPaths) {
      capped = true;
      return false;
    }
    rawPaths.push(path);
    return true;
  };

  const walk = ({ nodeId, nodeIds, transitionIds, choices, visits }) => {
    if (rawPaths.length >= maxPaths) {
      capped = true;
      return;
    }
    const node = byId.get(nodeId);
    if (!node) {
      record({
        nodeIds,
        transitionIds,
        choices,
        termination: 'dangling-path',
        problemNodeId: nodeId,
      });
      return;
    }

    const nextNodeIds = [...nodeIds, node.id];
    if (node.isEnding === true) {
      record({
        nodeIds: nextNodeIds,
        transitionIds,
        choices,
        termination: 'ending',
        endingNodeId: node.id,
        endingLabel: node.endingLabel || node.title || '',
      });
      return;
    }
    if (nextNodeIds.length >= maxSteps) {
      record({
        nodeIds: nextNodeIds,
        transitionIds,
        choices,
        termination: 'step-limit',
        problemNodeId: node.id,
      });
      return;
    }

    const transitions = asArray(node.transitions);
    if (!transitions.length) {
      record({
        nodeIds: nextNodeIds,
        transitionIds,
        choices,
        termination: 'dead-end',
        problemNodeId: node.id,
      });
      return;
    }

    for (const [index, transition] of transitions.entries()) {
      if (rawPaths.length >= maxPaths) {
        capped = true;
        return;
      }
      const id = transitionKey(node.id, transition, index);
      const targetId = transition?.targetNodeId;
      const nextTransitionIds = [...transitionIds, id];
      const nextChoices = [...choices, {
        nodeId: node.id,
        transitionId: id,
        intent: transition?.intent || '',
        automatic: node.playbackMode === 'cut',
      }];
      if (!byId.has(targetId)) {
        record({
          nodeIds: nextNodeIds,
          transitionIds: nextTransitionIds,
          choices: nextChoices,
          termination: 'dangling-path',
          problemNodeId: node.id,
          problemTransitionId: id,
        });
        continue;
      }
      const targetVisits = visits.get(targetId) || 0;
      if (targetVisits >= maxNodeVisits) {
        record({
          nodeIds: [...nextNodeIds, targetId],
          transitionIds: nextTransitionIds,
          choices: nextChoices,
          termination: 'cycle',
          problemNodeId: targetId,
          problemTransitionId: id,
        });
        continue;
      }
      const nextVisits = new Map(visits);
      nextVisits.set(targetId, targetVisits + 1);
      walk({
        nodeId: targetId,
        nodeIds: nextNodeIds,
        transitionIds: nextTransitionIds,
        choices: nextChoices,
        visits: nextVisits,
      });
    }
  };

  if (hasText(episode?.startNodeId) && byId.has(episode.startNodeId)) {
    walk({
      nodeId: episode.startNodeId,
      nodeIds: [],
      transitionIds: [],
      choices: [],
      visits: new Map([[episode.startNodeId, 1]]),
    });
  }

  const paths = rawPaths.map(publicPath);
  const visitedNodeIds = new Set(paths.flatMap((path) => path.nodeIds));
  const visitedTransitionIds = new Set(paths.flatMap((path) => path.transitionIds));
  const allTransitions = nodes.flatMap((node) => asArray(node.transitions).map((transition, index) => ({
    nodeId: node.id,
    transitionId: transitionKey(node.id, transition, index),
    targetNodeId: transition?.targetNodeId || null,
  })));
  const uncoveredTransitions = allTransitions.filter((transition) => (
    !visitedTransitionIds.has(transition.transitionId)
  ));
  const issues = [];
  const push = (code, severity, message, extra = {}) => issues.push({ code, severity, message, ...extra });

  if (!hasText(episode?.startNodeId) || !byId.has(episode.startNodeId)) {
    push(PLAYTEST_ISSUE_CODES.NO_START, 'error', 'Playthrough testing cannot start because the opening scene is missing.');
  }
  for (const path of paths) {
    if (path.termination === 'dangling-path') {
      push(PLAYTEST_ISSUE_CODES.DANGLING_PATH, 'error', `Variation ${path.id} follows a path to a missing scene.`, {
        pathId: path.id,
        nodeId: path.problemNodeId,
        ...(path.problemTransitionId ? { transitionId: path.problemTransitionId } : {}),
      });
    } else if (path.termination === 'dead-end') {
      push(PLAYTEST_ISSUE_CODES.DEAD_END, 'error', `Variation ${path.id} stops at a scene that is not an ending.`, {
        pathId: path.id,
        nodeId: path.problemNodeId,
      });
    } else if (path.termination === 'cycle') {
      push(PLAYTEST_ISSUE_CODES.NON_TERMINATING_CYCLE, 'error', `Variation ${path.id} can repeat a cycle without reaching an ending.`, {
        pathId: path.id,
        nodeId: path.problemNodeId,
        ...(path.problemTransitionId ? { transitionId: path.problemTransitionId } : {}),
      });
    } else if (path.termination === 'step-limit') {
      push(PLAYTEST_ISSUE_CODES.STEP_LIMIT, 'error', `Variation ${path.id} exceeded the ${maxSteps}-scene safety limit.`, {
        pathId: path.id,
        nodeId: path.problemNodeId,
      });
    }
  }
  if (capped) {
    push(
      PLAYTEST_ISSUE_CODES.VARIATION_LIMIT,
      'warning',
      `Playthrough enumeration reached the ${maxPaths}-variation limit; the report is representative rather than exhaustive.`,
    );
  }
  for (const transition of uncoveredTransitions) {
    push(
      PLAYTEST_ISSUE_CODES.UNCOVERED_TRANSITION,
      capped ? 'warning' : 'error',
      'A story path was not exercised by the generated playthrough variations.',
      transition,
    );
  }

  const endingCounts = Object.fromEntries(nodes.filter((node) => node.isEnding).map((node) => [
    node.id,
    paths.filter((path) => path.endingNodeId === node.id).length,
  ]));
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const enumerationComplete = !capped;
  return {
    episodeId: episode?.id || null,
    structural,
    paths,
    issues,
    stats: {
      variationCount: paths.length,
      endingVariationCount: paths.filter((path) => path.ended).length,
      nonEndingVariationCount: paths.filter((path) => !path.ended).length,
      nodeCount: nodes.length,
      visitedNodeCount: visitedNodeIds.size,
      transitionCount: allTransitions.length,
      visitedTransitionCount: visitedTransitionIds.size,
      endingCounts,
      errorCount,
      warningCount,
      enumerationComplete,
      passed: enumerationComplete
        && errorCount === 0
        && structural.stats.errorCount === 0
        && paths.length > 0,
    },
  };
}

/** Aggregate the deterministic harness across every episode in a loom. */
export function analyzeLoomPlaythroughs(loom, options = {}) {
  const episodes = asArray(loom?.episodes).map((episode, index) => ({
    number: episode.number || index + 1,
    title: episode.title || `Episode ${episode.number || index + 1}`,
    ...enumerateEpisodePlaythroughs(episode, {
      ...options,
      graphOptions: {
        participationMode: loom?.participationMode,
        requireAudienceIntroduction: index === 0,
      },
    }),
  }));
  const errorCount = episodes.reduce((total, episode) => (
    total + episode.stats.errorCount + episode.structural.stats.errorCount
  ), 0);
  const warningCount = episodes.reduce((total, episode) => (
    total + episode.stats.warningCount + episode.structural.stats.warningCount
  ), 0);
  return {
    passed: episodes.length > 0 && episodes.every((episode) => episode.stats.passed),
    complete: episodes.length > 0 && episodes.every((episode) => episode.stats.enumerationComplete),
    stats: {
      episodeCount: episodes.length,
      variationCount: episodes.reduce((total, episode) => total + episode.stats.variationCount, 0),
      endingVariationCount: episodes.reduce((total, episode) => total + episode.stats.endingVariationCount, 0),
      nonEndingVariationCount: episodes.reduce((total, episode) => total + episode.stats.nonEndingVariationCount, 0),
      nodeCount: episodes.reduce((total, episode) => total + episode.stats.nodeCount, 0),
      visitedNodeCount: episodes.reduce((total, episode) => total + episode.stats.visitedNodeCount, 0),
      transitionCount: episodes.reduce((total, episode) => total + episode.stats.transitionCount, 0),
      visitedTransitionCount: episodes.reduce((total, episode) => total + episode.stats.visitedTransitionCount, 0),
      errorCount,
      warningCount,
    },
    episodes,
  };
}

/** Compact path traces for the AI playthrough-quality stage. */
export function describeLoomPlaythroughsForPrompt(loom, report) {
  const episodesById = new Map(asArray(loom?.episodes).map((episode) => [episode.id, episode]));
  return asArray(report?.episodes).map((episodeReport) => {
    const episode = episodesById.get(episodeReport.episodeId);
    const nodesById = new Map(asArray(episode?.nodes).map((node) => [node.id, node]));
    const traces = episodeReport.paths.map((path) => {
      const beats = path.nodeIds.map((nodeId, index) => {
        const node = nodesById.get(nodeId);
        const choice = path.choices[index];
        const label = node?.title || nodeId;
        if (!choice) return label;
        return `${label} --${choice.automatic ? 'auto' : 'choice'}: ${choice.intent || '(unlabeled)'}-->`;
      });
      const end = path.ended
        ? `END: ${path.endingLabel || path.endingNodeId}`
        : `STOPPED: ${path.termination}`;
      return `[${path.id}] ${[...beats, end].join(' ')}`;
    });
    return [
      `## Episode ${episodeReport.number}: ${episodeReport.title}`,
      `${episodeReport.stats.variationCount} variation(s); ${episodeReport.stats.visitedTransitionCount}/${episodeReport.stats.transitionCount} paths exercised; exhaustive: ${episodeReport.stats.enumerationComplete ? 'yes' : 'no'}`,
      ...traces,
    ].join('\n');
  }).join('\n\n');
}
