import { analyzeEpisodeGraph, computeGraphLayers } from './fableLoomGraph.js';
import { analyzeSeriesStoryOutlines } from './fableLoomOutline.js';
import {
  asFableLoomPlaybackMode, FABLELOOM_RUNTIME_VERSION,
  inspectEpisodeProductionReadiness, resolveFableLoomProtagonistPresence,
  sanitizeInteractionWindow, validateAudioOccupancy,
} from './fableLoomPlayback.js';

export const FABLELOOM_EXPORT_SCHEMA_VERSION = '1.0.0';
export const FABLELOOM_EXPORT_LIMITS = Object.freeze({
  maxJobs: 4,
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxAssetBytes: 64 * 1024 * 1024,
  maxPackageBytes: 256 * 1024 * 1024,
});

/** Only reachable scenes need media; structural and outline errors still block export. */
export function inspectFableLoomExport(loom, episodes, universe) {
  const selected = new Set(episodes.map(e => e.id));
  const findings = analyzeSeriesStoryOutlines(loom).issues
    .filter(issue => selected.has(issue.episodeId))
    .map(issue => ({ ...issue, gate: 'outline' }));
  if (selected.size !== episodes.length || episodes.some(e => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(e.id))) {
    findings.push({ gate: 'graph', code: 'INVALID_EXPORT_EPISODES', severity: 'error',
      message: 'Episode identifiers must be unique portable identifiers.' });
  }
  for (const episode of episodes) {
    const graph = analyzeEpisodeGraph(episode, {
      participationMode: loom.participationMode,
      requireAudienceIntroduction: episode.id === loom.episodes[0]?.id,
    });
    findings.push(...graph.issues.map(issue => ({ ...issue, gate: 'graph', episodeId: episode.id })));
    const ids = new Set();
    for (const node of episode.nodes) {
      const transitionIds = new Set();
      for (const id of [node.id, ...node.transitions.map(t => t.id)]) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
          findings.push({ gate: 'graph', code: 'INVALID_EXPORT_ID', severity: 'error', episodeId: episode.id,
            message: 'Scene and transition identifiers must be portable identifiers.' });
        }
      }
      if (ids.has(node.id) || node.transitions.some(t => {
        const duplicate = transitionIds.has(t.id);
        transitionIds.add(t.id);
        return duplicate;
      })) {
        findings.push({ gate: 'graph', code: 'DUPLICATE_EXPORT_ID', severity: 'error', episodeId: episode.id,
          message: 'Scene identifiers and each scene’s transition identifiers must be unique.' });
      }
      ids.add(node.id);
    }
    const reachable = computeGraphLayers(episode).depthById;
    const ready = inspectEpisodeProductionReadiness({
      ...episode, nodes: episode.nodes.filter(n => reachable.has(n.id)),
    }, { loom, universe });
    for (const [nodeId, result] of Object.entries(ready.nodeResults)) {
      findings.push(...result.findings.map(issue => ({ ...issue, gate: 'production', episodeId: episode.id, nodeId })));
    }
  }
  return findings;
}

/** Explicit source references, never filenames reconstructed from a history id. */
export function fableLoomExportAssetRequests(node) {
  const assets = node.playbackAssets;
  const entryId = assets?.entryVideoHistoryId || node.videoHistoryId || null;
  const holds = node.isEnding || asFableLoomPlaybackMode(node.playbackMode) === 'cut'
    ? [] : (assets?.holdLoopVideoHistoryIds?.length ? assets.holdLoopVideoHistoryIds : [entryId]);
  return [
    { role: 'still', kind: 'image', sourceId: node.image },
    { role: 'entry', kind: 'video', sourceId: entryId },
    ...holds.map((sourceId, index) => ({ role: 'hold', kind: 'video', sourceId, index })),
    ...node.transitions.filter(t => assets?.exitByTransition?.[t.id])
      .map(t => ({ role: 'exit', kind: 'video', sourceId: assets.exitByTransition[t.id], transitionId: t.id })),
  ];
}

/** Machine-local configuration and provider prompts are deliberately absent. */
export function projectFableLoomExportNode(node, loom, assets) {
  const window = sanitizeInteractionWindow(node.interactionWindow);
  return {
    id: node.id, title: node.title, prose: node.prose,
    playbackMode: asFableLoomPlaybackMode(node.playbackMode),
    audienceConnection: node.audienceConnection,
    protagonistPresence: resolveFableLoomProtagonistPresence(node, loom) || 'offscreen',
    challengePhase: node.challengePhase ?? null,
    isEnding: node.isEnding === true, endingLabel: node.endingLabel || '',
    transitions: node.transitions.map(t => ({
      id: t.id, intent: t.intent, triggers: t.triggers, description: t.description, targetNodeId: t.targetNodeId,
    })),
    interactionWindow: window && {
      enabled: window.enabled, protagonistPresence: window.protagonistPresence,
      audioTarget: window.audioTarget, ambientDuckDb: window.ambientDuckDb, holdLoopRotation: window.holdLoopRotation,
    },
    playbackAssets: {
      still: assets.find(a => a.role === 'still')?.playback ?? null,
      entry: assets.find(a => a.role === 'entry')?.playback ?? null,
      holds: assets.filter(a => a.role === 'hold').map(a => a.playback),
      exits: Object.fromEntries(assets.filter(a => a.role === 'exit').map(a => [a.transitionId, a.playback])),
    },
  };
}

export function projectFableLoomExportManifest(loom, episodes, portosVersion) {
  return {
    schemaVersion: FABLELOOM_EXPORT_SCHEMA_VERSION, runtimeVersion: FABLELOOM_RUNTIME_VERSION, portosVersion,
    loom: {
      name: loom.name, logline: loom.logline, participationMode: loom.participationMode,
      audienceCommunicationMedium: loom.audienceCommunicationMedium, format: loom.format, episodes,
    },
  };
}

/** Occupancy keys refer to packaged bytes, and never to a local history record. */
export function fableLoomExportOccupancy(node, sourceId) {
  const raw = node.playbackAssets?.audioOccupancy?.[sourceId];
  if (!raw) return null;
  const occupancy = validateAudioOccupancy(raw);
  const intervals = list => list.map(({ startMs, endMs, blocking }) => ({
    startMs, endMs, ...(blocking === true ? { blocking: true } : {}),
  }));
  return {
    durationMs: occupancy.durationMs, characterDialogue: intervals(occupancy.characterDialogue),
    music: intervals(occupancy.music), effects: intervals(occupancy.effects),
    clipping: occupancy.clipping, safeForLiveVoice: occupancy.safeForLiveVoice,
  };
}
