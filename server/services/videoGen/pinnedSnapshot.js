/**
 * Resolve the local path for a model whose registry entry may pin an immutable
 * Hugging Face revision. Each runtime call site selects its missing-revision
 * policy explicitly because the legacy behaviors intentionally differ.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { inspectModelCache } from '../../lib/hfCache.js';

export async function resolvePinnedSnapshotPath(model, {
  notCachedCode,
  onMissingRevision,
  fallback = null,
  missingRevisionMessage = null,
}) {
  const hasPinnedRevision = typeof model.revision === 'string' && model.revision;
  if (!hasPinnedRevision) {
    if (onMissingRevision === 'throw') {
      throw new ServerError(missingRevisionMessage, {
        status: 500,
        code: 'VIDEO_MODEL_MISCONFIGURED',
      });
    }
    if (onMissingRevision === 'passthrough-repo') return fallback;
    if (onMissingRevision === 'best-effort') {
      const cache = await inspectModelCache(model.repo);
      return cache.cached && cache.snapshotPath ? cache.snapshotPath : fallback;
    }
    throw new TypeError(`Unknown missing-revision policy: ${onMissingRevision}`);
  }

  const cache = await inspectModelCache(model.repo, { revision: model.revision });
  if (!cache.cached || !cache.snapshotPath) {
    throw new ServerError(
      `${model.name} revision ${model.revision.slice(0, 8)} is not fully cached. Download or repair it in Video Gen before rendering.`,
      { status: 400, code: notCachedCode },
    );
  }
  return cache.snapshotPath;
}
