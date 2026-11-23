/**
 * Hook for Music Video scene-take review and external asset handoff: select, reject, note, gallery
 * import, manifest download and handoff import.
 *
 * Scene-take review + external-asset handoff for the Music Video board (#8965): serialized select /
 * reject / note / gallery-import take mutations folded back as scene patches, the handoff manifest
 * download, and the handoff import (gallery upload per file, then scene association by file tag with
 * provider provenance). Returns `{ busy, pending, selectTake, reviewTake, importTake, exportHandoff,
 * importHandoffFiles }`. Use when: The Music Video board's take strips, contact sheet and handoff row
 * — don't re-sequence take mutations per call site.
 */

import { useRef, useState } from 'react';
import toast from '../../ui/Toast';
import {
  addMusicVideoSceneTake,
  selectMusicVideoSceneTake,
  placeMusicVideoPoolItem,
  continueMusicVideoSceneFromPrevious,
  reviewMusicVideoSceneTake,
  checkMusicVideoSceneTake,
  rejectUnusedMusicVideoSceneTakes,
  swapMusicVideoSceneFrames,
  markMusicVideoPoolAssets,
  getMusicVideoHandoff,
  getMusicVideoProject,
  getMusicVideoHandoffBundle,
  importMusicVideoHandoff,
} from '../../../services/apiMusicVideo.js';
import { uploadGalleryImage } from '../../../services/apiSystem.js';
import { ownWrite } from '../../../services/socketWriteOrigin.js';
import { selectTakePatch, reviewTakePatch, markTakeAssetMarks, takeControl, reviewTakeControl } from '../../../lib/musicVideoTakes.js';
import { handheldVideo, trimVideo, uploadGalleryVideo } from '../../../services/apiImageVideo.js';
import { downloadBlob } from '../../../lib/downloadBlob.js';
import { validateImageFile } from '../../../utils/fileUpload.js';

// Mirrors the server's handoff import cap, checked BEFORE uploading so an
// oversized pick can't leave a gallery full of files nothing imported.
const MAX_HANDOFF_FILES = 200;
// The video formats the gallery video upload can container-sniff.
const HANDOFF_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

// Why a picked file can't be uploaded, or null.
function handoffFileProblem(file, isVideo) {
  if (!isVideo) return validateImageFile(file, Infinity);
  if (!HANDOFF_VIDEO_TYPES.has(file.type)) return `File "${file.name}" is not an MP4, MOV, or WebM video`;
  return null;
}

// The queue key for project-wide mark decisions, beside the per-shot ones.
const MARKS_QUEUE = 'asset-marks';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const handoffSlug = (name) => String(name || 'music-video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'music-video';
const handoffFilename = (name) => `${handoffSlug(name)}-handoff.json`;
const handoffBundleFilename = (name) => `${handoffSlug(name)}-handoff.zip`;

/**
 * Scene-take review + external-asset handoff actions for the Music Video board
 * (#8965). Every mutation resolves to the server's updated scene, which is
 * folded back through `applyScenePatch` (selection fields + take list only), so
 * a take action never clobbers a scene prompt the director is still editing.
 * Take mutations run one at a time: a Reject followed by its note must land in
 * order. Use, Reject/Restore and Bad apply their change locally at once; a reply
 * is folded in only when no later decision on that shot is still queued (that
 * one's reply is fresher), and a refused one reloads the project. Each request
 * names this tab's socket, so the broadcast of its own change is not refetched.
 * `writeMark()` / `settledSince(mark)` let a board edit tell whether a take decision started or is
 * still running while it was in flight: then its reply may predate that decision, and it reloads.
 *
 * Handoff import uploads each picked file through the ordinary gallery upload
 * routes (image → data/images, video → video history), then asks the server to
 * associate them with scenes by the file tags the exported manifest assigned.
 */
export default function useMusicVideoTakes({ project, applyScenePatch, patchProject = null, reloadProject = null, applyEdit = null }) {
  const [busy, setBusy] = useState(false);
  const chainRef = useRef(Promise.resolve());
  const [reconcileError, setReconcileError] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const reconcileGeneration = useRef(0);
  // Queued decisions per shot: an earlier reply must not undo a later optimistic change.
  const queuedRef = useRef(new Map());
  const queue = (sceneId, by) => {
    if (!sceneId) return;
    const left = (queuedRef.current.get(sceneId) || 0) + by;
    if (left > 0) queuedRef.current.set(sceneId, left);
    else queuedRef.current.delete(sceneId);
  };
  // This tab's own writes: the server names it on the change broadcast, so the page skips that refetch.
  const own = () => ownWrite();
  // Every take decision started, and those not yet answered (see writeMark / settledSince).
  const startedRef = useRef(0);
  const runningRef = useRef(0);

  const applyScene = (projectId, scene) => !queuedRef.current.has(scene.sceneId) && applyScenePatch?.(projectId, scene.sceneId, {
    referenceImageId: scene.referenceImageId ?? null,
    videoHistoryId: scene.videoHistoryId ?? null,
    endImageId: scene.endImageId ?? null,
    takes: scene.takes || [],
  });

  // The take controls waiting on a reply, by `control` key (`pendingKey`): the pressed control shows it is
  // saving, and pressing it again before the reply sends nothing (#16306). The ref answers a double click
  // that lands before React renders the disabled control.
  const [pending, setPending] = useState(() => new Set());
  const pendingRef = useRef(new Set());
  const settlePending = (control) => {
    if (!control) return;
    pendingRef.current.delete(control);
    setPending(new Set(pendingRef.current));
  };

  // Serialize take mutations; a failure toasts and leaves the chain usable.
  // `optimistic(projectId)` applies the change before the request; a refusal then reloads the project.
  // Resolves true when the change landed, false when it was refused or `control` was already waiting.
  const runTakeOp = (work, failMessage, { sceneId = null, optimistic = null, control = null } = {}) => {
    const projectId = project.id;
    if (control) {
      if (pendingRef.current.has(control)) return Promise.resolve(false);
      pendingRef.current.add(control);
      setPending(new Set(pendingRef.current));
    }
    queue(sceneId, 1);
    startedRef.current += 1;
    runningRef.current += 1;
    optimistic?.(projectId);
    const run = chainRef.current.then(() => work(projectId));
    chainRef.current = run.then((scene) => {
      // A reply that carries the edit result also corrects readiness and the neighbours' take staleness. Its
      // copy of the shots predates any decision still queued behind this one, so then only this shot is patched.
      const alone = runningRef.current === 1;
      runningRef.current -= 1;
      queue(sceneId, -1);
      if (scene?.edit && applyEdit && alone) applyEdit(projectId, scene.edit);
      else if (scene) applyScene(projectId, scene);
      settlePending(control);
      return true;
    })
      .catch((err) => {
        runningRef.current -= 1;
        queue(sceneId, -1);
        settlePending(control);
        toast.error(err?.message || failMessage);
        // Back to the saved record, read once the decisions queued behind this one land.
        // `reloadProject(fresh)` applies it (the page keeps shot text typed and not yet saved).
        if (optimistic && reloadProject) {
          void reconcileProject(projectId);
        }
        return false;
      });
    return chainRef.current;
  };

  // Run `read` once no take decision is queued, and again if one starts while it reads,
  // so a refetch for someone else's change never lands over an optimistic one.
  const afterTakeWrites = async (read) => {
    for (;;) {
      const tail = chainRef.current;
      await tail;
      const result = await read();
      if (tail === chainRef.current) return result;
    }
  };

  // A refused optimistic edit stays explicitly unconfirmed until a saved read
  // succeeds. Retry waits behind later queued decisions before replacing state.
  const reconcileProject = async (projectId) => {
    const generation = ++reconcileGeneration.current;
    setReconciling(true);
    try {
      const saved = await afterTakeWrites(() => getMusicVideoProject(projectId, { silent: true }));
      if (generation !== reconcileGeneration.current) return false;
      reloadProject?.(saved);
      setReconcileError(null);
      return true;
    } catch (err) {
      if (generation === reconcileGeneration.current) setReconcileError({ projectId, message: err?.message || 'Could not load the saved take decisions' });
      return false;
    } finally {
      if (generation === reconcileGeneration.current) setReconciling(false);
    }
  };

  const selectTake = (scene, take) => runTakeOp(
    (projectId) => selectMusicVideoSceneTake(projectId, scene.sceneId, take.takeId, own()),
    'Failed to select take',
    { sceneId: scene.sceneId, control: takeControl.select(scene, take), optimistic: (projectId) => applyScenePatch?.(projectId, scene.sceneId, (current) => selectTakePatch(current, take)) },
  );

  // An unused still or clip from the project's pool becomes this shot's selection (with its partner, when picked).
  // The still's frame prompt comes with it, so the start or end prompt shows what made the picture.
  // Its reply carries the edit result: the placed shot, any shot whose takes went stale, and readiness.
  const placePoolItem = (scene, pick) => runTakeOp(
    (projectId) => placeMusicVideoPoolItem(projectId, scene.sceneId, pick, applyEdit ? own() : { silent: true }).then(({ scene: placed, edit }) => {
      // Only when no other take decision is queued: one behind it would be painted over by this reply's
      // copy of its shot, which predates it. Otherwise patch the shot as the other take decisions do.
      if (applyEdit && edit && runningRef.current === 1) { applyEdit(projectId, edit); return null; }
      const field = pick.kind === 'endImage' ? 'endFramePrompt' : 'framePrompt';
      const stillPlaced = pick.kind !== 'video' || Boolean(pick.withAssetId);
      if (stillPlaced && placed[field] !== scene[field]) applyScenePatch?.(projectId, placed.sceneId, { [field]: placed[field] ?? null });
      return placed;
    }),
    'Failed to use that take',
  );

  // "Start/End clip here": a frame range (`{ startSec }` or `{ endSec }`) of the shot's clip becomes a new clip take, and the selected one.
  // It keeps the cut clip's still and provider, so a still change still marks it stale and the pool pairs it.
  const clipProvenance = (scene) => {
    const origin = scene.takes?.find((take) => take.kind === 'video' && take.assetId === scene.videoHistoryId);
    return {
      ...(origin?.sourceImageId ? { sourceImageId: origin.sourceImageId } : {}),
      // Only a slug the take route accepts; an older free-form label is left off rather than failing the trim.
      ...(/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(origin?.provider || '') ? { provider: origin.provider } : {}),
    };
  };
  // A derived copy of the shot's clip (`make` resolves to the new gallery video) becomes a new clip take, and the selected one.
  // Two writes, so each reply's edit result is applied in turn: the select's diff starts from the revision the add left.
  const deriveClipTake = (scene, make, source, failMessage) => {
    const provenance = clipProvenance(scene);
    return runTakeOp(
      (projectId) => make(scene.videoHistoryId)
        .then(({ video }) => addMusicVideoSceneTake(projectId, scene.sceneId, { kind: 'video', assetId: video.id, source, ...provenance }, own()))
        .then(({ take, edit }) => {
          if (edit && applyEdit && runningRef.current === 1) applyEdit(projectId, edit);
          return selectMusicVideoSceneTake(projectId, scene.sceneId, take.takeId, own());
        }),
      failMessage,
    );
  };
  const trimClipTake = (scene, range) => deriveClipTake(scene, (id) => trimVideo(id, range, { silent: true }), 'trimmed', 'Failed to trim the clip');
  // Handheld camera (`{ shake, steps, seed }`): the clip re-shot as if held by a walking operator.
  const handheldClipTake = (scene, settings) => deriveClipTake(scene, (id) => handheldVideo(id, settings, { silent: true }), 'handheld', 'Failed to add the handheld camera');

  // Continuing shot: the previous shot's last on-screen frame becomes this
  // scene's start frame; `keepStillAsEnd` keeps the current one as its end frame.
  const continueFromPrevious = (scene, { keepStillAsEnd = false } = {}) => runTakeOp(
    (projectId) => continueMusicVideoSceneFromPrevious(projectId, scene.sceneId, { keepStillAsEnd }, own()).then(({ scene: started, edit }) => ({ ...started, edit })),
    'Failed to continue from the previous shot',
  );

  // A render-quality acknowledgement, frame confirmation or character-reference acceptance is checked by the server,
  // so only status and note go first.
  const reviewTake = (scene, take, review) => runTakeOp(
    (projectId) => reviewMusicVideoSceneTake(projectId, scene.sceneId, take.takeId, review, own()),
    'Failed to update take',
    review.acknowledgeRenderQuality || review.confirmFrame || review.acceptCharacterReferences ? { control: reviewTakeControl(scene, take, review) } : {
      sceneId: scene.sceneId,
      control: reviewTakeControl(scene, take, review),
      optimistic: (projectId) => applyScenePatch?.(projectId, scene.sceneId, (current) => reviewTakePatch(current, take, review)),
    },
  );

  // A vision check can take minutes, so it stays off the serialized chain; its answer is the scene as saved after it.
  const [checking, setChecking] = useState(() => new Set());
  // Its reply carries the edit result, applied unless a take decision started while the check ran: its optimistic
  // change is not in the reply's copy of the shot, so then only the take list is patched, as before.
  const checkTake = (scene, take) => {
    const projectId = project.id;
    const mark = startedRef.current;
    setChecking((prev) => new Set(prev).add(take.takeId));
    return checkMusicVideoSceneTake(projectId, scene.sceneId, take.takeId, own())
      .then(({ edit, ...saved }) => {
        if (edit && applyEdit && settledSince(mark)) applyEdit(projectId, edit);
        else applyScene(projectId, saved);
        return true;
      })
      .catch((err) => { toast.error(err?.message || 'Failed to check the frame'); return false; })
      .finally(() => setChecking((prev) => { const next = new Set(prev); next.delete(take.takeId); return next; }));
  };

  // Mark a take's file bad (or clear it): a project-wide mark, separate from rejecting it from this shot.
  // A mark's answer: the project's marks, and the shots whose takes a Bad mark rejected.
  const applyPoolMarks = (projectId, { assetMarks, scenes = [] } = {}) => {
    if (assetMarks) patchProject?.(projectId, { assetMarks });
    for (const scene of scenes) applyScene(projectId, scene);
  };

  // The mark shows at once; which takes it rejects and what each shot falls back to comes with the reply.
  const markTake = (take, mark) => runTakeOp(
    (projectId) => markMusicVideoPoolAssets(projectId, [{ kind: take.kind === 'video' ? 'video' : 'image', assetId: take.assetId }], mark, own())
      .then((result) => {
        // A later mark still queued answers with fresher marks; this reply keeps only its shots.
        const later = (queuedRef.current.get(MARKS_QUEUE) || 0) > 1;
        if (result.edit && applyEdit && runningRef.current === 1) { applyEdit(projectId, result.edit); return null; }
        applyPoolMarks(projectId, later ? { scenes: result.scenes } : result);
        return null;
      }),
    'Failed to mark the take',
    { sceneId: MARKS_QUEUE, control: takeControl.mark(take), optimistic: patchProject && ((projectId) => patchProject(projectId, (current) => ({ assetMarks: markTakeAssetMarks(current.assetMarks, take, mark) }))) },
  );

  // Start and end frames trade places, each bringing its prompt along.
  const swapFrames = (scene) => runTakeOp(
    (projectId) => swapMusicVideoSceneFrames(projectId, scene.sceneId, own()).then((placed) => {
      applyScenePatch?.(projectId, placed.sceneId, { framePrompt: placed.framePrompt ?? null, endFramePrompt: placed.endFramePrompt ?? null });
      return placed;
    }),
    'Failed to swap the frames',
  );

  // Finalize a shot: every take other than its selected frame, end frame and clip is rejected (files kept).
  const rejectUnusedTakes = (scene) => runTakeOp(
    (projectId) => rejectUnusedMusicVideoSceneTakes(projectId, scene.sceneId, own())
      // The reply's edit result rides on the scene, as every other take decision's does: without it the page keeps the
      // pre-decision revision and a later shot edit's reply is diffed against a record this tab never advanced to.
      .then(({ scene: rejected, edit }) => (edit ? { ...rejected, edit } : rejected)),
    'Failed to reject the unused takes',
    { control: takeControl.rejectUnused(scene) },
  );

  // A frame picked from (or uploaded into) the gallery for one scene.
  const importTake = (scene, item) => runTakeOp(
    (projectId) => addMusicVideoSceneTake(projectId, scene.sceneId, {
      kind: 'image', assetId: item.filename, source: 'imported',
    }, own()).then(({ scene: imported, edit }) => ({ ...imported, edit })),
    'Failed to import take',
  );

  // A clip picked from the video-history gallery for one scene (#8978). Same
  // append-only contract as importTake: it fills the scene's video slot only
  // while empty (appendSceneTakes), never replacing an existing selection.
  const importClipTake = (scene, item) => runTakeOp(
    (projectId) => addMusicVideoSceneTake(projectId, scene.sceneId, {
      kind: 'video', assetId: item.id, source: 'imported',
    }, own()).then(({ scene: imported, edit }) => ({ ...imported, edit })),
    'Failed to import clip take',
  );

  const exportHandoff = () => getMusicVideoHandoff(project.id, { silent: true })
    .then((manifest) => {
      downloadBlob(JSON.stringify(manifest, null, 2), handoffFilename(project.name), 'application/json');
      toast.success(`Exported prompts for ${plural(manifest.scenes.length, 'scene')}`);
    })
    .catch((err) => toast.error(err?.message || 'Handoff export failed'));

  // Downloadable ZIP counterpart (#8978): manifest.json plus every reference
  // image and each scene's selected frame, so nothing has to be saved out of
  // the gallery by hand before attaching it in the external tool.
  const exportHandoffBundle = () => getMusicVideoHandoffBundle(project.id, { silent: true })
    .then((buffer) => {
      downloadBlob(buffer, handoffBundleFilename(project.name), 'application/zip');
      toast.success('Exported handoff bundle');
    })
    .catch((err) => toast.error(err?.message || 'Handoff bundle export failed'));

  const importHandoffFiles = async (files, provider) => {
    if (!files.length) return;
    if (files.length > MAX_HANDOFF_FILES) {
      toast.error(`Import at most ${MAX_HANDOFF_FILES} files at a time (picked ${files.length})`);
      return;
    }
    const projectId = project.id;
    setBusy(true);
    const items = [];
    const failures = [];
    for (const file of files) {
      const isVideo = typeof file.type === 'string' && file.type.startsWith('video/');
      const invalid = handoffFileProblem(file, isVideo);
      if (invalid) { failures.push(invalid); continue; }
      // Sequential uploads keep disk and decode work bounded.
      const saved = await (isVideo
        ? uploadGalleryVideo(file, file.name, { silent: true })
        : uploadGalleryImage(file, { silent: true })
      ).catch((err) => { failures.push(`${file.name}: ${err?.message || 'upload failed'}`); return null; });
      const assetId = isVideo ? saved?.id : saved?.filename;
      if (assetId) items.push({ kind: isVideo ? 'video' : 'image', assetId, originalName: file.name });
    }
    if (items.length) {
      await importMusicVideoHandoff(projectId, { provider, items }, { silent: true })
        .then(({ project: next, imported, skipped }) => {
          const touched = new Set(imported.map((i) => i.sceneId));
          for (const scene of next.scenes || []) if (touched.has(scene.sceneId)) applyScene(projectId, scene);
          if (imported.length) toast.success(`Imported ${plural(imported.length, 'take')} from ${provider}`);
          if (skipped.length) {
            toast.error(`${plural(skipped.length, 'file')} matched no scene tag — they're in the gallery; use "Import take" on a scene to place them`);
          }
        })
        .catch((err) => failures.push(err?.message || 'Handoff import failed'));
    }
    setBusy(false);
    if (failures.length) toast.error(failures.slice(0, 3).join(' · '));
  };

  const writeMark = () => startedRef.current;
  const settledSince = (mark) => startedRef.current === mark && runningRef.current === 0;

  return { busy, pending, writeMark, settledSince, reconcileError: reconcileError?.projectId === project.id ? reconcileError : null, reconciling, retryReconcile: () => reconcileProject(project.id), afterTakeWrites, selectTake, placePoolItem, trimClipTake, handheldClipTake, reviewTake, checkTake, checking, rejectUnusedTakes, swapFrames, markTake, applyPoolMarks, continueFromPrevious, importTake, importClipTake, exportHandoff, exportHandoffBundle, importHandoffFiles };
}
