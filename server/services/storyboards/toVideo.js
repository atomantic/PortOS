/**
 * Start a Video from a storyboard: creates a Video (Creative Director) draft
 * linked to the board (`project.storyboardId`) and writes its treatment from
 * the panels (lib/storyboardVideo.js, the plan the drawer previews): one shot
 * per panel with the panel's action as intent and prompt, its seconds up to the
 * shot maximum, and its catalog cast. The draft's length is the shots' total.
 * Nothing renders until the user starts production; no model call.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { storyboardVideoPlan } from '../../lib/storyboardVideo.js';
import { getStoryboard } from './index.js';

export async function startVideoFromStoryboard(boardId, { boardUpdatedAt, project: choices }) {
  const board = await getStoryboard(boardId);
  if (board.updatedAt !== boardUpdatedAt) {
    throw new ServerError('The storyboard changed since these shots were shown. Check them again.', { status: 409, code: 'STORYBOARD_CHANGED' });
  }
  const plan = storyboardVideoPlan(board);
  if (plan.problem) throw new ServerError(plan.problem, { status: 400, code: 'STORYBOARD_VIDEO_UNFIT' });

  const [{ createProject, deleteProject, setTreatment }, { resolveIngredientsByIds }, { buildCastFromIngredients }] = await Promise.all([
    import('../creativeDirector/local.js'), import('../catalogDB.js'), import('../creativeDirector/catalogSeed.js'),
  ]);
  // Only ingredients that still exist become sources; a deleted one would block Start.
  const ingredients = await resolveIngredientsByIds(plan.catalogIds);
  const castById = new Map(buildCastFromIngredients(ingredients).map((member) => [member.ingredientId, member]));
  const picked = choices.videoDraft?.sources || [];
  const catalogIds = [...new Set([...picked.filter((s) => s.kind === 'catalog').map((s) => s.id), ...castById.keys()])].slice(0, 50);
  const total = plan.totalSeconds;
  const project = await createProject({
    ...choices,
    workspace: 'video',
    targetDurationSeconds: total,
    catalogIngredientIds: catalogIds,
    storyboardId: board.id,
    videoDraft: {
      ...choices.videoDraft,
      durationRange: { min: total, max: total },
      sources: [...picked.filter((s) => s.kind !== 'catalog'), ...catalogIds.map((id) => ({ kind: 'catalog', id }))].slice(0, 50),
    },
  });
  const scenes = plan.shots.map((shot) => {
    const cast = shot.catalogIds.map((id) => castById.get(id)).filter(Boolean);
    return {
      sceneId: shot.sceneId, order: shot.order, intent: shot.intent, prompt: shot.prompt,
      durationSeconds: shot.durationSeconds, ...(cast.length ? { cast } : {}),
    };
  });
  const seeded = await setTreatment(project.id, { logline: plan.logline, synopsis: plan.synopsis, script: plan.script, scenes })
    .catch(async (err) => {
      // A draft without its shots would hand the treatment to the director; take it back.
      await deleteProject(project.id).catch((cleanup) => console.error(`❌ Could not remove Video draft ${project.id}: ${cleanup.message}`));
      throw err;
    });
  console.log(`🎬 Video ${project.id} started from storyboard ${board.id}: ${scenes.length} shot(s), ${total}s`);
  return { project: seeded };
}
