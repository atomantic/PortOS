/**
 * Cloud-CLI input images — the one place that turns a render request's
 * `initImagePath` + `referenceImagePaths` into the ordered, re-anchored,
 * per-backend-capped list a CLI hands to its image tool.
 *
 * Every cloud backend takes its input images as a single ordered array
 * (codex `referenced_image_paths`, grok `image_edit.image`, agy `ImagePaths`,
 * fal.ai `image_urls`), so they share one resolution rule: the init image, if any, leads — it is the
 * one the fidelity phrase describes — followed by the reference slots in submit
 * order. Only the per-backend ceiling differs, and that lives on the provider
 * spec (`maxInputImages` in cloudProviderConfig.js) with the rest of the
 * per-provider capability facts.
 *
 * Path re-anchoring is defense-in-depth, mirroring imageGen/local.js: the HTTP
 * routes already resolve basenames to absolute paths, but a CLI is handed these
 * as literal filesystem paths, so re-anchor here too and no caller can point one
 * at an arbitrary local file.
 */

import { resolveImageInputPath } from '../../lib/fileUtils.js';
import { maxInputImages } from './cloudProviderConfig.js';

const asPathList = (value) => (Array.isArray(value) ? value : [])
  .filter((p) => typeof p === 'string' && p.trim());

/**
 * @param {object} opts
 * @param {string} opts.mode                  - IMAGE_GEN_MODE key (picks the cap)
 * @param {string|null} opts.initImagePath    - primary source image, if any
 * @param {string[]} opts.referenceImagePaths - additional reference images
 * @param {string|null} opts.modelId          - the model that will render, for a
 *   backend whose cap is per model (fal.ai); ignored by the others
 * @returns {{ paths: string[], initPath: string|null, referencePaths: string[] }}
 *   `paths` is what the tool receives (init first). `initPath` is non-null only
 *   when a valid init image survived, so callers can pick the edit-vs-reference
 *   wording without re-deriving the ordering; `referencePaths` is the same list
 *   minus that leading source image.
 */
export function resolveInputImages({ mode, initImagePath = null, referenceImagePaths = [], modelId = null } = {}) {
  const rawInit = (typeof initImagePath === 'string' && initImagePath.trim()) ? initImagePath : null;
  // An unresolvable path drops out rather than failing the render — the caller
  // still gets a usable (possibly text-only) generation instead of a 500.
  const resolvedInit = rawInit ? resolveImageInputPath(rawInit) : null;
  const resolvedRefs = asPathList(referenceImagePaths)
    .map((p) => resolveImageInputPath(p))
    .filter(Boolean);

  const ordered = [...(resolvedInit ? [resolvedInit] : []), ...resolvedRefs];
  // A mode with no declared cap (a direct caller passing something odd) gets no
  // truncation rather than a silent truncation to zero.
  const limit = maxInputImages(mode, modelId) ?? ordered.length;
  const paths = ordered.slice(0, limit);
  if (ordered.length > paths.length) {
    console.log(`⚠️ ${mode} accepts at most ${limit} input images — dropping ${ordered.length - paths.length} reference(s)`);
  }
  return {
    paths,
    initPath: resolvedInit,
    referencePaths: resolvedInit ? paths.slice(1) : paths,
  };
}
