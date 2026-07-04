/**
 * Catalog image-attach hook (issue #1359).
 *
 * Subscribes to mediaJobEvents and, for each completed image job that carries
 * `params.catalogAttach.ingredientId`, attaches the rendered filename onto that
 * catalog ingredient — server-side, independent of any mounted client. This is
 * the durable counterpart to CatalogIngredient.jsx's mounted `onFilename`
 * callback: a long-running local/Codex render that completes after the user has
 * navigated away, refreshed, or switched ingredients still lands a portrait or
 * reference row (previously the image reached the media library but no row was
 * ever created, so the attachment was silently lost).
 *
 * Decision mirrors the client's optimistic path (`handleGeneratedImage`): the
 * first image becomes the portrait, later ones attach as references — unless an
 * explicit `kind` was requested. Idempotent against the client path: when the
 * filename is already attached (the still-mounted client won the race), the hook
 * is a no-op, so the same render never lands as both portrait AND reference.
 *
 * The shared completion-hook scaffold (tag-decode, per-ingredient
 * serialization, best-effort error handling, idempotent init/reset) lives in
 * `createMediaJobImageHook` (#1791) — this file is just the catalog-specific
 * config plus the portrait newest-render-wins guard below. Mounted once at
 * server boot from server/index.js (after the media job queue is running).
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { attachMedia, setPortraitMedia, listMediaForIngredient, getIngredient } from './catalogDB.js';
import { createNewestWinsGuard } from '../lib/createNewestWinsGuard.js';

// Newest-render-wins for the PORTRAIT slot only (#1791). The per-ingredient
// serialize already stops two concurrent renders from clobbering each other,
// but an OLDER render completing AFTER a newer portrait (e.g. an out-of-order
// Codex regenerate) would still demote the newer one. Unlike the scene-frame
// hooks — which drop a stale render outright — catalog references are additive,
// so instead of losing the image we file a stale would-be-portrait as a
// reference. Keyed per ingredient; absent `queuedAt` is never stale, so the
// guard is inert for renders the queue didn't timestamp.
const portraitGuard = createNewestWinsGuard();

// Resolve the render onto the ingredient. Returns the kind attached
// ('portrait' | 'reference'), 'duplicate' when the client already filed it,
// 'gone' when the target ingredient no longer exists, or throws on a real DB
// error (caught by the factory).
async function attachGeneratedImage({ ingredientId, kind, filename, queuedAt }) {
  // The ingredient can be deleted between enqueue and completion (a render
  // outlives its editor by minutes). `getIngredient` filters `deleted = false`,
  // so this skips a hard-deleted ingredient (FK would throw) AND a soft-deleted
  // one (FK is satisfied — attaching would silently file media onto a tombstone
  // and fan those rows to peers via sync_sequence).
  if (!(await getIngredient(ingredientId))) return 'gone';
  const existing = await listMediaForIngredient(ingredientId);
  // Idempotent against the optimistic client path: it already attached this
  // exact render (under any kind) — don't double-file it as a second kind.
  const existingRow = existing.find((m) => m.mediaKey === filename);
  if (existingRow) {
    // The mounted client won the optimistic attach for this render. If it
    // landed as the PORTRAIT, still record its queuedAt in the guard — otherwise
    // a later OLDER portrait render isn't seen as stale and would clobber this
    // newer one (the guard's mark normally happens on our own setPortraitMedia
    // write below, which this duplicate path skips).
    if (existingRow.kind === 'portrait') portraitGuard.mark(ingredientId, queuedAt);
    return 'duplicate';
  }
  const hasPortrait = existing.some((m) => m.kind === 'portrait');
  // Explicit kind wins; otherwise auto: first image → portrait, later → reference
  // (mirrors CatalogIngredient.jsx `handleGeneratedImage`).
  let target = kind === 'portrait' || kind === 'reference'
    ? kind
    : (hasPortrait ? 'reference' : 'portrait');
  // A stale would-be-portrait must not demote a newer portrait. Keep the image
  // as a reference rather than dropping it (references are additive).
  if (target === 'portrait' && portraitGuard.isStale(ingredientId, queuedAt)) {
    target = 'reference';
  }
  if (target === 'portrait') {
    await setPortraitMedia(ingredientId, filename);
    portraitGuard.mark(ingredientId, queuedAt);
  } else {
    await attachMedia(ingredientId, filename, 'reference');
  }
  return target;
}

const hook = createMediaJobImageHook({
  label: 'catalog image-attach',
  initLog: '🏷️ Catalog image-attach hook initialized',
  tagKey: 'catalogAttach',
  identify: (tag) => (typeof tag?.ingredientId === 'string' && tag.ingredientId
    ? { ingredientId: tag.ingredientId }
    : null),
  // Serialize the read→decide→write per ingredient so two renders for the SAME
  // ingredient don't both read an empty media list, both pick 'portrait', and
  // have the second demote the first. Different ingredients attach concurrently.
  serializeKey: ({ ingredientId }) => ingredientId,
  describe: ({ ingredientId }) => ingredientId,
  attach: ({ ingredientId, tag, filename, queuedAt }) => attachGeneratedImage({
    ingredientId, kind: tag.kind, filename, queuedAt,
  }),
  onAttached: ({ ingredientId, filename }, status) => {
    if (status === 'portrait' || status === 'reference') {
      console.log(`🏷️ catalog ingredient ${ingredientId.slice(0, 8)} ← ${status} ${filename}`);
    }
  },
});

export function initCatalogImageAttachHook() {
  hook.init();
}

// Test-only reset — also clears the portrait guard the factory doesn't own.
export const __testing = {
  reset: () => {
    hook.__testing.reset();
    portraitGuard.clear();
  },
};
