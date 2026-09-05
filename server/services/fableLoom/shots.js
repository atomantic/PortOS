/** Draft/review timed shots; only apply a complete valid plan to the episode. */
import { createHash, randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { shotGroupsSchema } from '../../lib/fableLoomValidation.js';
import { analyzeEpisodeShots, estimatedShotSeconds } from '../../lib/fableLoomShots.js';
import { analyzeEpisodeGraph } from '../../lib/fableLoomGraph.js';
import { analyzeStoryOutline, fableLoomEpisodeChallenges } from '../../lib/fableLoomOutline.js';
import { getUniverse } from '../universeBuilder.js';
import { startAIOp } from '../aiStatusEvents.js';
import { runStagedLLM } from '../stageRunner.js';
import { getLoom, findEpisode, mutateLoom } from './records.js';

const fingerprint = (loom, episode) => createHash('sha256').update(JSON.stringify({ episode, seriesPlan: loom.seriesPlan, protagonist: loom.protagonistCharacterId })).digest('hex');
const requireSource = async (id, episodeId) => {
  const loom = await getLoom(id);
  if (!loom) throw new ServerError('Story not found', { status: 404 });
  const episode = findEpisode(loom, episodeId);
  if (!episode.nodes.length) throw new ServerError('Write the dramatic scenes before splitting them into shots.', { status: 409 });
  return { loom, episode };
};
const script = (shot) => [shot.action, ...shot.dialogue.map((line) => `${line.speaker.toUpperCase()}\n${line.text}`)].join('\n\n');

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

export async function runEpisodeShotAutopilot(id, episodeId, { providerId, model, effort, operationId, guidance = '', maxRounds = 3, apply = false } = {}) {
  const { loom, episode } = await requireSource(id, episodeId);
  const sourceFingerprint = fingerprint(loom, episode);
  const status = operationId ? startAIOp({ op: 'fableloom-shots', label: 'Planning timed shots', operationId, localOnly: true, silent: true }) : null;
  const universe = loom.universeId ? await getUniverse(loom.universeId) : null;
  const cast = (universe?.characters || []).map(({ id, name, physicalDescription }) => ({ id, name, physicalDescription }));
  const source = JSON.stringify({ cast, synopsis: episode.synopsis, scenes: episode.nodes.map((node) => ({ id: node.id, title: node.title, prose: node.prose, playbackMode: node.playbackMode, protagonistPresence: node.protagonistPresence, visibleCharacterIds: (node.visualCanon?.characterAppearances || []).map((appearance) => appearance.characterId), challengePhase: node.challengePhase, transitions: node.transitions.map(({ targetNodeId, intent }) => ({ targetNodeId, intent })) })) });
  const route = { returnsJson: true, ...(providerId ? { providerOverride: providerId } : {}), ...(model ? { modelOverride: model } : {}), ...(effort ? { effortOverride: effort } : {}) };
  const execute = (stage, variables) => runStagedLLM(stage, variables, { ...route, source: stage,
    onRunCreated: (runId) => status?.update('running', 'Planning and checking short shots…', { runId }),
    onRunReady: (meta) => status?.update('ready', 'Shot autopilot is running', meta),
  }).catch((error) => { status?.error(error.message); throw error; });
  let feedback = '';
  for (let attempt = 1; attempt <= maxRounds; attempt += 1) {
    const draft = await execute('fableloom-plan-shots', { source, guidance, feedback });
    const parsed = shotGroupsSchema.safeParse(draft.content?.groups);
    if (!parsed.success) { feedback = `Return the required complete groups schema: ${parsed.error.message.slice(0, 3000)}`; continue; }
    const compiled = await Promise.resolve().then(() => compile(loom, episode, parsed.data)).catch((error) => ({ validation: { issues: [{ message: error.message }] } }));
    if (compiled.validation.issues.length) { feedback = compiled.validation.issues.map((i) => i.message).join('\n').slice(0, 5000); continue; }
    const review = await execute('fableloom-review-shots', { source, shots: JSON.stringify(compiled.groups) });
    if (!Array.isArray(review.content?.risks) || !review.content.risks.every((risk) => typeof risk === 'string') || typeof review.content?.summary !== 'string' || !review.content.summary.trim()) {
      feedback = 'The shot reviewer returned no explicit verdict. Provide a clear self-contained episode, preserving the source stakes and consequences.'; continue;
    }
    if (review.content.risks.length) { feedback = review.content.risks.join('\n').slice(0, 5000); continue; }
    const result = { sourceFingerprint, groups: compiled.groups, validation: compiled.validation, review: review.content, attempt };
    const applied = apply ? await applyEpisodeShots(id, episodeId, result) : {};
    status?.complete(apply ? 'Timed shots applied' : 'Shot plan ready to preview', { runId: review.runId, shellReady: false });
    return { ...result, ...applied };
  }
  status?.error('Shot plan still needs revision; existing episode preserved.');
  throw new ServerError(`Shot autopilot reached its ${maxRounds}-round limit. Existing episode preserved.\n${feedback}`, { status: 422, code: 'SHOT_PLAN_INVALID' });
}
