// Derived views over a catalog ingredient's media rows: read-only protection,
// which rows belong on the References tab, look candidates, the fork seed and
// the cover image.

import { ingredientCoverUrl, isDesignMedia, isReferenceTabMedia } from '../../../lib/creativeLibraries';
import { ingredientPayload } from './ingredientDraft';

export function mediaRowView(record, media, identityReadOnly) {
  const savedPayload = ingredientPayload(record.payload);
  const wardrobes = record.type === 'character' && Array.isArray(savedPayload.wardrobes)
    ? record.payload.wardrobes
    : [];
  const protectMedia = (item) => ({ ...item, readOnly: identityReadOnly || item.retained === true || !!record.sharedIdentity && (item.ingredientId === record.sharedIdentity.sourceId || item.role?.startsWith('archive:identity')) });
  const liveLookIds = new Set(wardrobes.map((w) => w?.id).filter(Boolean));
  const liveShotIds = new Set((savedPayload.greybox?.shots || []).map((s) => s.id));
  const isReferenceTabRow = (m) => isReferenceTabMedia(m, liveLookIds, liveShotIds);
  // The References tab shows the portrait beside the references, so the look
  // picker offers it too unless the same image already has a reference row.
  const referenceKeys = new Set(media.filter((m) => m.kind === 'reference').map((m) => m.mediaKey));
  const lookCandidates = media.filter((m) => (m.kind === 'reference' && isReferenceTabRow(m))
    || (m.kind === 'portrait' && !referenceKeys.has(m.mediaKey)));
  return { wardrobes, protectMedia, liveLookIds, isReferenceTabRow, lookCandidates };
}

export function forkSeedOf(record, media, isReferenceTabRow, { ready, error, load }) {
  const savedPayload = ingredientPayload(record.payload);
  return { candidates: [...media.filter((m) => !m.deleted && (m.kind === 'portrait' || (m.kind === 'reference' && isReferenceTabRow(m)))),
    ...[savedPayload.primaryImageRef, ...(Array.isArray(savedPayload.imageRefs) ? savedPayload.imageRefs : [])]
      .filter((ref) => typeof ref === 'string' && ref.trim()).map((mediaKey) => ({ mediaKey, kind: 'reference' }))],
    forms: Array.isArray(savedPayload.forms) ? savedPayload.forms : [], ready, error, load };
}

export function ingredientCoverOf(record, media, mediaReady, payload) {
  return ingredientCoverUrl({
    ...record,
    thumbnailKey: media.find((m) => m.kind === 'portrait')?.mediaKey || (!mediaReady && record.coverMedia?.portraitKey) || record.thumbnailKey,
    payload,
  }) || ingredientCoverUrl({ thumbnailKey: media.find((m) => m.kind === 'reference' && !m.role?.startsWith('archive:') && (!isDesignMedia(m) || m.library?.guide === true))?.mediaKey || (!mediaReady && record.coverMedia?.referenceKey) });
}
