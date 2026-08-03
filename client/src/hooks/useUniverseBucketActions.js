import { useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  autoSortBuckets,
  ensureInfluences,
  generateCategoryVariations,
  promoteVariationToCanon,
  updateUniverse,
} from '../services/api';
import useUniverseAction from './useUniverseAction';
import { upsertByIdPrepend } from '../lib/upsertByIdPrepend';
import { mergeVariations } from '../lib/universeBuilderExpand';
import { humanizeCategory } from '../lib/universeBuilderShared';

/**
 * Owns the Universe Builder's three bucket-scoped LLM mutations: generate more
 * variations inside a bucket, promote a variation into canon, and auto-sort
 * the Other-tab buckets into canon trunks.
 *
 * Promote + auto-sort run through `useUniverseAction` (guard → loading toast →
 * setWorlds → stale-write check); generate keeps its own eager-merge-then-
 * best-effort-save shape, which the scaffolding deliberately doesn't cover.
 *
 * Each action carries a page-level in-flight gate (ref for the synchronous
 * disable check, state to trigger renders) so two writes built from the same
 * stale snapshot can't clobber each other's canon append.
 */
export default function useUniverseBucketActions({
  selectedId,
  draft,
  draftRef,
  setDraft,
  setWorlds,
  markDraftSaved,
  mountedRef,
  flushDraftIfDirty,
}) {
  const [promoting, setPromoting] = useState(false);
  const promotingRef = useRef(false);
  const [autoSorting, setAutoSorting] = useState(false);
  const autoSortingRef = useRef(false);
  // Scaffolding shared by handlePromoteVariation + handleAutoSort:
  // selectedId guard, ref re-entrancy, capturedId + toast lifecycle,
  // setWorlds always-update, stale-write detection. See the hook header.
  const runUniverseAction = useUniverseAction({ selectedId, mountedRef, setWorlds });

  // Auto-sort with AI — one LLM call classifies every Other-tab bucket into
  // characters/places/objects. Each bucket's `kind` is reassigned via a
  // single atomic patch server-side so the universe ends up consistent or
  // unchanged. Renames the LLM suggests are surfaced in the toast but not
  // auto-applied (the user can rename manually if they want it).
  const handleAutoSort = () => runUniverseAction({
    ref: autoSortingRef,
    setBusy: setAutoSorting,
    loadingMessage: 'Auto-sorting buckets with AI…',
    errorPrefix: 'Auto-sort failed',
    notSavedMessage: 'Save the universe first — auto-sort needs the persisted record',
    preflight: flushDraftIfDirty,
    action: (capturedId) => autoSortBuckets(capturedId, {
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }, { silent: true }),
    onFreshResult: (result) => {
      const updated = result.universe;
      // Merge only the reclassified buckets into the draft — wholesale-
      // replacing `categories` with the server snapshot would discard any
      // user edits to OTHER buckets made while the LLM call was in flight.
      // Compute the merge from draftRef so React strict-mode's double-fire
      // of state updaters doesn't double-stringify the dirty baseline.
      const sortedKeys = new Set((result.results || []).map((r) => r.sourceKey));
      const baseDraft = draftRef.current || draft;
      const nextCategories = { ...(baseDraft.categories || {}) };
      for (const key of sortedKeys) {
        if (updated.categories?.[key]) nextCategories[key] = updated.categories[key];
      }
      const newDraft = {
        ...baseDraft,
        categories: nextCategories,
        schemaVersion: updated.schemaVersion,
        updatedAt: updated.updatedAt,
      };
      setDraft(newDraft);
      markDraftSaved(newDraft);
      const sortedCount = result.results?.length || 0;
      const renames = (result.results || []).filter((r) => r.suggestedKey);
      const summary = sortedCount
        ? `Sorted ${sortedCount} bucket${sortedCount === 1 ? '' : 's'} into canon trunks`
        : 'No buckets were classified';
      const renameHint = renames.length
        ? ` — ${renames.length} rename suggestion${renames.length === 1 ? '' : 's'} available`
        : '';
      return `${summary}${renameHint}`;
    },
  });

  const handleGenerateInCategory = async (cat, count) => {
    // Match the runUniverseAction-based handlers — flush dirty draft so the
    // subsequent auto-save can't clobber unrelated fields with a stale spread.
    const flushed = await flushDraftIfDirty();
    if (!flushed) return;
    const current = draft.categories?.[cat]?.variations || [];
    const existingLabels = current.map((v) => v.label).filter(Boolean);
    const result = await generateCategoryVariations({
      category: cat,
      count,
      existingLabels,
      influences: ensureInfluences(draft.influences),
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }, { silent: true }).catch((e) => { toast.error(`Generate failed: ${e.message}`); return null; });
    if (!result) return;
    const fresh = Array.isArray(result.variations) ? result.variations : [];
    const merged = mergeVariations(current, fresh);
    const additionCount = merged.length - current.length;
    if (additionCount === 0) {
      toast.error('LLM returned no new variations — try again or adjust the universe context');
      return;
    }
    const nextDraft = {
      ...draft,
      // Preserve the bucket's `kind` (mirror of updateCategory's behavior;
      // see comment there). Generate-more is the second write path that
      // could silently reset the trunk to default/other.
      categories: { ...draft.categories, [cat]: { ...(draft.categories?.[cat] || {}), variations: merged } },
    };
    setDraft(nextDraft);
    if (selectedId && nextDraft.name?.trim()) {
      const updated = await updateUniverse(selectedId, { categories: nextDraft.categories }, { silent: true })
        .catch((e) => { toast.error(`Auto-save after generate failed: ${e.message}`); return null; });
      if (updated) {
        setWorlds((prev) => upsertByIdPrepend(prev, updated));
        markDraftSaved(nextDraft);
        toast.success(`Added ${additionCount} variation${additionCount === 1 ? '' : 's'} to ${humanizeCategory(cat)} — saved`);
        return;
      }
    }
    toast.success(`Added ${additionCount} variation${additionCount === 1 ? '' : 's'} to ${humanizeCategory(cat)} — review then Save`);
  };

  // Requires `selectedId` — the server action reads the persisted record,
  // so an unsaved draft can't be promoted from. The page-level `promoting`
  // gate prevents two promotes (across buckets or trunks) from racing each
  // other to stale-snapshot writes against the same universe.
  const handlePromoteVariation = (category, variation, { targetKind } = {}) => {
    if (!variation?.label) return Promise.resolve(null);
    return runUniverseAction({
      ref: promotingRef,
      setBusy: setPromoting,
      loadingMessage: `Promoting "${variation.label}" to canon…`,
      errorPrefix: 'Promote failed',
      notSavedMessage: 'Save the universe first — promote needs the persisted record',
      preflight: flushDraftIfDirty,
      action: (capturedId) => promoteVariationToCanon(capturedId, {
        category,
        label: variation.label,
        targetKind,
        providerId: draft.llm?.provider || undefined,
        model: draft.llm?.model || undefined,
      }, { silent: true }),
      onFreshResult: (result) => {
        const updated = result.universe;
        // Selective merge: only the canon array + the affected category bucket
        // changed server-side. Preserve every other draft field (the user may
        // have typed into logline/premise/influences during the LLM call).
        // Compute outside setDraft so strict-mode's double-invoke doesn't
        // re-stringify the dirty baseline.
        const baseDraft = draftRef.current || draft;
        const newDraft = {
          ...baseDraft,
          characters: updated.characters,
          places: updated.places,
          objects: updated.objects,
          categories: { ...baseDraft.categories, [result.removed.category]: updated.categories?.[result.removed.category] },
          schemaVersion: updated.schemaVersion,
          updatedAt: updated.updatedAt,
        };
        setDraft(newDraft);
        markDraftSaved(newDraft);
        return `Promoted "${variation.label}" → ${result.targetKind} canon`;
      },
    });
  };

  return {
    autoSorting,
    handleAutoSort,
    handleGenerateInCategory,
    handlePromoteVariation,
    promoting,
  };
}
