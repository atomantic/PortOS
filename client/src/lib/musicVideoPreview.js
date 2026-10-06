import { videoSrcForJob, videoPosterForJob } from './creativeDirectorPreview.js';
import { latestMusicVideoReviewDraft } from '../../../server/lib/musicVideoReviewDraft.js';

const nonEmptyString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const musicVideoImageSrc = (assetId) => {
  const raw = nonEmptyString(assetId);
  if (!raw) return null;
  if (/^(https?:|data:|blob:)/i.test(raw) || raw.startsWith('/')) return raw;
  return `/data/images/${raw}`;
};

export const musicVideoImageFallback = (assetId) => {
  const raw = nonEmptyString(assetId);
  if (!raw || raw.includes('.')) return null;
  return `/data/images/${raw}.png`;
};

/**
 * Normalized preview descriptor for a music video project:
 *   { kind: 'video', jobId?, src, poster?, label }
 *   { kind: 'image', src, fallbackSrc?, label }
 *   { kind: 'none', label }
 */
export function selectMusicVideoPreview(project) {
  const none = { kind: 'none', label: 'No render yet' };
  if (!project || typeof project !== 'object') return none;

  // 1. Final video render (the complete produced music video)
  const finalId = nonEmptyString(project.renderHistoryId);
  if (finalId) {
    return {
      kind: 'video',
      source: 'final',
      jobId: finalId,
      src: videoSrcForJob(finalId),
      poster: videoPosterForJob(finalId),
      label: project.renderDependencyState?.status === 'stale' ? 'Previous final' : 'Final video',
      ...(project.renderDependencyState?.status === 'stale' ? { stale: true } : {}),
    };
  }

  const draft = latestMusicVideoReviewDraft(project);
  if (draft) return draft;

  // 2. Latest completed excerpt render
  const excerpts = Array.isArray(project.excerpts) ? project.excerpts : [];
  const latestExcerpt = [...excerpts].reverse().find((e) => e.status === 'complete' && (e.filename || e.jobId));
  if (latestExcerpt) {
    const excerptJobId = nonEmptyString(latestExcerpt.jobId);
    const filename = nonEmptyString(latestExcerpt.filename);
    const excerptSrc = filename ? `/data/videos/${filename}` : (excerptJobId ? videoSrcForJob(excerptJobId) : null);
    return {
      kind: 'video',
      jobId: excerptJobId,
      src: excerptSrc,
      poster: excerptJobId ? videoPosterForJob(excerptJobId) : null,
      label: latestExcerpt.label || 'Latest excerpt',
    };
  }

  // 3. Latest scene video clip
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  for (let i = scenes.length - 1; i >= 0; i -= 1) {
    const s = scenes[i];
    const vidId = nonEmptyString(s?.videoHistoryId);
    if (vidId) {
      return {
        kind: 'video',
        jobId: vidId,
        src: videoSrcForJob(vidId),
        poster: videoPosterForJob(vidId),
        label: `Scene ${i + 1} clip`,
      };
    }
  }

  // 4. Latest scene reference frame
  for (let i = scenes.length - 1; i >= 0; i -= 1) {
    const s = scenes[i];
    const frameId = nonEmptyString(s?.referenceImageId);
    if (frameId) {
      return {
        kind: 'image',
        src: musicVideoImageSrc(frameId),
        fallbackSrc: musicVideoImageFallback(frameId),
        label: `Scene ${i + 1} frame`,
      };
    }
  }

  // 5. Visual specification references
  const visualRefs = project.visualSpec?.references;
  if (Array.isArray(visualRefs) && visualRefs.length > 0) {
    const refId = nonEmptyString(visualRefs[0]?.imageId);
    if (refId) {
      return {
        kind: 'image',
        src: musicVideoImageSrc(refId),
        fallbackSrc: musicVideoImageFallback(refId),
        label: visualRefs[0].label || 'Style reference',
      };
    }
  }

  return none;
}
