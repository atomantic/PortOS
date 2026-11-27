import { musicVideoBlenderMediaUrl } from '../../services/apiMusicVideo.js';
import { normalizeImage, normalizeVideo } from '../media/normalize.js';
import { castAndSetsPreviewItems } from './CastAndSetsReferenceProgress.jsx';
import { videoPosterForJob } from '../../lib/creativeDirectorPreview.js';
import { sceneTakeList } from '../../lib/musicVideoTakes.js';
import { blenderStillPreviewItems } from '../../lib/musicVideoBlender.js';

// Shared lightbox: final render first (it sits above the board), then each
// scene's frame then clip in board order. Built through media/normalize so
// keys use the canonical `image:<filename>` / `video:<historyId>` shape —
// the lightbox's always-mounted Add-to-collection / Pin-to-moodboard menus
// then get a real `id`/`filename` ref (same vocabulary as Media History's
// ?preview=), and the lineage fields survive.
//
// The prompts here are the board's LABELS: `useMusicVideoSceneMedia` suffixes
// `project.concept.style` onto both the frame and the shot prompt on the way
// out, and the final render has no prompt of its own at all. They stand in
// until `useHydratedPreviewRoute` reads the real one back on open.
export default function buildMusicVideoPreviewItems(selected, finalVideoSrc, blenderState) {
  if (!selected) return [];
  const items = [];
  // `generateThumbnail` always writes `<jobId>.jpg`, which the history record
  // only names once hydrated — keep the job-scoped poster so the card has one
  // on first paint.
  const videoItem = (id, filename, prompt) => ({
    ...normalizeVideo({ id, filename, prompt }),
    previewUrl: videoPosterForJob(id),
  });
  if (selected.renderHistoryId && finalVideoSrc) {
    items.push(videoItem(
      selected.renderHistoryId,
      finalVideoSrc.split('/').pop() || selected.renderHistoryId,
      `Music Video: ${selected.name}`,
    ));
  }
  // Every take (#8965), start and end frames included, selected first, so the take strips and contact sheet
  // can open any candidate in the shared lightbox.
  for (const scene of selected.scenes || []) {
    const frames = sceneTakeList(scene, 'image')
      .sort((a, b) => (b.assetId === scene.referenceImageId) - (a.assetId === scene.referenceImageId));
    for (const take of frames) {
      items.push(normalizeImage({ filename: take.assetId, prompt: take.prompt || scene.framePrompt || scene.prompt || '' }));
    }
    const endFrames = sceneTakeList(scene, 'endImage')
      .sort((a, b) => (b.assetId === scene.endImageId) - (a.assetId === scene.endImageId));
    for (const take of endFrames) {
      items.push(normalizeImage({ filename: take.assetId, prompt: take.prompt || scene.endFramePrompt || scene.prompt || '' }));
    }
    const clips = sceneTakeList(scene, 'video')
      .sort((a, b) => (b.assetId === scene.videoHistoryId) - (a.assetId === scene.videoHistoryId));
    for (const take of clips) {
      items.push(videoItem(take.assetId, `${take.assetId}.mp4`, take.prompt || scene.prompt || ''));
    }
  }
  // Cast & sets references and their inputs open here too, never as a raw file.
  items.push(...castAndSetsPreviewItems(selected.castAndSets));
  // A Blender film's stills are workspace files, served by the film's media route.
  if (blenderState) items.push(...blenderStillPreviewItems(blenderState, (path) => musicVideoBlenderMediaUrl(selected.id, path)));
  // Scenes can reuse the same frame/clip (Make's generation controls surface a
  // "Repetition: N unique frames" badge). Dedupe by key so prev/next and
  // openPreview's .find() land on a single item rather than the first of
  // several identical keys with different prompts.
  return [...new Map(items.map((i) => [i.key, i])).values()];
}
