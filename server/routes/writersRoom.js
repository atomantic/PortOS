/**
 * Writers Room routes — folder/work CRUD, draft body I/O, version snapshots,
 * exercise sessions. AI analysis + Creative Director handoff land in Phase 2/3.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  writersRoomFolderCreateSchema,
  writersRoomWorkCreateSchema,
  writersRoomWorkUpdateSchema,
  writersRoomDraftSaveSchema,
  writersRoomSnapshotSchema,
  writersRoomExerciseCreateSchema,
  writersRoomExerciseFinishSchema,
  writersRoomAnalysisCreateSchema,
  writersRoomPolishStartSchema,
  writersRoomPolishRevertSchema,
  writersRoomLiveSuggestSchema,
  writersRoomLiveRenderPreviewSchema,
  writersRoomCdBridgeSuggestSchema,
  writersRoomCdBridgeSendSchema,
  writersRoomCharacterCreateSchema,
  writersRoomCharacterUpdateSchema,
  writersRoomPlaceCreateSchema,
  writersRoomPlaceUpdateSchema,
  writersRoomObjectCreateSchema,
  writersRoomObjectUpdateSchema,
} from '../lib/validation.js';
import {
  listFolders, createFolder, deleteFolder,
  listWorks, getWorkWithBody, createWork, updateWork, deleteWork,
  saveDraftBody, snapshotDraft, setActiveDraft, getDraftBody,
  listExercises, createExercise, finishExercise, discardExercise,
} from '../services/writersRoom/local.js';
import {
  runAnalysis, listAnalyses, getAnalysis, persistSceneImage,
} from '../services/writersRoom/evaluator.js';
import {
  startPolish, attachClient as attachPolishClient, isPolishActive, cancelPolish,
  getPolishHistory, revertToSnapshot,
} from '../services/writersRoom/polish.js';
import { getSyncedReview } from '../services/writersRoom/syncedReview.js';
import {
  suggestContinuation, reserveRenderPreview, suggestCdBridge, sendToCreativeDirector,
} from '../services/writersRoom/liveDirector.js';
import {
  listCharacters, createCharacter, updateCharacter, deleteCharacter,
} from '../services/writersRoom/characters.js';
import {
  listPlaces, createPlace, updatePlace, deletePlace,
} from '../services/writersRoom/places.js';
import {
  listObjects, createObject, updateObject, deleteObject,
} from '../services/writersRoom/objects.js';
import { promoteWorkToPipeline, ERR_NO_DRAFT_BODY } from '../services/writersRoom/promoteToPipeline.js';
import { scanProseForIngredientRefs } from '../services/catalogExtraction.js';

const router = Router();

// ---------- folders ----------

router.get('/folders', asyncHandler(async (_req, res) => {
  res.json(await listFolders());
}));

router.post('/folders', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomFolderCreateSchema, req.body);
  res.status(201).json(await createFolder(data));
}));

router.delete('/folders/:id', asyncHandler(async (req, res) => {
  res.json(await deleteFolder(req.params.id));
}));

// ---------- works ----------

router.get('/works', asyncHandler(async (_req, res) => {
  res.json(await listWorks());
}));

router.post('/works', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomWorkCreateSchema, req.body);
  res.status(201).json(await createWork(data));
}));

router.get('/works/:id', asyncHandler(async (req, res) => {
  const { manifest, body } = await getWorkWithBody(req.params.id);
  res.json({ ...manifest, activeDraftBody: body });
}));

router.patch('/works/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomWorkUpdateSchema, req.body);
  res.json(await updateWork(req.params.id, data));
}));

router.delete('/works/:id', asyncHandler(async (req, res) => {
  res.json(await deleteWork(req.params.id));
}));

// ---------- pipeline bridge (item 6 of the WR↔Pipeline DRY unification) ----------

const promoteSchema = z.object({ force: z.boolean().optional() });

router.post('/works/:id/promote-to-pipeline', asyncHandler(async (req, res) => {
  const body = validateRequest(promoteSchema, req.body ?? {});
  const result = await promoteWorkToPipeline(req.params.id, body).catch((err) => {
    if (err?.code === ERR_NO_DRAFT_BODY) {
      throw new ServerError(err.message, { status: 400, code: ERR_NO_DRAFT_BODY });
    }
    throw err;
  });
  res.status(result.reused ? 200 : 201).json(result);
}));

// ---------- draft body / versions ----------

router.put('/works/:id/draft', asyncHandler(async (req, res) => {
  const { body, referencedIngredientIds } = validateRequest(writersRoomDraftSaveSchema, req.body);
  // Capture which catalog ingredients this version references. The client may
  // pass the set explicitly; otherwise derive it by scanning the prose against
  // the cast linked to this work. Best-effort — a catalog DB hiccup must not
  // block a writer from saving prose, so a scan failure falls through to "no
  // refs computed" (omitting the field preserves the prior version's snapshot).
  const refs = Array.isArray(referencedIngredientIds)
    ? referencedIngredientIds
    : await scanProseForIngredientRefs(body, { workId: req.params.id }).catch((err) => {
        console.error(`❌ wr: ingredient-ref scan failed: ${err.message}`);
        return undefined;
      });
  const { manifest, body: persisted } = await saveDraftBody(
    req.params.id, body, { referencedIngredientIds: refs },
  );
  res.json({ ...manifest, activeDraftBody: persisted });
}));

router.post('/works/:id/versions', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomSnapshotSchema, req.body || {});
  res.status(201).json(await snapshotDraft(req.params.id, data));
}));

router.patch('/works/:id/versions/:draftId', asyncHandler(async (req, res) => {
  // Set the active draft pointer AND return the new active body in the same
  // response. This collapses what used to be a PATCH-then-GET round-trip on
  // the client and eliminates the inconsistency window where the server's
  // active pointer had advanced but the client still showed the old body.
  await setActiveDraft(req.params.id, req.params.draftId);
  const { manifest, body } = await getWorkWithBody(req.params.id);
  res.json({ ...manifest, activeDraftBody: body });
}));

router.get('/works/:id/versions/:draftId', asyncHandler(async (req, res) => {
  const body = await getDraftBody(req.params.id, req.params.draftId);
  res.json({ id: req.params.draftId, body });
}));

// ---------- exercises ----------

router.get('/exercises', asyncHandler(async (req, res) => {
  // Coerce ?workId to a single string. Express parses repeated keys as an
  // array; previously we dropped the filter entirely in that case, which
  // turned a filtered request into an unfiltered one (data leakage). Now we
  // pick the first non-empty string and ignore the rest, so a duplicated
  // param degrades to "filter by the first value" instead of "show all".
  const raw = req.query.workId;
  const candidate = Array.isArray(raw) ? raw.find((v) => typeof v === 'string' && v) : raw;
  const workId = typeof candidate === 'string' && candidate ? candidate : undefined;
  res.json(await listExercises({ workId }));
}));

router.post('/exercises', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomExerciseCreateSchema, req.body || {});
  res.status(201).json(await createExercise(data));
}));

router.post('/exercises/:id/finish', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomExerciseFinishSchema, req.body || {});
  res.json(await finishExercise(req.params.id, data));
}));

router.post('/exercises/:id/discard', asyncHandler(async (req, res) => {
  res.json(await discardExercise(req.params.id));
}));

// ---------- analysis ----------

router.get('/works/:id/analysis', asyncHandler(async (req, res) => {
  res.json(await listAnalyses(req.params.id));
}));

router.post('/works/:id/analysis', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomAnalysisCreateSchema, req.body || {});
  const snapshot = await runAnalysis(req.params.id, data);
  res.status(snapshot.status === 'succeeded' ? 201 : 200).json(snapshot);
}));

router.get('/works/:id/analysis/:analysisId', asyncHandler(async (req, res) => {
  res.json(await getAnalysis(req.params.id, req.params.analysisId));
}));

// ---------- polish loop (Phase 9: autonomous cut → revise → keep/revert) ----------

// Start a multi-pass Polish run. USER-TRIGGERED ONLY (explicit action from the
// work page) — satisfies the AI-provider policy: no boot/background invocation.
// Returns { runId, alreadyRunning, sseUrl }; live progress lands via SSE.
router.post('/works/:id/polish', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomPolishStartSchema, req.body || {});
  await getWorkWithBody(req.params.id); // 404 early if the work is missing
  const result = startPolish(req.params.id, data);
  res.status(result.alreadyRunning ? 200 : 202).json({
    ...result,
    sseUrl: `/api/writers-room/works/${encodeURIComponent(req.params.id)}/polish/progress`,
  });
}));

router.get('/works/:id/polish/progress', (req, res) => {
  const attached = attachPolishClient(req.params.id, res);
  if (!attached) {
    throw new ServerError('No active polish run for this work', { status: 404 });
  }
});

router.get('/works/:id/polish/status', (req, res) => {
  res.json({ active: isPolishActive(req.params.id) });
});

router.post('/works/:id/polish/cancel', asyncHandler(async (req, res) => {
  res.json({ canceled: cancelPolish(req.params.id) });
}));

router.get('/works/:id/polish/history', asyncHandler(async (req, res) => {
  res.json(await getPolishHistory(req.params.id));
}));

// Revert the active draft to a prior polish snapshot (pre-polish baseline or any
// kept cycle). Returns the manifest + restored body, same shape as the draft PUT.
router.post('/works/:id/polish/revert', asyncHandler(async (req, res) => {
  const { snapshotId } = validateRequest(writersRoomPolishRevertSchema, req.body || {});
  const { manifest, body } = await revertToSnapshot(req.params.id, snapshotId);
  res.json({ ...manifest, activeDraftBody: body });
}));

// ---------- live continuation (Phase 5: opt-in Creative Director feedback) ----------

// Throttled, opt-in live suggestions from the cursor context. The service
// enforces both the per-work opt-in (409 if off) and the daily budget (429 if
// spent) — the editor debounce is a convenience, not the gate. Stateless apart
// from the daily budget counter the service bumps on a productive call.
router.post('/works/:id/live-suggest', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomLiveSuggestSchema, req.body || {});
  res.json(await suggestContinuation(req.params.id, data));
}));

// Reserve one live render preview against the per-work render budget. The
// client kicks off the actual render via the existing /image-gen route + media
// queue AFTER this succeeds — the service enforces opt-in (409 if off) and the
// daily render budget (429 if spent), distinct from the text-suggest budget.
router.post('/works/:id/live-render-preview', asyncHandler(async (req, res) => {
  validateRequest(writersRoomLiveRenderPreviewSchema, req.body || {});
  res.json(await reserveRenderPreview(req.params.id));
}));

// Propose a Creative Director treatment (logline + synopsis + visual treatment
// + 2–6 filmable scenes) from the cursor context. Draws on the SAME daily
// call budget + opt-in as live-suggest (409 if off, 429 if spent). Returns
// { proposal, usage, budget } — proposal is null when the model couldn't
// produce a usable treatment.
router.post('/works/:id/cd-bridge/suggest', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomCdBridgeSuggestSchema, req.body || {});
  res.json(await suggestCdBridge(req.params.id, data));
}));

// Send a reviewed proposal into a NEW Creative Director project (non-destructive),
// seeding its treatment + styleSpec and recording the bridge link on the work
// manifest. No budget — the proposal was already generated + charged by the
// suggest call. Returns { project }.
router.post('/works/:id/cd-bridge/send', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomCdBridgeSendSchema, req.body || {});
  res.status(201).json(await sendToCreativeDirector(req.params.id, data));
}));

// ---------- synced review (Phase 4: prose ↔ script ↔ media) ----------

// Read-model assembled on demand from the active draft's segment index and the
// `script` analysis snapshot (scenes + scene images). No new persistence — see
// services/writersRoom/syncedReview.js for why this derives rather than stores.
router.get('/works/:id/synced-review', asyncHandler(async (req, res) => {
  res.json(await getSyncedReview(req.params.id));
}));

// ---------- characters ----------

router.get('/works/:id/characters', asyncHandler(async (req, res) => {
  res.json(await listCharacters(req.params.id));
}));

router.post('/works/:id/characters', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomCharacterCreateSchema, req.body || {});
  res.status(201).json(await createCharacter(req.params.id, data));
}));

router.patch('/works/:id/characters/:characterId', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomCharacterUpdateSchema, req.body || {});
  res.json(await updateCharacter(req.params.id, req.params.characterId, data));
}));

router.delete('/works/:id/characters/:characterId', asyncHandler(async (req, res) => {
  res.json(await deleteCharacter(req.params.id, req.params.characterId));
}));

// ---------- places (locations / universe bible) ----------

router.get('/works/:id/places', asyncHandler(async (req, res) => {
  res.json(await listPlaces(req.params.id));
}));

router.post('/works/:id/places', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomPlaceCreateSchema, req.body || {});
  res.status(201).json(await createPlace(req.params.id, data));
}));

router.patch('/works/:id/places/:placeId', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomPlaceUpdateSchema, req.body || {});
  res.json(await updatePlace(req.params.id, req.params.placeId, data));
}));

router.delete('/works/:id/places/:placeId', asyncHandler(async (req, res) => {
  res.json(await deletePlace(req.params.id, req.params.placeId));
}));

// ---------- objects (recurring symbolic items) ----------

router.get('/works/:id/objects', asyncHandler(async (req, res) => {
  res.json(await listObjects(req.params.id));
}));

router.post('/works/:id/objects', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomObjectCreateSchema, req.body || {});
  res.status(201).json(await createObject(req.params.id, data));
}));

router.patch('/works/:id/objects/:objectId', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomObjectUpdateSchema, req.body || {});
  res.json(await updateObject(req.params.id, req.params.objectId, data));
}));

router.delete('/works/:id/objects/:objectId', asyncHandler(async (req, res) => {
  res.json(await deleteObject(req.params.id, req.params.objectId));
}));

// Persist a scene→generated-image link on the analysis snapshot, AND mirror
// the image into the work's auto-collection so it appears in MediaGen's
// Collections view. Retained for the synchronous (external SD-API) render lane,
// which returns its filename inline and never rides the media-job queue the
// `writersRoomSceneImageHook` listens to (#1363); the async local/Codex lanes
// now file durably via that hook instead.
router.post('/works/:id/analysis/:analysisId/scene-image', asyncHandler(async (req, res) => {
  const { sceneId, filename, jobId, prompt } = req.body || {};
  const { analysis, collectionId } = await persistSceneImage(
    req.params.id, req.params.analysisId, { sceneId, filename, jobId, prompt },
  );
  res.json({ analysis, collectionId });
}));

export default router;
