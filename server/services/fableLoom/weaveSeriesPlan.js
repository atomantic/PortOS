/** Draft, review, and edit the FableLoom series plan and review episode outlines. */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { renderCharacterEvolutionListForPrompt } from '../../lib/characterEvolution.js';
import { analyzeEpisodeGraph, describeGraphForPrompt } from '../../lib/fableLoomGraph.js';
import { describeStoryOutlineForPrompt, fableLoomPlotPointKind } from '../../lib/fableLoomOutline.js';
import { LOOM_LIMITS, fableLoomEvolutionEvidenceRefs, findEpisode, mutateLoom } from './records.js';
import { isStr, trimTo } from '../../lib/textUtils.js';
import { aiShapeError, requireLoom, createLoomAiStatus, runLoomAi } from './weaveShared.js';
import { buildCanonDigest, storyContext, outlineStructuralAnalysis, episodeSequenceDigest } from './weaveContext.js';

const seriesPlanDigest = (loom) => JSON.stringify({
  ...(Object.hasOwn(loom.seriesPlan || {}, 'seriesDesign')
    ? { seriesDesign: loom.seriesPlan.seriesDesign }
    : {}),
  storyArc: loom.seriesPlan?.storyArc || '',
  plotPoints: (loom.seriesPlan?.plotPoints || []).map((item) => ({
    ...item, description: item.description || '',
  })),
  sideQuests: (loom.seriesPlan?.sideQuests || []).map((item) => ({
    ...item, description: item.description || '',
  })),
  deliveryOptions: loom.seriesPlan?.deliveryOptions || null,
  interEpisodeVoicemails: (loom.seriesPlan?.interEpisodeVoicemails || []).map((item) => ({
    ...item, transcript: item.transcript || '',
  })),
  nextSeasonTeaser: loom.seriesPlan?.nextSeasonTeaser
    ? { ...loom.seriesPlan.nextSeasonTeaser, transcript: loom.seriesPlan.nextSeasonTeaser.transcript || '' }
    : null,
  protagonistCharacterId: loom.protagonistCharacterId || null,
  protagonistWardrobeId: loom.protagonistWardrobeId || null,
  protagonistWardrobeLocked: loom.protagonistWardrobeLocked === true,
  episodes: loom.episodes.map(({ id, number, title, synopsis, storyOutline }) => ({
    id,
    number,
    title,
    synopsis: synopsis || '',
    beatOutline: storyOutline ? describeStoryOutlineForPrompt(storyOutline) : '(missing)',
  })),
}, null, 2);

// The OPTIONAL five-stage evolution lens (#6443), rendered for whichever cast
// members carry one. `seriesPlanDigest` above is a hand-picked projection of
// `loom.seriesPlan` — it whitelists fields, so the lens would NOT ride along
// inside it — and the plan review needs the lens gated on its own anyway:
// unset ⇒ '', the template's {{#characterEvolutions}} section renders nothing,
// and the review degrades to exactly its pre-lens behavior. Anchors resolve
// against the whole loom (episode ids and scene keys are loom-wide), so a stage
// pointing at a deleted episode reads `[stale]` instead of passing as proof.
const characterEvolutionsDigest = (loom) => renderCharacterEvolutionListForPrompt(
  loom.seriesPlan?.characterEvolutions,
  fableLoomEvolutionEvidenceRefs(loom),
) || '';

const seriesTeleplayDigest = (loom) => loom.episodes.map((episode) => [
  `## Episode ${episode.number}: ${episode.title || 'Untitled'}`,
  episode.synopsis ? `Synopsis: ${trimTo(episode.synopsis, 500)}` : '',
  episode.storyOutline ? `Beat outline:\n${describeStoryOutlineForPrompt(episode.storyOutline)}` : 'Beat outline: (missing)',
  episode.nodes.length
    ? describeGraphForPrompt(episode, { proseLimit: 800, participationMode: loom.participationMode })
    : '(no expanded teleplay scenes)',
].filter(Boolean).join('\n')).join('\n\n');

// A full-plan draft replaces the whole scaffold after a potentially slow
// provider call. Capture every authored input the stage read so a save made
// while that call is in flight cannot be overwritten by a stale response.
const seriesPlanGenerationFingerprint = (loom) => JSON.stringify({
  name: loom.name,
  logline: loom.logline,
  premise: loom.premise,
  format: loom.format,
  universeId: loom.universeId,
  protagonistCharacterId: loom.protagonistCharacterId,
  protagonistWardrobeId: loom.protagonistWardrobeId,
  protagonistWardrobeLocked: loom.protagonistWardrobeLocked,
  seriesPlan: loom.seriesPlan,
  episodes: loom.episodes.map(({ id, number, title, synopsis, storyOutline }) => ({
    id, number, title, synopsis, storyOutline,
  })),
});

const analysisStrings = (value) => (Array.isArray(value) ? value : [])
  .filter((item) => typeof item === 'string')
  .map((item) => trimTo(item, 1000))
  .filter(Boolean)
  .slice(0, 12);

const requirePlanningVerdict = (content) => {
  if (typeof content?.summary !== 'string' || !content.summary.trim()
    || !Array.isArray(content.risks) || !content.risks.every((risk) => typeof risk === 'string' && risk.trim())) {
    throw aiShapeError('The planning review returned no explicit verdict');
  }
};

/** Read-only story-editor pass over one episode's beat outline. */
export async function reviewEpisodeOutline(loomId, episodeId, { providerId, model, effort, operationId, planningGate = false } = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  if (!episode.storyOutline) {
    throw new ServerError('Draft an episode outline before reviewing it', { status: 409, code: 'OUTLINE_REQUIRED' });
  }
  const structural = outlineStructuralAnalysis(loom, episode);
  const reviewStatus = createLoomAiStatus({ operationId }, { action: 'review-episode-outline', label: 'Reviewing episode outline' });
  if (loom.episodes[0]?.id === episode.id) {
    // A full bible gives the reviewer knowledge the audience has not earned.
    // Follow the opening path, withholding synopsis, canon and later payoffs.
    const opening = [];
    const openingGroups = new Set();
    const groupByKey = new Map(episode.nodes.map((node) => [node.id, node.shot?.dramaticSceneId || node.id]));
    const byKey = new Map(episode.storyOutline.scenes.map((scene) => [scene.key, scene]));
    let beat = byKey.get(episode.storyOutline.startKey);
    while (beat && !opening.some((item) => item.key === beat.key)) {
      const group = groupByKey.get(beat.key) || beat.key;
      if (!openingGroups.has(group) && openingGroups.size >= 3) break;
      openingGroups.add(group);
      opening.push({ key: beat.key, title: beat.title, summary: beat.summary });
      if (beat.playbackMode === 'decision') break;
      beat = byKey.get(beat.transitions[0]?.targetKey);
    }
    const cold = await runLoomAi('fableloom-review-episode-outline', {
      storyContext: 'COLD OPENING REVIEW ONLY. You are a first-time viewer with no synopsis or world bible. From the opening beats alone, explain who the protagonist is, what they want right now, what interrupts them, and why that matters emotionally. Cite observable actions for each answer. Do not infer missing motivation from genre or fill gaps using imagined dialogue. Mystery about the cause is welcome; confusion about the basic situation is a blocking risk. Put missing orientation, unearned emotional investment and unexplained terminology needed to follow the action in risks, not recommendations. Return the usual summary, strengths, risks and recommendations JSON; summary and risks are required. Evaluate only this opening, not absent later endings.',
      canonDigest: '(withheld for first-time-viewer review)',
      episodeSequence: '(withheld)',
      outlineDigest: JSON.stringify(opening),
      structuralDigest: '(not part of this cold read)',
    }, { providerId, model, effort, operationId }, {
      action: 'review-episode-outline', label: 'Checking first-time viewer understanding', source: 'fableloom-review-episode-outline', status: reviewStatus, complete: false,
    });
    if (typeof cold.content?.summary !== 'string' || !cold.content.summary.trim()
      || !Array.isArray(cold.content?.risks) || !cold.content.risks.every((risk) => typeof risk === 'string' && risk.trim())) {
      reviewStatus?.error('The opening review returned no explicit comprehension verdict');
      throw aiShapeError('The opening review returned no explicit comprehension verdict');
    }
    if (cold.content.risks.length) {
      reviewStatus?.complete('Opening needs revision', { runId: cold.runId, shellReady: false });
      return {
        structural, runId: cold.runId,
        analysis: {
          summary: trimTo(cold.content.summary, 2000),
          strengths: analysisStrings(cold.content.strengths),
          risks: analysisStrings(cold.content.risks),
          recommendations: analysisStrings(cold.content.recommendations),
        },
      };
    }
  }
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runLoomAi('fableloom-review-episode-outline', {
    storyContext: [storyContext(loom, episode), planningGate ? 'PLANNING GATE: Put only present contradictions, missing required beats, missing opening orientation or emotional stakes, illegible choices, or unearned consequences that require changing this outline in risks. Put execution advice for the later teleplay (for example how to avoid too much dialogue) in recommendations. Do not require finished dialogue or images at outline stage. An outline with no remaining concrete blockers should return an empty risks array.' : ''].filter(Boolean).join('\n'),
    canonDigest: canonDigest || '(none)',
    episodeSequence: episodeSequenceDigest(loom, episode.id),
    outlineDigest: describeStoryOutlineForPrompt(episode.storyOutline),
    structuralDigest: structural.issues.length
      ? structural.issues.map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')
      : '(no structural issues)',
  }, { providerId, model, effort, operationId }, {
    action: 'review-episode-outline', label: 'Reviewing episode outline', source: 'fableloom-review-episode-outline', status: reviewStatus,
  });
  if (planningGate) requirePlanningVerdict(content);
  const analysis = {
    summary: trimTo(content?.summary, 2000),
    strengths: analysisStrings(content?.strengths),
    risks: analysisStrings(content?.risks),
    recommendations: analysisStrings(content?.recommendations),
  };
  if (!analysis.summary && !analysis.strengths.length && !analysis.risks.length && !analysis.recommendations.length) {
    throw aiShapeError('The model returned no usable episode-outline analysis');
  }
  return { structural, analysis, runId };
}

/**
 * Draft the complete series-level scaffold from the story metadata, linked
 * universe canon, current episode outline, and any useful ideas already in the
 * plan. This intentionally replaces only `seriesPlan`; episode records and
 * scene graphs remain untouched.
 */
export async function generateSeriesPlan(loomId, { providerId, model, effort, operationId } = {}) {
  const loom = await requireLoom(loomId);
  const sourceFingerprint = seriesPlanGenerationFingerprint(loom);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runLoomAi('fableloom-generate-series-plan', {
    storyContext: storyContext(loom, undefined, { includeSeriesPlan: false }),
    canonDigest: canonDigest || '(none — invent only what the premise needs)',
    seriesPlanJson: seriesPlanDigest(loom),
  }, { providerId, model, effort, operationId }, {
    action: 'generate-series-plan', label: 'Drafting series plan', source: 'fableloom-generate-series-plan',
  });

  const storyArc = isStr(content?.storyArc) ? content.storyArc : '';
  const isUsablePlanItem = (item) => item && typeof item === 'object'
    && ((isStr(item.title) && item.title.trim()) || (isStr(item.description) && item.description.trim()));
  const plotPoints = (Array.isArray(content?.plotPoints) ? content.plotPoints : [])
    .filter(isUsablePlanItem)
    .map((item) => ({ ...item, kind: fableLoomPlotPointKind(item) }));
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
    current.seriesPlan = { ...current.seriesPlan, storyArc, plotPoints, sideQuests };
    return current;
  });
  return { loom: updated, runId };
}

/** Read-only story-editor pass over the arc, tentpole beats, side quests, and episode outline. */
export async function reviewSeriesPlan(loomId, { providerId, model, effort, operationId, planningOnly = false } = {}) {
  const loom = await requireLoom(loomId);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runLoomAi('fableloom-review-series-plan', {
    storyContext: [storyContext(loom, undefined, { includeSeriesPlan: false }), planningOnly ? 'PRE-OUTLINE REVIEW: Evaluate the arc, challenge design and episode assignments. Missing or stale episode outlines are expected at this stage and will be drafted or repaired next; do not report their absence as a plan defect. Keep plot-point notes concise; episode beat outlines have their own fields.' : ''].filter(Boolean).join('\n'),
    canonDigest: canonDigest || '(none)',
    seriesPlanJson: seriesPlanDigest(loom),
    characterEvolutions: characterEvolutionsDigest(loom),
  }, { providerId, model, effort, operationId }, {
    action: 'review-series-plan', label: 'Reviewing series plan', source: 'fableloom-review-series-plan',
  });
  if (planningOnly) requirePlanningVerdict(content);
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

/** Read-only story-editor pass over every expanded episode as one teleplay series. */
export async function reviewSeriesTeleplay(loomId, { providerId, model, effort, operationId } = {}) {
  const loom = await requireLoom(loomId);
  if (!loom.episodes.length || loom.episodes.some((episode) => !episode.nodes.length)) {
    throw new ServerError('Expand every episode before reviewing the full teleplay series', {
      status: 409,
      code: 'TELEPLAY_INCOMPLETE',
    });
  }
  const canonDigest = await buildCanonDigest(loom);
  const structural = loom.episodes.map((episode) => ({
    episodeId: episode.id,
    episodeNumber: episode.number,
    ...analyzeEpisodeGraph(episode, {
      participationMode: loom.participationMode,
      requireAudienceIntroduction: episode.id === loom.episodes[0]?.id,
    }),
  }));
  const structuralDigest = structural.map((episode) => {
    const issues = episode.issues.length
      ? episode.issues.map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')
      : '(no structural issues)';
    return `Episode ${episode.episodeNumber}:\n${issues}`;
  }).join('\n');
  const { content, runId } = await runLoomAi('fableloom-review-series-teleplay', {
    storyContext: storyContext(loom, undefined, { includeSeriesPlan: false }),
    canonDigest: canonDigest || '(none)',
    seriesPlanJson: seriesPlanDigest(loom),
    teleplayDigest: seriesTeleplayDigest(loom),
    structuralDigest,
  }, { providerId, model, effort, operationId }, {
    action: 'review-series-teleplay', label: 'Reviewing full teleplay series', source: 'fableloom-review-series-teleplay',
  });
  const analysis = {
    summary: trimTo(content?.summary, 2000),
    strengths: analysisStrings(content?.strengths),
    risks: analysisStrings(content?.risks),
    recommendations: analysisStrings(content?.recommendations),
  };
  if (!analysis.summary && !analysis.strengths.length && !analysis.risks.length && !analysis.recommendations.length) {
    throw aiShapeError('The model returned no usable full-teleplay analysis');
  }
  return { structural, analysis, runId };
}

/** Apply one author instruction to the series-level plan without touching episode scene graphs. */
export async function feedbackSeriesPlan(loomId, {
  feedback, providerId, model, effort, operationId,
} = {}) {
  const instruction = trimTo(feedback, LOOM_LIMITS.FEEDBACK_MAX);
  if (!instruction) {
    throw new ServerError('Series-plan feedback is required', { status: 400, code: 'FEEDBACK_REQUIRED' });
  }
  const loom = await requireLoom(loomId);
  const sourceFingerprint = seriesPlanGenerationFingerprint(loom);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runLoomAi('fableloom-feedback-series-plan', {
    storyContext: storyContext(loom, undefined, { includeSeriesPlan: false }),
    canonDigest: canonDigest || '(none)',
    seriesPlanJson: seriesPlanDigest(loom),
    feedback: instruction,
  }, { providerId, model, effort, operationId }, {
    action: 'feedback-series-plan', label: 'Updating series plan', source: 'fableloom-feedback-series-plan',
  });

  if (!content || typeof content !== 'object') {
    throw aiShapeError('The model returned no series-plan edits');
  }
  const hasPlanEdit = (Object.hasOwn(content, 'storyArc') && typeof content.storyArc === 'string')
    || Array.isArray(content.plotPointEdits) || Array.isArray(content.plotPointOrder)
    || Array.isArray(content.sideQuestEdits) || Array.isArray(content.sideQuestOrder)
    || Array.isArray(content.episodeSynopsisEdits);
  if (!hasPlanEdit) throw aiShapeError('The model returned no usable series-plan edits');

  const updated = await mutateLoom(loomId, (current) => {
    if (seriesPlanGenerationFingerprint(current) !== sourceFingerprint) {
      throw new ServerError('The story changed while its plan feedback was being applied', {
        status: 409,
        code: 'LOOM_CHANGED_DURING_GENERATION',
      });
    }
    const plan = { ...current.seriesPlan };
    if (Object.hasOwn(content, 'storyArc') && typeof content.storyArc === 'string') plan.storyArc = content.storyArc;
    plan.plotPoints = applyPlanItemEdits(plan.plotPoints, content.plotPointEdits, content.plotPointOrder, {
      prefix: 'plot', fields: ['kind', 'title', 'description', 'episodeId'],
    });
    plan.sideQuests = applyPlanItemEdits(plan.sideQuests, content.sideQuestEdits, content.sideQuestOrder, {
      prefix: 'quest', fields: ['title', 'description', 'status', 'startEpisodeId', 'endEpisodeId'],
    });
    for (const edit of (Array.isArray(content.episodeSynopsisEdits) ? content.episodeSynopsisEdits : [])) {
      const episode = current.episodes.find((item) => item.id === edit?.id);
      if (episode && typeof edit.synopsis === 'string') {
        episode.synopsis = edit.synopsis;
        episode.updatedAt = new Date().toISOString();
      }
    }
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
        if (Object.hasOwn(edit, field)) item[field] = edit[field];
      }
      continue;
    }
    if (!edit.id && edit.remove !== true) {
      const item = { id: `${prefix}-${randomUUID()}` };
      for (const field of fields) {
        if (Object.hasOwn(edit, field)) item[field] = edit[field];
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
