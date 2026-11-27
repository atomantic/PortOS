/** Build FableLoom story and outline context shared across workflow stages. */

import { renderStoryCanonDigest } from '../../lib/universePromptRenderers.js';
import { renderSeriesDesign } from '../../lib/storyArc.js';
import {
  analyzeStoryOutline,
  analyzeStoryOutlineTeleplaySync,
  fableLoomEpisodeChallenges,
  fableLoomPlotPointKind,
} from '../../lib/fableLoomOutline.js';
import { participationContractForPrompt } from '../../lib/fableLoomParticipation.js';
import { getUniverse } from '../universeBuilder.js';
import { loomFormatLabel } from '../../lib/fableLoomFormats.js';
import { trimTo } from '../../lib/textUtils.js';

/**
 * Render the linked universe's canon as a prompt digest via the shared
 * composer (field precedence, per-kind caps, the "+ N more" truncation footer,
 * and the authored Ghost/Wound/Lie/Want/Need engines every generative prompt
 * needs to make characters drive the plot). The bound protagonist is pinned so
 * a large cast can't push the one character the story is about past the cap.
 * Empty string when the loom has no universe — the stages treat it as optional.
 *
 * Reader-facing paths do NOT call this: `playTurn` never renders canon, and the
 * cold-opening first-time-viewer review passes its own withheld placeholder.
 *
 * The composer's reveal gate is left ON (its default): a character carrying a
 * `spoiler` flag or an unresolved `revealIssue` reaches these generation stages
 * as name + role + the authored surface stand-in, with the concealed
 * `background`/`personality` and the psychology block both withheld (#6426).
 */
export async function buildCanonDigest(loom) {
  if (!loom.universeId) return '';
  const universe = await getUniverse(loom.universeId).catch(() => null);
  if (!universe) return '';
  return renderStoryCanonDigest(universe, { protagonistCharacterId: loom.protagonistCharacterId });
}

const seriesPlanContext = (loom, episode) => {
  const plan = loom.seriesPlan;
  if (!plan) return [];
  const episodeLabels = new Map(loom.episodes.map((item) => [item.id, `Episode ${item.number}: ${item.title || 'Untitled'}`]));
  const relevantFirst = (items, matchesEpisode) => episode
    ? [...items].sort((a, b) => Number(matchesEpisode(b, episode.id)) - Number(matchesEpisode(a, episode.id)))
    : items;
  const plotPoints = relevantFirst(plan.plotPoints || [], (item, id) => item.episodeId === id)
    .map((item, index) => {
      const assignment = item.episodeId ? ` [planned for ${episodeLabels.get(item.episodeId) || item.episodeId}]` : ' [unassigned]';
      const challenge = fableLoomPlotPointKind(item) === 'challenge';
      return [
        `Plot point ${index + 1} id=${item.id} kind=${challenge ? 'challenge' : 'beat'}${assignment}: ${item.title || 'Untitled'}${item.description ? ` — ${item.description}` : ''}`,
        challenge && (!episode || item.episodeId === episode.id)
          ? 'PLAYABLE CHALLENGE CONTRACT: map this exact plot-point id onto separate outline/teleplay beats with challengePhase values setup, decision, success, failure, and recovery. The setup must lead to the decision loop; the decision must reach both success and failure; both outcomes must continue to recovery/payoff. Failure continues with a visible cost rather than resetting or dead-ending.'
          : '',
      ].filter(Boolean).join('\n');
    });
  const sideQuests = relevantFirst(plan.sideQuests || [], (item, id) => item.startEpisodeId === id || item.endEpisodeId === id)
    .slice(0, 12)
    .map((item) => {
      const start = item.startEpisodeId ? episodeLabels.get(item.startEpisodeId) || item.startEpisodeId : 'unassigned';
      const end = item.endEpisodeId ? episodeLabels.get(item.endEpisodeId) || item.endEpisodeId : 'unassigned';
      return `Side quest (${item.status}; starts ${start}; ends ${end}): ${item.title || 'Untitled'}${item.description ? ` — ${item.description}` : ''}`;
    });
  const delivery = plan.deliveryOptions || {};
  const deliveryLines = [];
  if (delivery.overnightVoicemails === true) {
    deliveryLines.push('Series delivery: include an authored overnight voicemail between every adjacent episode; it should carry the protagonist\'s emotional handoff and a reason to watch the next episode.');
    for (const voicemail of plan.interEpisodeVoicemails || []) {
      if (voicemail.transcript) {
        deliveryLines.push(`Overnight voicemail ${voicemail.fromEpisodeId || '?'} -> ${voicemail.toEpisodeId || '?'}: ${trimTo(voicemail.transcript, 500)}`);
      }
    }
  }
  if (delivery.nextSeasonTeaser === true) {
    deliveryLines.push('Series delivery: the final episode must leave a next-season teaser or unresolved cliffhanger after its ending.');
    if (plan.nextSeasonTeaser?.transcript) {
      deliveryLines.push(`Next-season teaser: ${trimTo(plan.nextSeasonTeaser.transcript, 500)}`);
    }
  }
  return [
    renderSeriesDesign(plan.seriesDesign),
    plan.storyArc ? `Series arc: ${plan.storyArc}` : '',
    ...plotPoints,
    ...sideQuests,
    ...deliveryLines,
  ].filter(Boolean);
};

export const requiresAudienceIntroduction = (loom, episode) => (
  !episode || episode.id === loom.episodes[0]?.id
);

export const audienceContract = (loom, episode) => participationContractForPrompt(loom, {
  requiresIntroduction: requiresAudienceIntroduction(loom, episode),
});

const protagonistContinuityContext = (loom) => [
  loom.protagonistCharacterId
    ? `Canonical protagonist binding: ${loom.protagonistCharacterId}. Every visible protagonist beat must use this Universe character.`
    : 'Canonical protagonist binding: (not configured — choose and bind the protagonist before visual production).',
  loom.protagonistWardrobeId
    ? `Canonical protagonist wardrobe: ${loom.protagonistWardrobeId}${loom.protagonistWardrobeLocked ? ' (locked across every on-screen scene)' : ' (default; an intentional scene change must be explicit).'}`
    : 'Canonical protagonist wardrobe: (not configured — do not invent a new outfit per scene).',
  'Every scene must declare protagonist presence. Off-screen protagonist scenes are valid: use them for direct communicator conversations with the audience and keep the protagonist out of the storyboard image. For an off-screen helper scene, frame the obstacle or space the protagonist cannot see — around a corner, beyond a bend, at a distance, or otherwise outside their sightline. The communicator stays on the protagonist\'s person and out of frame; never make a standalone comms device the subject of the storyboard image.',
];

export const storyContext = (loom, episode, { includeSeriesPlan = true } = {}) => [
  `Story: ${loom.name}`,
  `Scene format: ${loomFormatLabel(loom.format)}`,
  `Audience participation: ${audienceContract(loom, episode)}`,
  ...protagonistContinuityContext(loom),
  loom.logline ? `Logline: ${loom.logline}` : '',
  loom.premise ? `Premise: ${loom.premise}` : '',
  ...(includeSeriesPlan ? seriesPlanContext(loom, episode) : []),
  episode ? `CURRENT EPISODE ONLY: Episode ${episode.number}: ${episode.title || 'Untitled'} (id=${episode.id}). Other episode assignments are continuity context, not scenes to write here. Stop at this episode's ending; do not dramatize later episode plot points or challenge payoffs.` : '',
  episode?.synopsis ? `Synopsis: ${episode.synopsis}` : '',
].filter(Boolean).join('\n');

export const outlineStructuralAnalysis = (loom, episode) => {
  const structural = analyzeStoryOutline(episode.storyOutline, {
    nodes: episode.nodes,
    participationMode: loom.participationMode,
    requireAudienceIntroduction: requiresAudienceIntroduction(loom, episode),
    challenges: fableLoomEpisodeChallenges(loom, episode.id),
    plotPoints: loom.seriesPlan?.plotPoints,
    episodeId: episode.id,
  });
  const teleplaySync = analyzeStoryOutlineTeleplaySync(episode, episode.storyOutline, {
    participationMode: loom.participationMode,
  });
  return {
    issues: [...structural.issues, ...teleplaySync.issues],
    stats: {
      ...structural.stats,
      errorCount: structural.stats.errorCount + teleplaySync.stats.errorCount,
    },
  };
};

export const episodeSequenceDigest = (loom, currentEpisodeId) => loom.episodes.map((episode) => (
  `Episode ${episode.number}: ${episode.title || 'Untitled'}${episode.id === currentEpisodeId ? ' [CURRENT]' : ''}`
  + (episode.synopsis ? ` — ${trimTo(episode.synopsis, 500)}` : '')
)).join('\n');
