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
