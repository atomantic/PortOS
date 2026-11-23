/**
 * Universe Builder LLM expansion + holistic refine lifecycle, including lock-preserving request
 * payloads, deletion-wins pending-canon auto-save, provider selection, and refine-panel state.
 *
 * Use when: Universe Builder Bible panel; keep provider calls and canon-aware auto-save out of
 * presentation components.
 */

import { useCallback, useEffect, useState } from 'react';
import toast from '../ui/Toast';
import {
  createUniverse,
  expandUniverse,
  getUniverse,
  refineWorldPrompts,
  updateUniverse,
  WORLD_LOCKABLE_FIELDS,
  ensureInfluences,
  isInfluenceLockField,
} from '../../services/apiUniverseBuilder.js';
import { upsertByIdPrepend } from '../../lib/upsertByIdPrepend';
import {
  extractPreservedFromDraft,
  mergeCanonByName,
  mergeExpandIntoDraft,
} from '../../lib/universeBuilderExpand';
import { totalVariationCount } from '../../lib/universeBuilderCounts';
import { ensureDraftCategories } from '../../lib/universeBuilderShared';
import { pluralize } from '../../lib/textUtils';

const expandToast = ({ variationCount, sheetCount, addedCanonCount, saved }) => {
  const summary = `Expanded into ${pluralize(variationCount, 'variation')}, ${pluralize(sheetCount, 'board')}, ${pluralize(addedCanonCount, 'new canon entry', 'new canon entries')}`;
  return `${summary} — ${saved ? 'saved' : 'review then Save'}`;
};

/**
 * Owns Universe Builder LLM expansion and holistic refinement.
 *
 * Persistence stays coordinated with useUniverseDraft through the saved
 * baseline and pending-canon ledger passed in below. This preserves the
 * deletion-wins canon merge contract while keeping provider calls and refine
 * panel state out of the feature component.
 */
export default function useUniverseExpand({
  selectedId,
  selectedIdRef,
  mountedRef,
  draftRef,
  draft,
  setDraft,
  setSaving,
  setWorlds,
  goToWorld,
  activeProviderId,
  markDraftSaved,
  setCanonDirty,
  pendingCanonAdditionsRef,
  clearPendingCanonAdditions,
  setRenderOpts,
}) {
  const [expanding, setExpanding] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineFeedback, setRefineFeedback] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineRationale, setRefineRationale] = useState('');
  const [refineChanges, setRefineChanges] = useState([]);
  const [refineImage, setRefineImage] = useState(null);

  const resetRefinePanel = useCallback(() => {
    setRefineOpen(false);
    setRefineFeedback('');
    setRefineRationale('');
    setRefineChanges([]);
    setRefineImage(null);
  }, []);

  useEffect(() => { resetRefinePanel(); }, [selectedId, resetRefinePanel]);

  // True while the user is still on the universe that started the request.
  const isStillOn = (capturedId) => mountedRef.current && selectedIdRef.current === capturedId;

  const handleExpand = async () => {
    const capturedId = selectedId;
    if (!draft.starterPrompt?.trim()) {
      toast.error('Add a starter prompt to expand');
      return;
    }
    const { preservedVariations, preservedCompositeSheets } = extractPreservedFromDraft(draft);
    setExpanding(true);
    const result = await expandUniverse({
      starterPrompt: draft.starterPrompt,
      influences: ensureInfluences(draft.influences),
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      locked: draft.locked || {},
      preservedVariations,
      preservedCompositeSheets,
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }, { silent: true }).catch((error) => { toast.error(`Expansion failed: ${error.message}`); return null; });
    if (mountedRef.current) setExpanding(false);
    if (!result || !isStillOn(capturedId)) return;

    const {
      expandedDraft,
      addedCanonCount,
      pendingAdditions,
      lockedKeys,
    } = mergeExpandIntoDraft(draft, result, { ensureDraftCategories });
    setDraft(expandedDraft);
    if (addedCanonCount > 0) {
      setCanonDirty(true);
      pendingCanonAdditionsRef.current = {
        characters: [...pendingCanonAdditionsRef.current.characters, ...pendingAdditions.characters],
        places: [...pendingCanonAdditionsRef.current.places, ...pendingAdditions.places],
        objects: [...pendingCanonAdditionsRef.current.objects, ...pendingAdditions.objects],
      };
    }
    if (lockedKeys.length) {
      console.log(`🔒 Universe Builder expand preserved ${lockedKeys.length} locked field(s): ${lockedKeys.join(', ')}`);
    }
    const variationCount = totalVariationCount(expandedDraft);
    if (expandedDraft.compositeSheets?.length) {
      setRenderOpts((current) => ({ ...current, promptMode: 'sheets' }));
    }

    if (expandedDraft.name?.trim()) {
      setSaving(true);
      let canonForPayload = {
        characters: expandedDraft.characters || [],
        places: expandedDraft.places || [],
        objects: expandedDraft.objects || [],
      };
      if (selectedId) {
        const fresh = await getUniverse(selectedId).catch(() => null);
        if (!isStillOn(capturedId)) {
          if (mountedRef.current) setSaving(false);
          return;
        }
        if (!fresh) {
          setSaving(false);
          toast.success(expandToast({
            variationCount,
            sheetCount: expandedDraft.compositeSheets?.length || 0,
            addedCanonCount,
            saved: false,
          }));
          return;
        }
        canonForPayload = {
          characters: mergeCanonByName(
            fresh.characters || [],
            pendingCanonAdditionsRef.current.characters,
            'character',
          ),
          places: mergeCanonByName(
            fresh.places || [],
            pendingCanonAdditionsRef.current.places,
            'place',
          ),
          objects: mergeCanonByName(
            fresh.objects || [],
            pendingCanonAdditionsRef.current.objects,
            'object',
          ),
        };
      }
      const payload = {
        name: expandedDraft.name.trim(),
        starterPrompt: expandedDraft.starterPrompt || '',
        logline: expandedDraft.logline || '',
        premise: expandedDraft.premise || '',
        styleNotes: expandedDraft.styleNotes || '',
        // Fields tracked by the draft baseline must ship too, or create-then-hydrate
        // drops them and markDraftSaved records a baseline that never matches.
        factual: expandedDraft.factual === true,
        visualProfile: expandedDraft.visualProfile || null,
        // Linked mood board (#4188) — without it the create path lands the
        // new universe unlinked and hydration silently drops the pick.
        moodBoardId: expandedDraft.moodBoardId || null,
        categories: expandedDraft.categories,
        compositeSheets: expandedDraft.compositeSheets || [],
        ...canonForPayload,
        influences: ensureInfluences(expandedDraft.influences),
        locked: expandedDraft.locked || {},
        llm: expandedDraft.llm || {},
        ...(expandedDraft.imageMode ? { imageMode: expandedDraft.imageMode } : {}),
        ...(expandedDraft.imageModelId ? { imageModelId: expandedDraft.imageModelId } : {}),
      };
      const saved = await (selectedId
        ? updateUniverse(selectedId, payload, { silent: true })
        : createUniverse(payload, { silent: true }))
        .catch((error) => { toast.error(`Auto-save after expand failed: ${error.message}`); return null; })
        .finally(() => { if (mountedRef.current) setSaving(false); });
      if (saved) {
        setWorlds((previous) => upsertByIdPrepend(previous, saved));
        if (!isStillOn(capturedId)) return;
        setCanonDirty(false);
        clearPendingCanonAdditions();
        markDraftSaved({ ...payload, id: saved.id, updatedAt: saved.updatedAt });
        if (!selectedId) goToWorld(saved.id);
        toast.success(expandToast({
          variationCount,
          sheetCount: expandedDraft.compositeSheets?.length || 0,
          addedCanonCount,
          saved: true,
        }));
        return;
      }
    }
    toast.success(expandToast({
      variationCount,
      sheetCount: expandedDraft.compositeSheets?.length || 0,
      addedCanonCount,
      saved: false,
    }));
  };

  const applyRefinement = async (patch = {}, capturedId = selectedId) => {
    if (!isStillOn(capturedId)) return;
    // Patch the live draft so edits typed during the LLM call survive.
    const next = { ...(draftRef.current || draft) };
    for (const key of WORLD_LOCKABLE_FIELDS) {
      if (isInfluenceLockField(key)) continue;
      if (!(key in patch) || patch[key] == null) continue;
      next[key] = patch[key];
    }
    if (patch.influences != null) next.influences = ensureInfluences(patch.influences);
    if (patch.categories) next.categories = ensureDraftCategories(patch.categories);
    if (Array.isArray(patch.compositeSheets)) next.compositeSheets = patch.compositeSheets;
    setDraft(next);
    if (selectedId && next.name?.trim()) {
      const refinePayload = {
        name: next.name.trim(),
        starterPrompt: next.starterPrompt || '',
        logline: next.logline || '',
        premise: next.premise || '',
        styleNotes: next.styleNotes || '',
        factual: next.factual === true,
        visualProfile: next.visualProfile || null,
        moodBoardId: next.moodBoardId || null,
        categories: next.categories,
        compositeSheets: next.compositeSheets || [],
        influences: ensureInfluences(next.influences),
        locked: next.locked || {},
        llm: next.llm || {},
      };
      const updated = await updateUniverse(selectedId, refinePayload, { silent: true })
        .catch((error) => { toast.error(`Auto-save after refine failed: ${error.message}`); return null; });
      if (updated) {
        setWorlds((previous) => upsertByIdPrepend(previous, updated));
        if (!isStillOn(capturedId)) return;
        markDraftSaved({ ...refinePayload, id: updated.id, updatedAt: updated.updatedAt });
      }
    }
  };

  const runRefine = async (visionOverride = null) => {
    const capturedId = selectedId;
    const feedback = refineFeedback.trim();
    if (!feedback) {
      toast.error('Add feedback to refine');
      return;
    }
    if (!draft.starterPrompt?.trim()) {
      toast.error('Add a starter idea first — there is nothing for the LLM to refine');
      return;
    }
    const locks = draft.locked || {};
    const allTopLocked = WORLD_LOCKABLE_FIELDS.every((key) => locks[key]);
    const hasStructure = totalVariationCount(draft) > 0 || (draft.compositeSheets?.length || 0) > 0;
    if (allTopLocked && !hasStructure) {
      toast.error('All fields are locked — unlock at least one to enable refinement');
      return;
    }

    setRefining(true);
    setRefineRationale('');
    setRefineChanges([]);
    const result = await refineWorldPrompts({
      starterPrompt: draft.starterPrompt || '',
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      influences: ensureInfluences(draft.influences),
      categories: hasStructure ? draft.categories : undefined,
      compositeSheets: hasStructure ? draft.compositeSheets : undefined,
      locked: locks,
      feedback,
      image: refineImage?.filename || undefined,
      providerId: refineImage
        ? (visionOverride?.providerId || undefined)
        : (draft.llm?.provider || activeProviderId || undefined),
      model: refineImage
        ? (visionOverride?.model || undefined)
        : (draft.llm?.model || undefined),
    }).catch(() => null);
    if (mountedRef.current) setRefining(false);
    if (!result || !isStillOn(capturedId)) return;

    const patch = {};
    for (const key of WORLD_LOCKABLE_FIELDS) {
      if (isInfluenceLockField(key) || locks[key]) continue;
      patch[key] = (result[key] ?? '').trim();
    }
    if (result.influences) {
      const original = ensureInfluences(draft.influences);
      const refined = ensureInfluences(result.influences);
      patch.influences = {
        embrace: locks.influencesEmbrace && refined.embrace.length === 0
          ? original.embrace
          : refined.embrace,
        avoid: locks.influencesAvoid && refined.avoid.length === 0
          ? original.avoid
          : refined.avoid,
      };
    }
    if (result.categories && typeof result.categories === 'object') patch.categories = result.categories;
    if (Array.isArray(result.compositeSheets)) patch.compositeSheets = result.compositeSheets;

    await applyRefinement(patch, capturedId);
    if (!isStillOn(capturedId)) return;
    setRefineRationale(result.rationale || '');
    setRefineChanges(Array.isArray(result.changes) ? result.changes : []);
    setRefineFeedback('');
    setRefineImage(null);
    toast.success('Refined world applied');
  };

  return {
    expanding,
    handleExpand,
    refine: {
      changes: refineChanges,
      feedback: refineFeedback,
      image: refineImage,
      open: refineOpen,
      rationale: refineRationale,
      reset: resetRefinePanel,
      run: runRefine,
      running: refining,
      setFeedback: setRefineFeedback,
      setImage: setRefineImage,
      setOpen: setRefineOpen,
    },
  };
}
