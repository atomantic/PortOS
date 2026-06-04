/**
 * Writers Room — Phase 4 synchronized prose/script/media review surface.
 *
 * This is a *read-model*: it derives the prose↔script↔media mapping from data
 * that already exists immutably elsewhere rather than persisting a fourth copy.
 *   - prose segments  ← the active draft's `segmentIndex` (built on every save)
 *   - script scenes   ← the `script` analysis snapshot's `result.scenes[]`,
 *                       each carrying `sourceSegmentIds` back to prose
 *   - media refs      ← the same snapshot's `sceneImages` map (scene → image)
 *
 * Deriving on read (instead of a persisted render-plan store) means there is no
 * second source of truth to keep in sync, and staleness falls straight out of
 * the analysis snapshot's pinned `sourceContentHash` vs. the live draft hash —
 * the same contentHash machinery the rest of Writers Room already uses.
 *
 * The mapping model from docs/features/writers-room.md ("Synchronized Review
 * Surface") is expressed *relationally* across the three pane arrays — every
 * prose segment lists the script scenes mapped to it; every scene lists the
 * prose segments it adapts and the media rendered from it; every media item
 * carries its full provenance back to scene + prose. There is intentionally no
 * separate `mappings[]` array — that would be a redundant denormalization of
 * exactly these cross-references.
 */

import { getWorkWithBody } from './local.js';
import { getAnalysis } from './evaluator.js';
import { assertValidWorkId } from './_shared.js';

const SCRIPT_ANALYSIS_ID = 'script';

// Pull the active draft's metadata (contentHash, segmentIndex) out of the
// manifest. Returns a stable empty shape when there's no active draft yet so
// callers never have to null-check the index.
function activeDraftMeta(manifest) {
  const activeId = manifest?.activeDraftVersionId || null;
  const draft = (manifest?.drafts || []).find((d) => d.id === activeId) || null;
  return {
    draftVersionId: activeId,
    contentHash: draft?.contentHash || null,
    segmentIndex: Array.isArray(draft?.segmentIndex) ? draft.segmentIndex : [],
  };
}

// One media item per rendered scene image. Provenance points back to the scene
// it was rendered from and (transitively) the prose segments that scene adapts.
// An image whose `sceneId` no longer matches any scene (the script was
// re-extracted with different ids after the render) is surfaced as an orphan —
// honest "source scene no longer in script" rather than silently dropped.
function buildMediaItem(sceneId, img, sceneById) {
  const scene = sceneById.get(sceneId) || null;
  return {
    sceneId,
    sceneHeading: scene?.heading || null,
    orphan: !scene,
    kind: 'image',
    ref: img.filename,
    jobId: img.jobId || null,
    prompt: img.prompt || null,
    generatedAt: img.generatedAt || null,
    proseSegmentIds: scene ? scene.proseSegmentIds : [],
  };
}

/**
 * Pure assembler — no I/O. Given the work manifest, the active draft body, and
 * the (possibly absent / failed) `script` analysis snapshot, produce the full
 * synced-review payload. Kept pure so the mapping logic is unit-testable
 * without touching the filesystem.
 */
export function buildSyncedReview({ manifest, body = '', scriptAnalysis = null }) {
  const { draftVersionId, contentHash, segmentIndex } = activeDraftMeta(manifest);
  const text = String(body || '');

  // Prose segments with their sliced text. Offsets come from the segment index
  // computed at save time, so they line up with the persisted body.
  const proseSegments = segmentIndex.map((seg) => ({
    id: seg.id,
    kind: seg.kind,
    heading: seg.heading,
    start: seg.start,
    end: seg.end,
    wordCount: seg.wordCount,
    text: text.slice(seg.start, seg.end).trim(),
    // filled in below once we know which scenes map back to each segment
    scriptSceneIds: [],
    media: [],
  }));
  const proseSegmentIds = new Set(proseSegments.map((s) => s.id));
  const proseById = new Map(proseSegments.map((s) => [s.id, s]));

  const rawScenes = Array.isArray(scriptAnalysis?.result?.scenes)
    ? scriptAnalysis.result.scenes
    : [];
  const sceneImages = scriptAnalysis?.sceneImages && typeof scriptAnalysis.sceneImages === 'object'
    ? scriptAnalysis.sceneImages
    : {};

  // Script scenes. `sourceSegmentIds` from the LLM is validated against the
  // live prose index — hallucinated or stale segment refs are dropped so a
  // mapping never points at a segment that isn't on screen.
  const scenes = rawScenes.map((s) => {
    const validProseIds = (Array.isArray(s.sourceSegmentIds) ? s.sourceSegmentIds : [])
      .filter((id) => proseSegmentIds.has(id));
    const img = sceneImages[s.id];
    return {
      id: s.id,
      heading: s.heading || null,
      slugline: s.slugline || null,
      summary: s.summary || null,
      characters: Array.isArray(s.characters) ? s.characters : [],
      proseSegmentIds: validProseIds,
      media: img?.filename
        ? { kind: 'image', ref: img.filename, jobId: img.jobId || null, prompt: img.prompt || null, generatedAt: img.generatedAt || null }
        : null,
    };
  });
  const sceneById = new Map(scenes.map((s) => [s.id, s]));

  // Back-fill prose → scene and prose → media from the validated scene mappings.
  for (const scene of scenes) {
    for (const segId of scene.proseSegmentIds) {
      const seg = proseById.get(segId);
      if (!seg) continue;
      seg.scriptSceneIds.push(scene.id);
      if (scene.media) seg.media.push({ ...scene.media, sceneId: scene.id });
    }
  }

  // Media pane — every rendered scene image, including orphans.
  const mediaItems = Object.entries(sceneImages)
    .filter(([, img]) => img && img.filename)
    .map(([sceneId, img]) => buildMediaItem(sceneId, img, sceneById))
    .sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));

  const sceneCount = scenes.length;
  const available = sceneCount > 0;
  const stale = available
    && !!scriptAnalysis?.sourceContentHash
    && !!contentHash
    && scriptAnalysis.sourceContentHash !== contentHash;

  return {
    workId: manifest?.id || null,
    title: manifest?.title || null,
    draftVersionId,
    activeContentHash: contentHash,
    prose: { segments: proseSegments },
    script: {
      available,
      status: scriptAnalysis?.status || null,
      stale,
      analysisId: scriptAnalysis ? SCRIPT_ANALYSIS_ID : null,
      providerId: scriptAnalysis?.providerId || null,
      model: scriptAnalysis?.model || null,
      completedAt: scriptAnalysis?.completedAt || null,
      error: scriptAnalysis?.status === 'failed' ? (scriptAnalysis.error || 'Script analysis failed') : null,
      title: scriptAnalysis?.result?.title || null,
      logline: scriptAnalysis?.result?.logline || null,
      scenes,
    },
    media: { items: mediaItems },
  };
}

/**
 * Orchestrator — load the work + active body + script analysis and assemble the
 * synced-review read-model. A missing script analysis (never run, or a fresh
 * work) is a normal empty state, not an error.
 */
export async function getSyncedReview(workId) {
  assertValidWorkId(workId);
  const { manifest, body } = await getWorkWithBody(workId);
  const scriptAnalysis = await getAnalysis(workId, SCRIPT_ANALYSIS_ID).catch((err) => {
    if (err?.code === 'NOT_FOUND') return null;
    throw err;
  });
  return buildSyncedReview({ manifest, body, scriptAnalysis });
}
