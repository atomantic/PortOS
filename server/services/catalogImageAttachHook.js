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
 * Mounted once at server boot from server/index.js (after the media job queue is
 * running). Best-effort: a bookkeeping miss is logged but never thrown — it must
 * not crash the server or fail the user's render.
 */

import { mediaJobEvents } from './mediaJobQueue/index.js';
import { attachMedia, setPortraitMedia, listMediaForIngredient, getIngredient } from './catalogDB.js';

// Resolve the render onto the ingredient. Returns the kind attached
// ('portrait' | 'reference'), 'duplicate' when the client already filed it,
// 'gone' when the target ingredient no longer exists, or throws on a real DB
// error (caught by the caller).
async function attachGeneratedImage({ ingredientId, kind, filename }) {
  // The ingredient can be deleted between enqueue and completion (a render
  // outlives its editor by minutes). `getIngredient` filters `deleted = false`,
  // so this skips a hard-deleted ingredient (FK would throw) AND a soft-deleted
  // one (FK is satisfied — attaching would silently file media onto a tombstone
  // and fan those rows to peers via sync_sequence).
  if (!(await getIngredient(ingredientId))) return 'gone';
  const existing = await listMediaForIngredient(ingredientId);
  // Idempotent against the optimistic client path: it already attached this
  // exact render (under any kind) — don't double-file it as a second kind.
  if (existing.some((m) => m.mediaKey === filename)) return 'duplicate';
  const hasPortrait = existing.some((m) => m.kind === 'portrait');
  // Explicit kind wins; otherwise auto: first image → portrait, later → reference
  // (mirrors CatalogIngredient.jsx `handleGeneratedImage`).
  const target = kind === 'portrait' || kind === 'reference'
    ? kind
    : (hasPortrait ? 'reference' : 'portrait');
  if (target === 'portrait') {
    await setPortraitMedia(ingredientId, filename);
  } else {
    await attachMedia(ingredientId, filename, 'reference');
  }
  return target;
}

// Serialize the read→decide→write per ingredient. Two renders for the SAME
// ingredient completing close together (e.g. two parallel Codex jobs, or a
// regenerate after navigating back) would otherwise both read an empty media
// list, both pick 'portrait', and have the second `setPortraitMedia` demote the
// first — losing the earlier render entirely. Chaining each attach onto the
// prior one for that ingredient makes the later job observe the first's write,
// so it correctly falls through to 'reference'. Keyed by ingredientId, so
// different ingredients still attach concurrently (their Postgres rows don't
// conflict). In-memory tail, evicted once settled; lost on restart, which is
// fine — the whole hook is best-effort.
const attachTails = new Map();

function serializePerIngredient(ingredientId, work) {
  const prev = attachTails.get(ingredientId) || Promise.resolve();
  // `work` on both fulfil AND reject so a prior failure doesn't stall the chain.
  const next = prev.then(work, work);
  attachTails.set(ingredientId, next);
  // Evict once settled, but only if nothing newer has chained on. Swallow here
  // (the eviction branch never rethrows) so it can't surface as an unhandled
  // rejection — the caller attaches its own `.catch` to the returned promise.
  const evict = () => { if (attachTails.get(ingredientId) === next) attachTails.delete(ingredientId); };
  next.then(evict, evict);
  return next;
}

let completedHandler = null;

export function initCatalogImageAttachHook() {
  // Idempotent: a stray double-init (test reload, future refactor) would
  // otherwise register two listeners and double-file every completed image.
  if (completedHandler) return;

  // EventEmitter does not await async listeners and does not catch their
  // rejections — a throw here would surface as a process-killing unhandled
  // rejection on Node ≥15. Use a sync listener that launches an async IIFE with
  // a top-level catch so this bookkeeping miss can never crash the server.
  completedHandler = (job) => {
    void (async () => {
      if (!job || job.kind !== 'image') return;
      const tag = job.params?.catalogAttach;
      const ingredientId = tag?.ingredientId;
      if (!ingredientId || typeof ingredientId !== 'string') return;
      const filename = job.result?.filename;
      if (!filename || typeof filename !== 'string') return;

      const status = await serializePerIngredient(ingredientId, () =>
        attachGeneratedImage({ ingredientId, kind: tag.kind, filename }),
      ).catch((err) => {
        console.log(`⚠️ catalog image-attach hook failed for ${filename} → ${ingredientId}: ${err?.message || String(err)}`);
        return 'failed';
      });
      if (status === 'portrait' || status === 'reference') {
        console.log(`🏷️ catalog ingredient ${ingredientId.slice(0, 8)} ← ${status} ${filename}`);
      }
    })().catch((err) => {
      // Last-resort net for synchronous throws (unexpected job shape, etc).
      console.log(`⚠️ catalog image-attach hook crashed: ${err?.message || err}`);
    });
  };

  mediaJobEvents.on('completed', completedHandler);
  console.log('🏷️ Catalog image-attach hook initialized');
}

// Test-only reset so suites that re-init can do so cleanly. Removes the
// previously registered listener so re-init doesn't leak handlers.
export const __testing = {
  reset: () => {
    if (completedHandler) {
      mediaJobEvents.off('completed', completedHandler);
      completedHandler = null;
    }
    attachTails.clear();
  },
};
