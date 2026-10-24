/**
 * Dependency-free playback for an exported package. The page copies authored
 * strings into the DOM as text. This module never fetches, and it never treats
 * a model-supplied target as a scene id.
 */

const TURN_PHASES = new Set(['idle', 'listening', 'thinking', 'speaking']);

function major(version) {
  const match = typeof version === 'string' ? /^(\d+)\.\d+\.\d+$/.exec(version) : null;
  return match ? Number(match[1]) : null;
}

function normalizePhrase(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/g, '');
}

function nodeIndex(episode) {
  const nodes = new Map();
  for (const node of episode?.nodes || []) {
    if (node && typeof node.id === 'string' && node.id && !nodes.has(node.id)) nodes.set(node.id, node);
  }
  return nodes;
}

function presence(node) {
  const windowPresence = node?.interactionWindow?.enabled ? node.interactionWindow.protagonistPresence : null;
  if (windowPresence === 'onscreen' || windowPresence === 'offscreen') return windowPresence;
  return node?.protagonistPresence === 'onscreen' ? 'onscreen' : 'offscreen';
}

function occupancyBlocks(asset) {
  if (!asset || typeof asset !== 'object') return false;
  if (asset.safeForLiveVoice === false) return true;
  const occupancy = asset.audioOccupancy;
  if (!occupancy || typeof occupancy !== 'object') return false;
  // Recompute from the intervals. A stored safeForLiveVoice true cannot override them.
  const peak = Number.isFinite(occupancy.truePeakDb) ? occupancy.truePeakDb
    : (Number.isFinite(occupancy.peakDb) ? occupancy.peakDb : null);
  if (occupancy.safeForLiveVoice === false || occupancy.clipping === true
    || occupancy.clipped === true || occupancy.clippingDetected === true
    || (peak !== null && peak > 0)) return true;
  if (Array.isArray(occupancy.characterDialogue) && occupancy.characterDialogue.length > 0) return true;
  if (Array.isArray(occupancy.effects) && occupancy.effects.some((effect) => effect?.blocking === true)) return true;
  return false;
}

/** Package-relative media only. Anything else, including a remote URL, is unusable. */
export function mediaUrl(file) {
  if (typeof file !== 'string' || !/^media\/[a-f0-9]{64}\.[a-z0-9]+$/.test(file)) return null;
  return `../${file}`;
}

function assetFile(asset) {
  return asset && mediaUrl(asset.file) ? asset : null;
}

export function liveInputAllowed(node, phase, asset) {
  if (!node) return { allowed: false, reason: 'NODE_NOT_FOUND' };
  if (node.isEnding) return { allowed: false, reason: 'STORY_ENDED' };
  if (node.audienceConnection !== 'connected') return { allowed: false, reason: 'AUDIENCE_DISCONNECTED' };
  if (node.playbackMode !== 'decision') return { allowed: false, reason: 'PLAYBACK_NOT_DECISION' };
  if (phase !== 'hold') return { allowed: false, reason: 'PLAYBACK_NOT_IN_HOLD_PHASE' };
  if (presence(node) === 'onscreen') return { allowed: false, reason: 'PROTAGONIST_ONSCREEN' };
  if (occupancyBlocks(asset)) return { allowed: false, reason: 'HOLD_ASSET_OCCUPIED_BY_DIALOGUE' };
  return { allowed: true };
}

function audienceCanChoose(manifest, node) {
  if (!node || node.isEnding || node.playbackMode !== 'decision') return false;
  if (manifest?.loom?.participationMode === 'helper') return node.audienceConnection === 'connected';
  return true;
}

function matchMessage(node, message) {
  if (!node) return { stay: '' };
  const normalized = normalizePhrase(message);
  const typed = String(message ?? '').trim();
  if (!normalized && !typed) return { stay: '' };
  const matches = [];
  for (const transition of node.transitions || []) {
    if (!transition || typeof transition.id !== 'string') continue;
    const phrases = [transition.intent, ...(Array.isArray(transition.triggers) ? transition.triggers : [])];
    const exact = transition.id === typed || phrases.some((phrase) => normalizePhrase(phrase) === normalized && normalized);
    if (exact) matches.push(transition);
  }
  if (matches.length !== 1) {
    return { stay: matches.length > 1 ? 'That could follow more than one path.' : 'Nothing on this scene answers that.' };
  }
  return { move: matches[0].id };
}

/**
 * Exact intent, trigger, or transition id. Several matches and zero matches
 * stay. No request leaves this function. The first episode that contains the
 * node id wins; a live session matches only its current episode.
 */
export function createKeywordResolver(manifest) {
  const episodes = new Map((manifest?.loom?.episodes || []).map((episode) => [episode.id, episode]));
  return function resolveTurn(nodeId, message) {
    let node = null;
    for (const episode of episodes.values()) {
      node = nodeIndex(episode).get(nodeId) || null;
      if (node) break;
    }
    return matchMessage(node, message);
  };
}

function speechOutcome(turn, outcome) {
  const status = outcome?.status;
  const known = status === 'completed' || status === 'empty' || status === 'failed'
    || status === 'cancelled' || status === 'unavailable' || status === 'missing';
  if (!known || outcome.turnId !== turn.id || outcome.nodeId !== turn.nodeId) {
    return { status: 'missing', turnId: turn.id, nodeId: turn.nodeId };
  }
  if (outcome.episodeId !== undefined && outcome.episodeId !== turn.episodeId) {
    return { status: 'missing', turnId: turn.id, nodeId: turn.nodeId };
  }
  if (outcome.generation !== undefined && outcome.generation !== turn.generation) {
    return { status: 'missing', turnId: turn.id, nodeId: turn.nodeId };
  }
  return { status, turnId: turn.id, nodeId: turn.nodeId };
}

/**
 * One episode of a versioned manifest. `resolveTurn` may be async. A move is
 * committed only after speech reports `completed` or an explicit `empty`.
 */
export function createSession(manifest, options = {}) {
  if (major(manifest?.schemaVersion) !== 1 || major(manifest?.runtimeVersion) !== 1) {
    throw Object.assign(new Error('This player supports package schema and runtime major version 1 only.'), { code: 'UNSUPPORTED_VERSION' });
  }
  const episodes = new Map();
  for (const episode of manifest?.loom?.episodes || []) {
    if (episode && typeof episode.id === 'string' && !episodes.has(episode.id)) episodes.set(episode.id, episode);
  }
  if (!episodes.size) {
    throw Object.assign(new Error('The package has no episodes.'), { code: 'MANIFEST_INVALID' });
  }
  let episodeId = episodes.has(options.episodeId) ? options.episodeId : manifest.loom.episodes[0].id;
  let nodes = nodeIndex(episodes.get(episodeId));
  const resolver = typeof options.resolveTurn === 'function'
    ? options.resolveTurn
    : (nodeId, message) => matchMessage(nodes.get(nodeId) || null, message);
  let nodeId = null;
  let phase = 'entry';
  let turnPhase = 'idle';
  let generation = 0;
  let activeTurnId = 0;
  let holdIteration = 0;
  let pendingTransitionId = null;
  let narration = '';
  let status = '';
  let clipGeneration = 0;
  let consumedClip = null;
  let deferredEnd = null;

  function notify() {
    if (typeof options.onChange === 'function') options.onChange(snapshot());
  }
  function currentNode() {
    return nodes.get(nodeId) || null;
  }
  function sameTurn(turn) {
    return turn.id === activeTurnId && turn.generation === generation
      && turn.nodeId === nodeId && turn.episodeId === episodeId;
  }
  function invalidate() {
    generation += 1;
    activeTurnId += 1;
  }
  function holdAsset(node) {
    const holds = (node?.playbackAssets?.holds || []).filter(assetFile);
    if (!holds.length) return assetFile(node?.playbackAssets?.entry);
    const count = holds.length;
    const mode = node?.interactionWindow?.holdLoopRotation;
    const index = mode === 'shuffle' ? Math.abs(holdIteration * 17) % count : holdIteration % count;
    return holds[index] || holds[0];
  }
  function currentAsset() {
    const node = currentNode();
    if (!node) return null;
    if (phase === 'entry') return assetFile(node.playbackAssets?.entry);
    if (phase === 'hold') return holdAsset(node);
    if (phase === 'exit' && pendingTransitionId) {
      const exits = node.playbackAssets?.exits;
      if (exits && typeof exits === 'object' && Object.hasOwn(exits, pendingTransitionId)) {
        return assetFile(exits[pendingTransitionId]);
      }
    }
    return null;
  }
  function settleTurnPhase(node) {
    turnPhase = phase === 'hold' && liveInputAllowed(node, phase, currentAsset()).allowed ? 'listening' : 'idle';
  }
  function staleClip(generation) {
    return typeof generation === 'number' && (generation !== clipGeneration || consumedClip === generation);
  }
  function consumeClip(generation) {
    if (typeof generation === 'number') consumedClip = generation;
  }
  function replayDeferredEnd() {
    if (deferredEnd === null) return;
    const generation = deferredEnd;
    deferredEnd = null;
    onMediaEnded(generation);
  }
  function enterNode(id) {
    deferredEnd = null;
    invalidate();
    const node = nodes.get(id);
    pendingTransitionId = null;
    holdIteration = 0;
    narration = '';
    clipGeneration += 1;
    if (!node) {
      nodeId = null;
      phase = 'ended';
      turnPhase = 'idle';
      status = 'That scene is not in this episode.';
      return;
    }
    nodeId = node.id;
    status = '';
    if (node.isEnding) phase = assetFile(node.playbackAssets?.entry) ? 'entry' : 'ended';
    else if (assetFile(node.playbackAssets?.entry)) phase = 'entry';
    else phase = 'hold';
    settleTurnPhase(node);
  }
  function edgeTarget(node, transitionId) {
    const edge = (node?.transitions || []).find((transition) => transition?.id === transitionId);
    const target = edge ? nodes.get(edge.targetNodeId) : null;
    return edge && target ? { edge, target } : null;
  }
  function beginTransition(node, edge) {
    const target = nodes.get(edge.targetNodeId);
    if (!target) {
      status = 'That path is not on this scene.';
      turnPhase = 'idle';
      return { action: 'stay', reason: 'ABSENT_TRANSITION' };
    }
    const exits = node.playbackAssets?.exits;
    const exit = exits && typeof exits === 'object' && Object.hasOwn(exits, edge.id) ? assetFile(exits[edge.id]) : null;
    if (exit) {
      pendingTransitionId = edge.id;
      phase = 'exit';
      turnPhase = 'idle';
      narration = '';
      clipGeneration += 1;
      status = '';
      return { action: 'exit', transitionId: edge.id };
    }
    enterNode(target.id);
    return { action: 'move', transitionId: edge.id, nodeId: target.id };
  }
  function chips() {
    const node = currentNode();
    if (phase !== 'hold' || turnPhase === 'thinking' || turnPhase === 'speaking' || !audienceCanChoose(manifest, node)) {
      return [];
    }
    return (node.transitions || []).filter((transition) => edgeTarget(node, transition.id)).map((transition) => ({
      id: transition.id,
      intent: typeof transition.intent === 'string' ? transition.intent : transition.id,
      description: typeof transition.description === 'string' ? transition.description : '',
    }));
  }
  function snapshot() {
    const node = currentNode();
    const asset = currentAsset();
    const holds = (node?.playbackAssets?.holds || []).filter(assetFile);
    return {
      episodeId,
      nodeId,
      phase,
      turnPhase,
      generation,
      ended: phase === 'ended' && node?.isEnding === true,
      title: typeof node?.title === 'string' ? node.title : '',
      prose: typeof node?.prose === 'string' ? node.prose : '',
      narration,
      endingLabel: node?.isEnding ? (node.endingLabel || node.title || '') : '',
      status,
      choices: chips(),
      admission: liveInputAllowed(node, phase, asset),
      media: asset ? {
        url: mediaUrl(asset.file),
        loop: phase === 'hold' && holds.length <= 1,
        generation: clipGeneration,
      } : null,
    };
  }
  function reserve(nextPhase) {
    if (!TURN_PHASES.has(nextPhase)) throw new Error('Unknown turn phase.');
    activeTurnId += 1;
    turnPhase = nextPhase;
    const turn = { id: activeTurnId, nodeId, episodeId, generation };
    notify();
    return turn;
  }
  async function finishSpeech(turn, text) {
    if (typeof options.onSpeak !== 'function') {
      return { status: text ? 'missing' : 'empty', turnId: turn.id, nodeId: turn.nodeId };
    }
    let outcome;
    try {
      outcome = await options.onSpeak({ ...turn, turnId: turn.id, text });
    } catch {
      outcome = { status: 'failed', turnId: turn.id, nodeId: turn.nodeId };
    }
    return speechOutcome(turn, outcome);
  }
  async function commitMove(turn, node, edge) {
    turnPhase = 'speaking';
    notify();
    const outcome = await finishSpeech(turn, '');
    if (!sameTurn(turn)) return { accepted: false, reason: 'STALE' };
    if (outcome.status !== 'completed' && outcome.status !== 'empty') {
      settleTurnPhase(node);
      status = 'The turn did not finish speaking, so the scene stayed.';
      notify();
      replayDeferredEnd();
      return { accepted: false, action: 'stay', reason: outcome.status };
    }
    const moved = beginTransition(node, edge);
    if (moved.action === 'stay') replayDeferredEnd();
    else deferredEnd = null;
    notify();
    return { accepted: moved.action !== 'stay', ...moved, speech: outcome.status };
  }

  function onMediaEnded(generation) {
    if (staleClip(generation)) return { action: 'ignore', reason: 'STALE_CLIP' };
    const node = currentNode();
    // The page removes its ended listener before this returns, so a clip that
    // finishes during a turn has to be replayed once the turn settles.
    if (!node || turnPhase === 'thinking' || turnPhase === 'speaking') {
      if (node && typeof generation === 'number') deferredEnd = generation;
      return { action: 'ignore', reason: 'HALF_DUPLEX' };
    }
    consumeClip(generation);
    if (phase === 'exit') {
      const chosen = edgeTarget(node, pendingTransitionId);
      if (!chosen) {
        phase = 'ended';
        turnPhase = 'idle';
        status = 'That path is not on this scene.';
        notify();
        return { action: 'stay', reason: 'ABSENT_TRANSITION' };
      }
      enterNode(chosen.target.id);
      notify();
      return { action: 'move', transitionId: chosen.edge.id, nodeId: chosen.target.id };
    }
    if (phase === 'entry') {
      if (node.isEnding || !(node.transitions || []).length) {
        phase = 'ended';
        turnPhase = 'idle';
        notify();
        return { action: 'ended' };
      }
      if (node.playbackMode === 'cut') {
        const first = edgeTarget(node, node.transitions[0]?.id);
        const result = first ? beginTransition(node, first.edge) : { action: 'stay', reason: 'ABSENT_TRANSITION' };
        if (!first) {
          phase = 'ended';
          turnPhase = 'idle';
          status = 'That path is not on this scene.';
        }
        notify();
        return result;
      }
      phase = 'hold';
      clipGeneration += 1;
      settleTurnPhase(node);
      notify();
      return { action: 'hold' };
    }
    if (phase === 'hold') {
      const holds = (node.playbackAssets?.holds || []).filter(assetFile);
      if (holds.length > 1) {
        holdIteration += 1;
        clipGeneration += 1;
      }
      settleTurnPhase(node);
      notify();
      return { action: 'loop' };
    }
    return { action: 'ignore' };
  }

  const initial = nodes.get(episodes.get(episodeId).startNodeId);
  enterNode(initial ? initial.id : '');

  return {
    snapshot,
    selectEpisode(id) {
      if (!episodes.has(id)) return { ok: false, reason: 'EPISODE_NOT_FOUND' };
      episodeId = id;
      nodes = nodeIndex(episodes.get(id));
      const start = nodes.get(episodes.get(id).startNodeId);
      enterNode(start ? start.id : '');
      notify();
      return { ok: true, ...snapshot() };
    },
    noteMediaFailure(generation) {
      if (staleClip(generation)) return { action: 'ignore', reason: 'STALE_CLIP' };
      if (phase !== 'entry' && phase !== 'exit') {
        status = 'This clip could not be played.';
        notify();
        return { action: 'status' };
      }
      const beforeNode = nodeId;
      const beforePhase = phase;
      const moved = onMediaEnded(generation);
      if (nodeId === beforeNode && phase === beforePhase) {
        status = 'This clip could not be played.';
        notify();
      }
      return moved;
    },
    onMediaEnded,
    async choose(transitionId) {
      const node = currentNode();
      if (turnPhase === 'thinking' || turnPhase === 'speaking') return { accepted: false, reason: 'HALF_DUPLEX' };
      if (!chips().some((choice) => choice.id === transitionId)) {
        return { accepted: false, action: 'stay', reason: phase === 'hold' ? 'ABSENT_TRANSITION' : 'CHIPS_CLOSED' };
      }
      const chosen = edgeTarget(node, transitionId);
      if (!chosen) return { accepted: false, action: 'stay', reason: 'ABSENT_TRANSITION' };
      const turn = reserve('speaking');
      return commitMove(turn, node, chosen.edge);
    },
    async submit(message) {
      const node = currentNode();
      const admission = liveInputAllowed(node, phase, currentAsset());
      if (!admission.allowed) return { accepted: false, reason: admission.reason };
      if (turnPhase !== 'listening') return { accepted: false, reason: 'HALF_DUPLEX' };
      const turn = reserve('thinking');
      let verdict;
      try {
        verdict = await resolver(node.id, message);
      } catch {
        if (!sameTurn(turn)) return { accepted: false, reason: 'STALE' };
        turnPhase = 'listening';
        status = 'The turn could not be resolved.';
        notify();
        replayDeferredEnd();
        return { accepted: false, reason: 'RESOLVER_FAILED' };
      }
      if (!sameTurn(turn)) return { accepted: false, reason: 'STALE' };
      if (verdict && typeof verdict.move === 'string') {
        const chosen = edgeTarget(node, verdict.move);
        if (!chosen) {
          turnPhase = 'listening';
          narration = '';
          status = 'That path is not on this scene.';
          notify();
          replayDeferredEnd();
          return { accepted: false, action: 'stay', reason: 'ABSENT_TRANSITION' };
        }
        return commitMove(turn, node, chosen.edge);
      }
      narration = verdict && typeof verdict.stay === 'string' ? verdict.stay : '';
      status = '';
      turnPhase = 'speaking';
      notify();
      const outcome = await finishSpeech(turn, narration);
      if (!sameTurn(turn)) return { accepted: false, reason: 'STALE' };
      turnPhase = 'listening';
      notify();
      replayDeferredEnd();
      return { accepted: true, action: 'stay', narration, speech: outcome.status };
    },
  };
}
