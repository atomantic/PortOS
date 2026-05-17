/**
 * Pipeline comic-pages — filename hook.
 *
 * Stamps `filename` onto the matching cover/page record on media-job
 * completion so the UI keeps rendering after mediaJobQueue's 24h archive
 * TTL expires. Panel renders are intentionally NOT handled here —
 * enqueueVisualImage's owner string doesn't encode page/panel position,
 * so the hook can't locate the target. Encode position into that owner
 * before extending this hook to panels.
 *
 * `parsed.variant` ('proof' | 'final') routes the completion to the right
 * slot. Legacy in-flight jobs (no variant in the owner) parse as 'proof'
 * and land via the legacy-jobId fallback below.
 */

import { parseComicPagesOwner, slotKeyForVariant } from './owners.js';
import { createFilenameHook } from './filenameHookFactory.js';
import { buildRenderSlot } from './visualStages.js';

// Slot record for a legacy in-flight completion (job enqueued before the
// proof/final split). `job.params` carries the originally-requested width
// and height; the rest of the slot shape matches what the new route writes
// at enqueue time.
const legacySlotRecord = (slotKey, job, filename, legacyPrompt) =>
  buildRenderSlot({
    slotKey,
    jobId: job.id,
    filename,
    prompt: legacyPrompt,
    width: job.params?.width,
    height: job.params?.height,
  });

const hook = createFilenameHook({
  name: 'comicPages',
  stageId: 'comicPages',
  parseOwner: parseComicPagesOwner,
  applyFilename: (currentStage, parsed, job, filename) => {
    const slotKey = slotKeyForVariant(parsed.variant);
    // Cover and backCover share the exact same slot shape, so the
    // stamp/migrate logic is identical — only the field name on
    // `currentStage` differs. Branch on `parsed.target` instead of
    // duplicating two near-identical blocks.
    if (parsed.target === 'cover' || parsed.target === 'backCover') {
      const field = parsed.target;             // 'cover' | 'backCover'
      const record = currentStage?.[field];
      if (!record) return null;
      // New shape: the route stamped { jobId, …, filename: null } into
      // record[slotKey] at enqueue. Only stamp the filename if THIS job
      // is still the slot's active render — a re-render that landed
      // between enqueue and this event would otherwise be overwritten
      // with the older filename.
      if (record[slotKey]?.jobId === job.id) {
        return {
          patch: { [field]: { ...record, [slotKey]: { ...record[slotKey], filename } } },
          label: `${field}.${slotKey}`,
        };
      }
      // Legacy shape — pre-split job that wrote record.imageJobId.
      // Stamp the result into the matching new slot AND clear the
      // legacy imageJobId/filename so the UI reads exclusively from
      // the slot.
      if (record.imageJobId === job.id) {
        return {
          patch: {
            [field]: {
              ...record,
              [slotKey]: legacySlotRecord(slotKey, job, filename, record.prompt),
              imageJobId: null,
              filename: null,
            },
          },
          label: `${field}.${slotKey} (migrated)`,
        };
      }
      return null;
    }
    const pages = Array.isArray(currentStage?.pages) ? currentStage.pages : [];
    const page = pages[parsed.pageIndex];
    if (!page) return null;
    const nextPages = [...pages];
    if (page[slotKey]?.jobId === job.id) {
      nextPages[parsed.pageIndex] = {
        ...page,
        [slotKey]: { ...page[slotKey], filename },
      };
      return { patch: { pages: nextPages }, label: `page${parsed.pageIndex}.${slotKey}` };
    }
    if (page.imageJobId === job.id) {
      // Same migration pattern as cover, but pages have a pass-through
      // sanitizer — divergent legacy field names would be missed here, so
      // the clear is inlined for visibility rather than hidden in a helper.
      nextPages[parsed.pageIndex] = {
        ...page,
        [slotKey]: legacySlotRecord(slotKey, job, filename, page.prompt),
        imageJobId: null,
        filename: null,
      };
      return { patch: { pages: nextPages }, label: `page${parsed.pageIndex}.${slotKey} (migrated)` };
    }
    return null;
  },
});

export const initComicPagesFilenameHook = hook.init;
export const __testing = hook.__testing;
