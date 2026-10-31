/**
 * Storyboards routes — boards, beats, panels and panel art takes
 * (Create › Storyboards). Every mutation answers with the whole board so the
 * client applies its own write at once; no list re-fetch.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  storyboardBeatCreateSchema, storyboardBeatUpdateSchema, storyboardCreateSchema, storyboardMoveSchema,
  storyboardMakeEmptySchema, storyboardPanelCorrectSchema, storyboardPanelCreateSchema, storyboardPanelMoveSchema, storyboardPanelNodeUpdateSchema, storyboardPanelUpdateSchema,
  storyboardBeatsAddSchema, storyboardFitSchema, storyboardFromFableLoomSchema, storyboardPipelineUpdateSchema, storyboardVideoStartSchema, storyboardPlotExtractSchema, storyboardRecipeSchema, storyboardSavedRecipeSchema, storyboardTakeCreateSchema, storyboardUpdateSchema,
  storyboardShotSyncAutoSchema, storyboardShotSyncSchema,
} from '../lib/storyboardValidation.js';
import {
  addBeat, addPanel, addPanelTake, createStoryboard, deleteBeat, deletePanel, deleteStoryboard, getStoryboard,
  listStoryboards, moveBeat, movePanel, removePanelTake, selectPanelTake, updateBeat, updatePanel,
  updateStoryboard,
} from '../services/storyboards/index.js';
import {
  correctPanel, drawPanel, getMakeEmptyPlan, getPanelMake, runPanelNode, startMakeEmpty, updatePanelNode, updateRecipe,
} from '../services/storyboards/make.js';
import { fitMusicVideoToStoryboard, groupStoryboardBySong, updateShotFromPanel, sendShotStillToPanel } from '../services/storyboards/fitMusicVideo.js';
import { setMusicVideoShotSync, syncMusicVideoShots } from '../services/storyboards/syncMusicVideo.js';
import { makeStoryboardFromMusicVideo } from '../services/storyboards/fromMusicVideo.js';
import { makeStoryboardFromFableLoom } from '../services/storyboards/fromFableLoom.js';
import { openStoryboardForPipelineIssue, pipelineStoryboardChanges, updatePipelineShotsFromBoard } from '../services/storyboards/fromPipeline.js';
import { sendPanelArtToSource } from '../services/storyboards/sourceArt.js';
import { startVideoFromStoryboard } from '../services/storyboards/toVideo.js';
import { addBeats, extractBeats } from '../services/storyboards/plot.js';
import { deleteSavedRecipe, listSavedRecipes, saveRecipe } from '../services/storyboards/recipeLibrary.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listStoryboards());
}));

router.post('/', asyncHandler(async (req, res) => {
  res.status(201).json(await createStoryboard(validateRequest(storyboardCreateSchema, req.body ?? {})));
}));

// Make storyboard from this video: a board from the project's shots, linked to it.
router.post('/from-music-video/:projectId', asyncHandler(async (req, res) => {
  res.status(201).json(await makeStoryboardFromMusicVideo(req.params.projectId));
}));

// Make storyboard from this FableLoom path; the scene-art panel route sends art back to its source scene.
router.post('/from-fableloom/:loomId/:episodeId', asyncHandler(async (req, res) => {
  const { via } = validateRequest(storyboardFromFableLoomSchema, req.body ?? {});
  res.status(201).json(await makeStoryboardFromFableLoom(req.params.loomId, req.params.episodeId, { via }));
}));

// Open in storyboard editor (Series Pipeline): the issue's linked board, made from its scenes the first time.
router.post('/from-pipeline/:issueId', asyncHandler(async (req, res) => {
  const result = await openStoryboardForPipelineIssue(req.params.issueId);
  res.status(result.created ? 201 : 200).json(result);
}));

// The linked board's edits waiting for the pipeline stage, and Update that copies them to the shots.
router.get('/pipeline/:issueId/changes', asyncHandler(async (req, res) => {
  res.json(await pipelineStoryboardChanges(req.params.issueId));
}));
router.post('/pipeline/:issueId/update-from-board', asyncHandler(async (req, res) => {
  res.json(await updatePipelineShotsFromBoard(req.params.issueId, validateRequest(storyboardPipelineUpdateSchema, req.body ?? {})));
}));

// Fit to song: write the video's shots from its linked board, as previewed.
router.post('/fit-music-video/:projectId', asyncHandler(async (req, res) => {
  res.json(await fitMusicVideoToStoryboard(req.params.projectId, validateRequest(storyboardFitSchema, req.body || {})));
}));

// Sync shots: one shot per panel at the panel's own time, kept 1:1 after each board edit.
router.post('/sync-music-video/:projectId', asyncHandler(async (req, res) => {
  res.json(await syncMusicVideoShots(req.params.projectId, validateRequest(storyboardShotSyncSchema, req.body || {})));
}));
router.put('/sync-music-video/:projectId/auto', asyncHandler(async (req, res) => {
  res.json(await setMusicVideoShotSync(req.params.projectId, validateRequest(storyboardShotSyncAutoSchema, req.body || {}).on));
}));

// Group the linked board's beats by the song's sections (panels unchanged).
router.post('/group-by-song/:projectId', asyncHandler(async (req, res) => {
  res.json(await groupStoryboardBySong(req.params.projectId));
}));

// A fitted shot and its panel: Update takes the edited panel's action; panel art sends the still back.
router.post('/music-video/:projectId/shots/:sceneId/update-from-panel', asyncHandler(async (req, res) => {
  res.json(await updateShotFromPanel(req.params.projectId, req.params.sceneId));
}));
router.post('/music-video/:projectId/shots/:sceneId/panel-art', asyncHandler(async (req, res) => {
  res.json(await sendShotStillToPanel(req.params.projectId, req.params.sceneId));
}));

// The saved recipe library sits before /:id; a board id always starts "sb-".
router.get('/recipes', asyncHandler(async (_req, res) => {
  res.json(await listSavedRecipes());
}));

router.post('/recipes', asyncHandler(async (req, res) => {
  res.status(201).json(await saveRecipe(validateRequest(storyboardSavedRecipeSchema, req.body ?? {})));
}));

router.delete('/recipes/:recipeId', asyncHandler(async (req, res) => {
  res.json(await deleteSavedRecipe(req.params.recipeId));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await getStoryboard(req.params.id));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  res.json(await updateStoryboard(req.params.id, validateRequest(storyboardUpdateSchema, req.body ?? {})));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await deleteStoryboard(req.params.id));
}));

router.post('/:id/video', asyncHandler(async (req, res) => {
  res.status(201).json(await startVideoFromStoryboard(req.params.id, validateRequest(storyboardVideoStartSchema, req.body ?? {})));
}));

router.post('/:id/beats', asyncHandler(async (req, res) => {
  const { index, ...fields } = validateRequest(storyboardBeatCreateSchema, req.body ?? {});
  res.status(201).json(await addBeat(req.params.id, fields, { index }));
}));

router.patch('/:id/beats/:beatId', asyncHandler(async (req, res) => {
  res.json(await updateBeat(req.params.id, req.params.beatId, validateRequest(storyboardBeatUpdateSchema, req.body ?? {})));
}));

router.delete('/:id/beats/:beatId', asyncHandler(async (req, res) => {
  res.json(await deleteBeat(req.params.id, req.params.beatId));
}));

router.post('/:id/beats/:beatId/move', asyncHandler(async (req, res) => {
  const { index } = validateRequest(storyboardMoveSchema, req.body ?? {});
  res.json(await moveBeat(req.params.id, req.params.beatId, index));
}));

router.post('/:id/beats/:beatId/panels', asyncHandler(async (req, res) => {
  const { index, ...fields } = validateRequest(storyboardPanelCreateSchema, req.body ?? {});
  res.status(201).json(await addPanel(req.params.id, req.params.beatId, fields, { index }));
}));

router.patch('/:id/panels/:panelId', asyncHandler(async (req, res) => {
  res.json(await updatePanel(req.params.id, req.params.panelId, validateRequest(storyboardPanelUpdateSchema, req.body ?? {})));
}));

router.delete('/:id/panels/:panelId', asyncHandler(async (req, res) => {
  res.json(await deletePanel(req.params.id, req.params.panelId));
}));

router.post('/:id/panels/:panelId/move', asyncHandler(async (req, res) => {
  res.json(await movePanel(req.params.id, req.params.panelId, validateRequest(storyboardPanelMoveSchema, req.body ?? {})));
}));

router.post('/:id/panels/:panelId/scene-art', asyncHandler(async (req, res) => {
  res.json(await sendPanelArtToSource(req.params.id, req.params.panelId));
}));

router.post('/:id/panels/:panelId/takes', asyncHandler(async (req, res) => {
  res.status(201).json(await addPanelTake(req.params.id, req.params.panelId, validateRequest(storyboardTakeCreateSchema, req.body ?? {})));
}));

router.post('/:id/panels/:panelId/takes/:takeId/select', asyncHandler(async (req, res) => {
  res.json(await selectPanelTake(req.params.id, req.params.panelId, req.params.takeId));
}));

router.delete('/:id/panels/:panelId/takes/:takeId', asyncHandler(async (req, res) => {
  res.json(await removePanelTake(req.params.id, req.params.panelId, req.params.takeId));
}));

// Panel maker (Make tab): the board's recipe, and each node's run for one panel.
router.put('/:id/recipe', asyncHandler(async (req, res) => {
  const { recipe } = validateRequest(storyboardRecipeSchema, req.body ?? {});
  res.json(await updateRecipe(req.params.id, recipe));
}));

router.get('/:id/panels/:panelId/make', asyncHandler(async (req, res) => {
  res.json(await getPanelMake(req.params.id, req.params.panelId));
}));

router.patch('/:id/panels/:panelId/make/:nodeId', asyncHandler(async (req, res) => {
  res.json(await updatePanelNode(req.params.id, req.params.panelId, req.params.nodeId, validateRequest(storyboardPanelNodeUpdateSchema, req.body ?? {})));
}));

// An LLM node answers when its run finishes; an image node answers once its
// frames are queued (storyboard:make follows each frame).
router.post('/:id/panels/:panelId/make/:nodeId/run', asyncHandler(async (req, res) => {
  res.json(await runPanelNode(req.params.id, req.params.panelId, req.params.nodeId));
}));

// Draw a panel: the writer rewrites its prompt, then one frame is queued and
// becomes the panel's art (answers once it's queued).
router.post('/:id/panels/:panelId/draw', asyncHandler(async (req, res) => {
  res.json(await drawPanel(req.params.id, req.params.panelId));
}));

// Correct a frame: the writer redoes its prompt with the note, then the image
// node queues new frames from the marked-up frame (answers once they're queued).
router.post('/:id/panels/:panelId/correct', asyncHandler(async (req, res) => {
  res.json(await correctPanel(req.params.id, req.params.panelId, validateRequest(storyboardPanelCorrectSchema, req.body ?? {})));
}));

// Beats from a plot summary: extract answers with a preview (the board only
// keeps the plot and LLM pick); add appends the beats the user keeps.
router.post('/:id/beats/extract', asyncHandler(async (req, res) => {
  res.json(await extractBeats(req.params.id, validateRequest(storyboardPlotExtractSchema, req.body ?? {})));
}));

router.post('/:id/beats/add', asyncHandler(async (req, res) => {
  res.json(await addBeats(req.params.id, validateRequest(storyboardBeatsAddSchema, req.body ?? {}).beats));
}));

// Make empty panels: GET names what a run would do (panels, nodes, models);
// POST starts it and answers at once, with storyboard:make-batch after.
router.get('/:id/make-empty', asyncHandler(async (req, res) => {
  res.json(await getMakeEmptyPlan(req.params.id));
}));

router.post('/:id/make-empty', asyncHandler(async (req, res) => {
  res.status(202).json(await startMakeEmpty(req.params.id, validateRequest(storyboardMakeEmptySchema, req.body ?? {})));
}));

export default router;
