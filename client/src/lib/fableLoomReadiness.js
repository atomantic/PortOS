/**
 * Client-side FableLoom story-first readiness checks.
 *
 * Media controls use this small mirror of the server's ordered beat-arc gate
 * so a human sees the same sequence everywhere: outline every episode,
 * validate the arc, author configured handoffs, then render storyboard stills.
 * The server remains authoritative for expansion and batch preflight.
 */

const asArray = (value) => (Array.isArray(value) ? value : []);
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

const reachableNodes = (episode) => {
  const nodes = asArray(episode?.nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(episode?.startNodeId)) return [];
  const ordered = [];
  const seen = new Set();
  const queue = [episode.startNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (seen.has(nodeId)) continue;
    const node = byId.get(nodeId);
    if (!node) continue;
    seen.add(nodeId);
    ordered.push(node);
    asArray(node.transitions).forEach((transition) => {
      if (byId.has(transition?.targetNodeId) && !seen.has(transition.targetNodeId)) {
        queue.push(transition.targetNodeId);
      }
    });
  }
  return ordered;
};

const playableChallenge = (item) => /^challenge\s*(?:[-—:]|$)/i.test(item?.title?.trim() || '');

const nodeHasMotionDelivery = (node) => {
  const assets = node?.playbackAssets || {};
  const hasEntry = hasText(node?.videoHistoryId) || hasText(assets.entryVideoHistoryId);
  if (!hasEntry) return false;
  if (node?.playbackMode !== 'decision' || node?.isEnding) return true;
  const exits = assets.exitByTransition || {};
  return asArray(assets.holdLoopVideoHistoryIds).length > 0
    && asArray(node.transitions).every((transition) => hasText(exits[transition.id]));
};

const deliveryHandoffsReady = (loom) => {
  const episodes = asArray(loom?.episodes);
  const plan = loom?.seriesPlan || {};
  const options = plan.deliveryOptions || {};
  if (options.overnightVoicemails === true) {
    const messages = new Map(asArray(plan.interEpisodeVoicemails).map((item) => (
      [`${item?.fromEpisodeId}::${item?.toEpisodeId}`, item]
    )));
    const missing = episodes.slice(0, -1).some((episode, index) => (
      !hasText(messages.get(`${episode.id}::${episodes[index + 1]?.id}`)?.transcript)
    ));
    if (missing) return false;
  }
  return options.nextSeasonTeaser !== true || hasText(plan.nextSeasonTeaser?.transcript);
};

export function fableLoomEpisodeOrderReadiness(loom, episode) {
  const episodes = asArray(loom?.episodes);
  const currentIndex = episodes.findIndex((candidate) => candidate?.id === episode?.id);
  if (currentIndex < 0) {
    return { ready: false, reason: 'The selected episode is not present in the ordered loom.' };
  }
  for (const [index, priorEpisode] of episodes.slice(0, currentIndex).entries()) {
    const missing = reachableNodes(priorEpisode).filter((node) => !hasText(node.image));
    if (missing.length) {
      const priorNumber = priorEpisode.number || index + 1;
      const currentNumber = episode.number || currentIndex + 1;
      return {
        ready: false,
        reason: `Finish storyboard images for Episode ${priorNumber} before generating Episode ${currentNumber}.`,
        blockedBy: { episodeId: priorEpisode.id, episodeNumber: priorNumber, missingScenes: missing.length },
      };
    }
  }
  return { ready: true, reason: '' };
}

export function fableLoomStoryReadiness(loom) {
  const episodes = asArray(loom?.episodes);
  if (!episodes.length) {
    return { ready: false, reason: 'Add episodes and validate their ordered beat outlines before generating media.' };
  }

  const missingOutlines = episodes
    .map((episode, index) => ({ episode, number: episode?.number || index + 1 }))
    .filter(({ episode }) => episode?.storyOutline?.validation?.status !== 'valid');
  if (missingOutlines.length) {
    const labels = missingOutlines.slice(0, 3).map(({ number }) => `Episode ${number}`).join(', ');
    const suffix = missingOutlines.length > 3 ? '…' : '';
    return {
      ready: false,
      reason: `Validate the complete ordered beat arc before generating media (${labels}${suffix} still needs outline review).`,
    };
  }

  const deliveryOptions = loom?.seriesPlan?.deliveryOptions || {};
  if (deliveryOptions.overnightVoicemails === true) {
    const voicemails = new Map(asArray(loom?.seriesPlan?.interEpisodeVoicemails)
      .filter((item) => item?.fromEpisodeId && item?.toEpisodeId)
      .map((item) => [`${item.fromEpisodeId}::${item.toEpisodeId}`, item]));
    for (let index = 0; index < episodes.length - 1; index += 1) {
      const from = episodes[index];
      const to = episodes[index + 1];
      const voicemail = voicemails.get(`${from.id}::${to.id}`);
      if (!hasText(voicemail?.transcript)) {
        return {
          ready: false,
          reason: `Author the overnight voicemail from Episode ${from.number || index + 1} to Episode ${to.number || index + 2} before generating media.`,
        };
      }
    }
  }

  if (deliveryOptions.nextSeasonTeaser === true
    && !hasText(loom?.seriesPlan?.nextSeasonTeaser?.transcript)) {
    return { ready: false, reason: 'Author the finale next-season teaser before generating media.' };
  }

  return { ready: true, reason: '' };
}

export function fableLoomMediaReadiness(loom, episode) {
  if (!episode?.nodes?.length) return { ready: true, reason: '' };
  const story = fableLoomStoryReadiness(loom);
  if (!story.ready) return story;
  return fableLoomEpisodeOrderReadiness(loom, episode);
}

/**
 * One producer-facing sequence shared by manual and AI-assisted work. The
 * first incomplete stage is the current action; later incomplete stages stay
 * visibly blocked while already-finished downstream work remains acknowledged.
 */
export function fableLoomProductionWorkflow(loom, episode, {
  structural = null,
  editorialRun = null,
  continuityReview = null,
} = {}) {
  const episodes = asArray(loom?.episodes);
  const plotPoints = asArray(loom?.seriesPlan?.plotPoints);
  const challenges = plotPoints.filter(playableChallenge);
  const reachable = episodes.flatMap(reachableNodes);
  const outlinesReady = episodes.length > 0
    && episodes.every((item) => item?.storyOutline?.validation?.status === 'valid');
  const teleplaysReady = episodes.length > 0 && episodes.every((item) => asArray(item?.nodes).length > 0);
  const structureReady = teleplaysReady && structural?.stats?.errorCount === 0;
  const planReady = challenges.length > 0 && plotPoints.every((item) => (
    hasText(item?.title) && hasText(item?.description) && hasText(item?.episodeId)
  ));
  const imagesReady = reachable.length > 0 && reachable.every((node) => hasText(node?.image));
  const motionReady = reachable.length > 0 && reachable.every(nodeHasMotionDelivery)
    && structural?.productionReadiness?.ready !== false;
  const handoffsReady = deliveryHandoffsReady(loom);
  const selectedEpisodeLabel = episode?.number ? `Episode ${episode.number}` : 'Selected episode';
  const editorialCompletedAt = Date.parse(editorialRun?.completedAt || '');
  const storyUpdatedAt = Date.parse(loom?.updatedAt || '');
  const editorialIsCurrent = editorialRun?.status === 'completed'
    && (!Number.isFinite(editorialCompletedAt)
      || !Number.isFinite(storyUpdatedAt)
      || editorialCompletedAt >= storyUpdatedAt);

  const stages = [
    {
      id: 'foundation', label: 'Story foundation', action: 'settings',
      complete: hasText(loom?.name) && (hasText(loom?.premise) || hasText(loom?.logline)),
      detail: 'Lock the format, premise, protagonist, and audience participation mode.',
    },
    {
      id: 'series-arc', label: 'Series arc', action: 'series-plan',
      complete: hasText(loom?.seriesPlan?.storyArc),
      detail: 'Define the beginning-to-end dramatic movement before expanding episodes.',
    },
    {
      id: 'challenges', label: 'Plot points & playable challenges', action: 'series-plan',
      complete: planReady,
      detail: challenges.length
        ? `${challenges.length} playable challenge${challenges.length === 1 ? '' : 's'} mapped to episodes; every plot point needs an assignment.`
        : 'Add at least one playable challenge, then map every tentpole and challenge to an episode; each challenge needs setup, a choice loop, success, failure, and recovery.',
    },
    {
      id: 'outlines', label: 'Episode beat outlines', action: 'outline',
      complete: outlinesReady,
      detail: `${episodes.filter((item) => item?.storyOutline?.validation?.status === 'valid').length}/${episodes.length} episode outlines validated.`,
    },
    {
      id: 'teleplays', label: 'Expand teleplay scenes', action: 'episode-setup',
      complete: teleplaysReady,
      detail: `${episodes.filter((item) => asArray(item?.nodes).length > 0).length}/${episodes.length} episodes expanded into scene graphs.`,
    },
    {
      id: 'structure', label: 'Structure & path checks', action: 'story-review',
      complete: structureReady,
      detail: structural?.stats
        ? `${selectedEpisodeLabel}: ${structural.stats.errorCount} structural blocker${structural.stats.errorCount === 1 ? '' : 's'}.`
        : `Validate ${selectedEpisodeLabel.toLowerCase()}'s graph, every choice, and every reachable ending.`,
    },
    {
      id: 'editorial', label: 'Editorial autopilot', action: 'series-plan',
      complete: editorialIsCurrent,
      detail: editorialRun?.status === 'completed' && !editorialIsCurrent
        ? 'The story changed after the latest successful run; run editorial autopilot again.'
        : editorialRun?.status
          ? `Latest run: ${editorialRun.status}${editorialRun.stepIndex ? ` · step ${editorialRun.stepIndex}/${editorialRun.stepCount}` : ''}.`
          : 'Repair the series, exercise every path, and repeat until editorial gates pass.',
    },
    {
      id: 'continuity', label: 'Continuity & canon', action: 'continuity',
      complete: continuityReview?.passed === true,
      detail: continuityReview
        ? `${selectedEpisodeLabel}: ${continuityReview.summary?.errors || 0} errors and ${continuityReview.summary?.warnings || 0} warnings.`
        : `Check ${selectedEpisodeLabel.toLowerCase()} for character, wardrobe, voice, pronunciation, playback, and convergence continuity.`,
    },
    {
      id: 'handoffs', label: 'Viewer handoffs', action: 'series-plan',
      complete: handoffsReady,
      detail: handoffsReady
        ? 'Every enabled between-episode voicemail and finale teaser is authored.'
        : 'Author each enabled overnight voicemail and the finale teaser.',
    },
    {
      id: 'storyboards', label: 'Storyboard images', action: 'render',
      complete: imagesReady,
      detail: `${reachable.filter((node) => hasText(node?.image)).length}/${reachable.length} reachable scenes have storyboard images.`,
    },
    {
      id: 'motion', label: 'Motion & live voice assets', action: 'render',
      complete: motionReady,
      detail: `${reachable.filter(nodeHasMotionDelivery).length}/${reachable.length} reachable scenes have their required entry, hold, and exit motion assets.`,
    },
    {
      id: 'delivery', label: 'Final playthrough & host', action: 'play',
      complete: false,
      detail: 'Run the audience experience end to end, then open the hosted demo when the final route feels right.',
    },
  ];
  const currentIndex = stages.findIndex((stage) => !stage.complete);
  return {
    currentIndex,
    currentStep: currentIndex + 1,
    totalSteps: stages.length,
    completedCount: currentIndex < 0 ? stages.length : currentIndex,
    stages: stages.map((stage, index) => ({
      ...stage,
      number: index + 1,
      status: stage.complete ? 'complete' : index === currentIndex ? 'current' : 'blocked',
    })),
  };
}
