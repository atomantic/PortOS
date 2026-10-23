/** Draft/review timed shots; only apply a complete valid plan to the episode. */
import { createHash, randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { shotGroupsSchema } from '../../lib/fableLoomValidation.js';
import { analyzeEpisodeShots, estimatedShotSeconds } from '../../lib/fableLoomShots.js';
import { analyzeEpisodeGraph } from '../../lib/fableLoomGraph.js';
import { analyzeStoryOutline, fableLoomEpisodeChallenges } from '../../lib/fableLoomOutline.js';
import { getUniverse } from '../universeBuilder.js';
import { startAIOp } from '../aiStatusEvents.js';
import { runStagedLLM, resolveStageRoute } from '../stageRunner.js';
import { getLoom, findEpisode, mutateLoom } from './records.js';

const fingerprint = (loom, episode) => createHash('sha256').update(JSON.stringify({ episode, seriesPlan: loom.seriesPlan, protagonist: loom.protagonistCharacterId })).digest('hex');
const requireSource = async (id, episodeId) => {
  const loom = await getLoom(id);
  if (!loom) throw new ServerError('Story not found', { status: 404 });
  const episode = findEpisode(loom, episodeId);
  if (!episode.nodes.length) throw new ServerError('Write the dramatic scenes before splitting them into shots.', { status: 409 });
  return { loom, episode };
};
const script = (shot) => [shot.action, ...shot.dialogue.map((line) => `${line.speaker.toUpperCase()}\n${line.text.replace(/\s+/g, ' ').trim()}`)].join('\n\n');

function compile(loom, episode, groups) {
  const parsed = shotGroupsSchema.parse(groups).map((group) => ({ ...group, shots: group.shots.map((shot) => ({
    ...shot, durationSeconds: Math.max(shot.durationSeconds, Math.min(10, Math.ceil(estimatedShotSeconds(script(shot))))),
  })) }));
  const byId = new Map(parsed.map((group) => [group.sceneId, group]));
  if (byId.size !== parsed.length || byId.size !== episode.nodes.length || episode.nodes.some((node) => !byId.has(node.id))) {
    throw new ServerError('Every existing scene must have exactly one shot group.', { status: 422 });
  }
  const ids = new Map(episode.nodes.map((node) => [node.id, byId.get(node.id).shots.map((_, i) => i === 0 ? node.id : `node-${randomUUID()}`)]));
  const nodes = episode.nodes.flatMap((scene) => byId.get(scene.id).shots.map((shot, index, all) => {
    const last = index === all.length - 1;
    const decision = scene.playbackMode === 'decision';
    const appearances = scene.visualCanon?.characterAppearances || [];
    if (shot.visibleCharacterIds?.some((id) => !appearances.some((appearance) => appearance.characterId === id))) throw new ServerError('A shot names a character outside its source scene cast.', { status: 422 });
    return {
      ...scene, id: ids.get(scene.id)[index], title: shot.title, prose: script(shot),
      shot: { dramaticSceneId: scene.shot?.dramaticSceneId || scene.id, dramaticSceneTitle: scene.shot?.dramaticSceneTitle || scene.title, durationSeconds: shot.durationSeconds, framing: shot.framing },
      imagePrompt: shot.imagePrompt, videoPrompt: `${shot.durationSeconds}-second continuous shot. ${shot.videoPrompt}`, cameraMovement: 'static',
      image: null, imageJobId: null, videoHistoryId: null, visualConditioning: null, playbackAssets: {}, pos: null,
      protagonistPresence: shot.protagonistPresence || scene.protagonistPresence,
      visualCanon: scene.visualCanon ? { ...scene.visualCanon, characterAppearances: shot.visibleCharacterIds ? appearances.filter((appearance) => shot.visibleCharacterIds.includes(appearance.characterId)) : appearances, storyboardImageApproved: false, continuitySourceNodeId: null } : null,
      playbackMode: last ? scene.playbackMode : 'cut', isEnding: last && scene.isEnding,
      endingLabel: last ? scene.endingLabel : '',
      // Preparatory dialogue for a decision belongs to setup, not the loop.
      challengePhase: decision && !last ? 'setup' : scene.challengePhase,
      transitions: last ? scene.transitions.map((t) => ({ ...t, id: `tr-${randomUUID()}`, targetNodeId: ids.get(t.targetNodeId)?.[0] || t.targetNodeId }))
        : [{ id: `tr-${randomUUID()}`, targetNodeId: ids.get(scene.id)[index + 1], intent: 'continue', triggers: [], description: '' }],
    };
  }));
  if (nodes.length > 200) throw new ServerError('The shot plan exceeds the episode limit of 200 nodes.', { status: 422 });
  const proposed = { ...episode, nodes, startNodeId: ids.get(episode.startNodeId)[0] };
  const timing = analyzeEpisodeShots(proposed);
  const graph = analyzeEpisodeGraph(proposed, { participationMode: loom.participationMode });
  const outline = { version: 1, startKey: proposed.startNodeId, scenes: nodes.map((node) => ({
    key: node.id, title: node.title, summary: node.prose.slice(0, 1200), plotPointId: node.plotPointId, challengePhase: node.challengePhase,
    playbackMode: node.playbackMode, audienceConnection: node.audienceConnection, protagonistPresence: node.protagonistPresence,
    isEnding: node.isEnding, endingLabel: node.endingLabel, transitions: node.transitions.map((t) => ({ targetKey: t.targetNodeId, intent: t.intent })),
  })) };
  const outlineCheck = analyzeStoryOutline(outline, { participationMode: loom.participationMode, challenges: fableLoomEpisodeChallenges(loom, episode.id), plotPoints: loom.seriesPlan.plotPoints, episodeId: episode.id });
  const issues = [...timing.issues, ...graph.issues.filter((issue) => issue.severity === 'error'), ...outlineCheck.issues.filter((issue) => issue.severity === 'error')];
  proposed.storyOutline = { ...outline, validation: { status: issues.length ? 'invalid' : 'valid', issues, validatedAt: new Date().toISOString() } };
  return { groups: parsed, proposed, validation: { issues, stats: { ...timing.stats, ready: !issues.length } } };
}

export async function applyEpisodeShots(id, episodeId, { sourceFingerprint, groups }) {
  const { loom, episode } = await requireSource(id, episodeId);
  if (fingerprint(loom, episode) !== sourceFingerprint) throw new ServerError('The episode changed. Preview a fresh shot plan before applying.', { status: 409, code: 'SHOT_PLAN_STALE' });
  const { proposed, validation } = compile(loom, episode, groups);
  if (validation.issues.length) throw new ServerError(validation.issues.map((i) => i.message).join('\n'), { status: 422, code: 'SHOT_PLAN_INVALID' });
  const updated = await mutateLoom(id, (current) => {
    const target = findEpisode(current, episodeId);
    if (fingerprint(current, target) !== sourceFingerprint) throw new ServerError('The episode changed during shot planning.', { status: 409, code: 'SHOT_PLAN_STALE' });
    Object.assign(target, proposed, { updatedAt: new Date().toISOString() });
    current.productionStatus.editorialApprovedAt = null;
    current.productionStatus.editorialApprovalSource = null;
    return current;
  });
  return { loom: updated, validation };
}

/** Checkpoints are supplied only by the local run service, never by HTTP callers. */
export async function runEpisodeShotAutopilot(id, episodeId, {
  providerId, model, effort, operationId, guidance = '', maxRounds = 3, apply = false,
  checkpoint = {}, saveCheckpoint = async () => {}, isCanceled = () => false,
} = {}) {
  const { loom, episode } = await requireSource(id, episodeId);
  const sourceFingerprint = fingerprint(loom, episode);
  if (checkpoint.sourceFingerprint && checkpoint.sourceFingerprint !== sourceFingerprint) {
    throw new ServerError('The episode changed. Start a fresh shot plan.', { status: 409, code: 'SHOT_PLAN_STALE' });
  }
  checkpoint.sourceFingerprint = sourceFingerprint;
  checkpoint.scenes ||= {};
  checkpoint.consistency ||= [];
  const status = operationId ? startAIOp({ op: 'fableloom-shots', label: 'Planning timed shots', operationId, localOnly: true, silent: true }) : null;
  const universe = loom.universeId ? await getUniverse(loom.universeId) : null;
  const cast = (universe?.characters || []).map(({ id, name, physicalDescription }) => ({ id, name, physicalDescription }));
  // The rest of the episode supplies graph context, never another scene's teleplay.
  const context = { cast, synopsis: episode.synopsis, startNodeId: episode.startNodeId,
    sceneDigest: episode.nodes.map(({ id, title, playbackMode, transitions }) => ({ id, title, playbackMode, transitions: transitions.map(({ targetNodeId, intent }) => ({ targetNodeId, intent })) })) };
  const route = { returnsJson: true, ...(providerId ? { providerOverride: providerId } : {}), ...(model ? { modelOverride: model } : {}), ...(effort ? { effortOverride: effort } : {}) };
  const checkCanceled = () => {
    if (isCanceled()) throw new ServerError('Shot planning canceled; completed steps preserved.', { status: 409, code: 'SHOT_PLAN_CANCELED' });
  };
  const persist = async () => { await saveCheckpoint(checkpoint); checkCanceled(); };
  const execute = async (stage, variables, round, sceneId) => {
    checkCanceled();
    const resolved = await resolveStageRoute(stage, route);
    const selectedProvider = resolved.provider;
    const inputCharacters = Object.values(variables).reduce((total, value) => total + String(value).length, 0);
    checkpoint.current = { stage, round, sceneId, providerId: selectedProvider.id,
      inputCharacters, timeoutMs: selectedProvider.timeout,
      warning: inputCharacters > 12000 && (selectedProvider.timeout || 300000) <= 300000
        ? 'Large shot-planning input; this provider timeout may be too short. Completed steps will be preserved on failure.' : null };

    await persist();
    return runStagedLLM(stage, variables, { ...route, source: stage,
      onRunCreated: (runId) => status?.update('running', 'Planning and checking short shots…', { runId }),
      onRunReady: (meta) => status?.update('ready', 'Shot autopilot is running', meta),
    }).catch((error) => {
      const message = `${stage} round ${round}${sceneId ? ` scene ${sceneId}` : ''} on provider ${selectedProvider.id}: ${error.message}`;
      status?.error(message);
      throw new ServerError(message, { status: error.status || 502, code: error.code || 'SHOT_STAGE_FAILED' });
    });
  };
  const validReview = (review) => Array.isArray(review?.risks) && review.risks.every((risk) => typeof risk === 'string') && typeof review?.summary === 'string' && review.summary.trim();
  const groups = [];
  for (const node of episode.nodes) {
    const state = checkpoint.scenes[node.id] ||= { rounds: [] };
    const { id: sceneId, title, prose, playbackMode, shot, imagePrompt, videoPrompt,
      cameraMovement, image: referenceImage, visualCanon, protagonistPresence, challengePhase } = node;
    const source = JSON.stringify({ ...context, scenes: [{ id: sceneId, title, prose, playbackMode, shot, imagePrompt, videoPrompt,
      cameraMovement, referenceImage, visualCanon, protagonistPresence, challengePhase,
      visibleCharacterIds: (visualCanon?.characterAppearances || []).map((appearance) => appearance.characterId),
      transitions: context.sceneDigest.find((scene) => scene.id === node.id).transitions }] });
    for (let round = Math.max(1, state.rounds.length + (state.rounds.at(-1)?.feedback ? 1 : 0)); !state.group && round <= maxRounds; round += 1) {
      checkCanceled();
      const entry = state.rounds[round - 1] ||= {};
      const feedback = state.rounds[round - 2]?.feedback || '';
      if (!entry.draft) {
        const draft = await execute('fableloom-plan-shots', { source, guidance, feedback }, round, node.id);
        entry.draft = draft.content;
        await persist();
      }
      const parsed = shotGroupsSchema.safeParse(entry.draft?.groups);
      if (!parsed.success || parsed.data.length !== 1 || parsed.data[0].sceneId !== node.id) {
        entry.feedback = 'Return exactly one valid group for the supplied scene id.';
        await persist();
        continue;
      }
      // Timing can be checked locally; full graph/outline validation runs on the assembled plan.
      const group = parsed.data[0];
      const timing = analyzeEpisodeShots({ nodes: group.shots.map((shot, index) => ({ id: String(index), title: shot.title, playbackMode: index === group.shots.length - 1 ? node.playbackMode : 'cut', prose: script(shot), shot: { ...shot, durationSeconds: Math.max(shot.durationSeconds, Math.min(10, Math.ceil(estimatedShotSeconds(script(shot))))) } })) });
      const sceneCast = (node.visualCanon?.characterAppearances || []).map((appearance) => appearance.characterId);
      const invalidCast = group.shots.some((shot) => shot.visibleCharacterIds?.some((id) => !sceneCast.includes(id)));
      if (timing.issues.length || invalidCast) {
        entry.feedback = [...timing.issues.map((issue) => issue.message), ...(invalidCast ? ['A shot names a character outside its source scene cast.'] : [])].join('\n');
        await persist();
        continue;
      }
      if (!entry.review) {
        const review = await execute('fableloom-review-shots', { source, shots: JSON.stringify([group]) }, round, node.id);
        entry.review = review.content;
        await persist();
      }
      if (!validReview(entry.review) || entry.review.risks.length) {
        entry.feedback = validReview(entry.review) ? entry.review.risks.join('\n') : 'The reviewer returned no explicit verdict.';
      } else {
        state.group = group;
      }
      await persist();
    }
    if (!state.group) throw new ServerError(`Shot planning exhausted ${maxRounds} rounds for scene ${node.id}. Completed steps preserved.\n${state.rounds.at(-1)?.feedback || ''}`, { status: 422, code: 'SHOT_PLAN_INVALID' });
    groups.push(state.group);
  }
  const compiled = compile(loom, episode, groups);
  if (compiled.validation.issues.length) throw new ServerError(compiled.validation.issues.map((i) => i.message).join('\n'), { status: 422, code: 'SHOT_PLAN_INVALID' });
  // One whole-plan review, without the episode teleplay. It checks connections
  // between the scene plans already reviewed against their full dramatic source.
  const planHash = createHash('sha256').update(JSON.stringify(compiled.groups)).digest('hex');
  let review = checkpoint.consistency.findLast((entry) => entry.planHash === planHash)?.review;
  if (!review) {
    const result = await execute('fableloom-review-shots', { source: JSON.stringify({ ...context, scenes: context.sceneDigest }), shots: JSON.stringify(compiled.groups) }, checkpoint.consistency.length + 1, null);
    review = result.content;
    checkpoint.consistency.push({ planHash, review });
    await persist();
  }
  if (!validReview(review) || review.risks.length) {
    const feedback = validReview(review) ? review.risks.join('\n') : 'The consistency reviewer returned no explicit verdict.';
    if (checkpoint.consistency.length < maxRounds && Object.values(checkpoint.scenes).every((scene) => scene.rounds.length < maxRounds)) {
      // Cross-scene findings need a coordinated repair, using each scene's
      // full source again while preserving the rejected drafts and verdict.
      for (const scene of Object.values(checkpoint.scenes)) {
        scene.rounds.at(-1).feedback = feedback;
        delete scene.group;
      }
      await persist();
      return runEpisodeShotAutopilot(id, episodeId, { providerId, model, effort, operationId, guidance, maxRounds, apply, checkpoint, saveCheckpoint, isCanceled });
    }
    throw new ServerError(`Shot consistency review needs revision. Completed steps preserved.\n${feedback}`, { status: 422, code: 'SHOT_PLAN_INVALID' });
  }
  const result = { sourceFingerprint, groups: compiled.groups, validation: compiled.validation, review, attempt: Math.max(...Object.values(checkpoint.scenes).map((scene) => scene.rounds.length)) };
  checkCanceled();
  const applied = apply ? await applyEpisodeShots(id, episodeId, result) : {};
  status?.complete(apply ? 'Timed shots applied' : 'Shot plan ready to preview', { shellReady: false });
  return { ...result, ...applied };
}
