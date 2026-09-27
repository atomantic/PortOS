import { useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  addMusicVideoSceneTake,
  selectMusicVideoSceneTake,
  reviewMusicVideoSceneTake,
  getMusicVideoHandoff,
  getMusicVideoHandoffBundle,
  importMusicVideoHandoff,
} from '../services/apiMusicVideo.js';
import { uploadGalleryImage } from '../services/apiSystem.js';
import { uploadGalleryVideo } from '../services/apiImageVideo.js';
import { downloadBlob } from '../lib/downloadBlob.js';
import { readFileAsBase64, validateImageFile, JSON_UPLOAD_MAX_FILE_SIZE } from '../utils/fileUpload.js';
import { formatBytes } from '../utils/formatters.js';

// Mirrors the server's handoff import cap, checked BEFORE uploading so an
// oversized pick can't leave a gallery full of files nothing imported.
const MAX_HANDOFF_FILES = 200;
// The video formats the gallery video upload can container-sniff.
const HANDOFF_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

// Why a picked file can't be uploaded, or null. Both uploads are one base64
// JSON body, so both share the wire cap.
function handoffFileProblem(file, isVideo) {
  if (!isVideo) return validateImageFile(file, JSON_UPLOAD_MAX_FILE_SIZE);
  if (!HANDOFF_VIDEO_TYPES.has(file.type)) return `File "${file.name}" is not an MP4, MOV, or WebM video`;
  if (file.size > JSON_UPLOAD_MAX_FILE_SIZE) return `File "${file.name}" exceeds the ${formatBytes(JSON_UPLOAD_MAX_FILE_SIZE)} limit`;
  return null;
}

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
 * order, or the older response could overwrite the newer take list locally.
 *
 * Handoff import uploads each picked file through the ordinary gallery upload
 * routes (image → data/images, video → video history), then asks the server to
 * associate them with scenes by the file tags the exported manifest assigned.
 */
export default function useMusicVideoTakes({ project, applyScenePatch }) {
  const [busy, setBusy] = useState(false);
  const chainRef = useRef(Promise.resolve());

  const applyScene = (projectId, scene) => applyScenePatch?.(projectId, scene.sceneId, {
    referenceImageId: scene.referenceImageId ?? null,
    videoHistoryId: scene.videoHistoryId ?? null,
    takes: scene.takes || [],
  });

  // Serialize take mutations; a failure toasts and leaves the chain usable.
  const runTakeOp = (work, failMessage) => {
    const projectId = project.id;
    const run = chainRef.current.then(() => work(projectId));
    chainRef.current = run.then((scene) => { if (scene) applyScene(projectId, scene); })
      .catch((err) => toast.error(err?.message || failMessage));
    return chainRef.current;
  };

  const selectTake = (scene, take) => runTakeOp(
    (projectId) => selectMusicVideoSceneTake(projectId, scene.sceneId, take.takeId, { silent: true }),
    'Failed to select take',
  );

  const reviewTake = (scene, take, review) => runTakeOp(
    (projectId) => reviewMusicVideoSceneTake(projectId, scene.sceneId, take.takeId, review, { silent: true }),
    'Failed to update take',
  );

  // A frame picked from (or uploaded into) the gallery for one scene.
  const importTake = (scene, item) => runTakeOp(
    (projectId) => addMusicVideoSceneTake(projectId, scene.sceneId, {
      kind: 'image', assetId: item.filename, source: 'imported',
    }, { silent: true }).then((res) => res.scene),
    'Failed to import take',
  );

  // A clip picked from the video-history gallery for one scene (#8978). Same
  // append-only contract as importTake: it fills the scene's video slot only
  // while empty (appendSceneTakes), never replacing an existing selection.
  const importClipTake = (scene, item) => runTakeOp(
    (projectId) => addMusicVideoSceneTake(projectId, scene.sceneId, {
      kind: 'video', assetId: item.id, source: 'imported',
    }, { silent: true }).then((res) => res.scene),
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
      const base64 = await readFileAsBase64(file).catch(() => null);
      if (!base64) { failures.push(`Failed to read ${file.name}`); continue; }
      // Sequential on purpose: each upload is a whole file in one JSON body.
      const saved = await (isVideo
        ? uploadGalleryVideo(base64, file.name, { silent: true })
        : uploadGalleryImage(base64, { silent: true })
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

  return { busy, selectTake, reviewTake, importTake, importClipTake, exportHandoff, exportHandoffBundle, importHandoffFiles };
}
