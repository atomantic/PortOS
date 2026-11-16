// Writes from the Looks, Greybox/Photoreal/World and Sheets tabs that land on
// the SAVED ingredient payload directly. Each copies only its own keys into the
// draft so unsaved profile edits stay intact and exactly as dirty as they were.

import { useCallback, useRef, useState } from 'react';
import toast from '../../ui/Toast';
import { getCatalogIngredientDetails, updateCatalogIngredient, removeCatalogPointerSheet } from '../../../services/apiCatalog';
import { ingredientPayload } from './ingredientDraft';

// Payload fields the universe sheet renderer writes (via the canon→catalog
// projection); see lib/sheetPointers.js.
const SHEET_POINTER_KEYS = ['referenceSheetImageRef', 'referenceSheets'];

export default function useIngredientSavedPatches(id, editor) {
  const {
    record, setRecord, identityReadOnly, draft: { setPayload }, setLookSaving, refreshRevisions,
    activeVisitRef, mountedRef, detailView, editSnapshot, setExternalDetails, applyDetails,
  } = editor;
  const sheetPointerSequence = useRef(0);

  // Save the Looks tab's wardrobe list straight onto the SAVED payload, then
  // copy just `wardrobes` into the draft.
  const handleSaveWardrobes = useCallback(async (wardrobes) => {
    if (!record || identityReadOnly) return false;
    const submittedId = record.id;
    const nextPayload = { ...ingredientPayload(record.payload), wardrobes };
    setLookSaving(true);
    const updated = await updateCatalogIngredient(submittedId, { payload: nextPayload }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to save looks'); return null; });
    setLookSaving(false);
    if (activeVisitRef.current.id !== submittedId || !updated) return false;
    const persisted = Object.hasOwn(updated, 'payload') ? ingredientPayload(updated.payload) : nextPayload;
    setRecord((prev) => (prev?.id === submittedId ? { ...prev, ...updated, payload: persisted } : prev));
    setPayload((cur) => ({ ...cur, wardrobes: persisted.wardrobes }));
    refreshRevisions();
    return true;
  }, [record, refreshRevisions, identityReadOnly, activeVisitRef, setLookSaving, setRecord, setPayload]);

  // The Greybox, Photoreal and World tabs save straight onto the SAVED payload; copy just
  // those keys into the draft so the next profile Save does not write the old
  // layout or look back.
  const handleGreyboxSaved = useCallback((updated) => {
    const persisted = ingredientPayload(updated.payload);
    setRecord((prev) => (prev?.id === updated.id ? { ...prev, ...updated, payload: persisted } : prev));
    setPayload((cur) => {
      const { greybox: _greybox, photoreal: _photoreal, world: _world, ...rest } = cur;
      return {
        ...rest,
        ...(persisted.greybox ? { greybox: persisted.greybox } : {}),
        ...(persisted.photoreal ? { photoreal: persisted.photoreal } : {}),
        ...(persisted.world ? { world: persisted.world } : {}),
      };
    });
    refreshRevisions();
  }, [refreshRevisions, setRecord, setPayload]);

  // A universe-delegated sheet landed as a canon pointer, which the canon→catalog
  // projection already copied onto this row. Pull just the pointer fields into
  // both the saved record and the draft.
  // `updatedAt` is the row's clock after the change, so its own
  // catalog:primitive-changed echo is not mistaken for an external edit.
  const applySheetPointers = useCallback((recordId, fresh, updatedAt) => {
    const pointers = {};
    for (const key of SHEET_POINTER_KEYS) {
      if (Object.hasOwn(fresh, key)) pointers[key] = fresh[key];
    }
    setRecord((prev) => (prev?.id === recordId
      ? { ...prev, ...(updatedAt ? { updatedAt } : {}), payload: { ...ingredientPayload(prev.payload), ...pointers } }
      : prev));
    setPayload((cur) => ({ ...cur, ...pointers }));
  }, [setRecord, setPayload]);
  const refreshSheetPointers = useCallback(() => {
    if (!id) return;
    const requestedId = id;
    const sequence = ++sheetPointerSequence.current;
    const isCurrentRequest = () => mountedRef.current && activeVisitRef.current.id === requestedId
      && sequence === sheetPointerSequence.current;
    getCatalogIngredientDetails(id, { silent: true, view: detailView })
      .then((d) => {
        if (!isCurrentRequest() || !d?.ingredient) return;
        applySheetPointers(requestedId, ingredientPayload(d.ingredient.payload));
        toast.success('Reference sheet ready');
      })
      .catch(() => { if (isCurrentRequest()) toast.error('Reference sheet rendered — reload to see it'); });
  }, [id, detailView, mountedRef, activeVisitRef, applySheetPointers]);
  // Removing a universe sheet runs here, not in the Sheets tab, so the
  // one-at-a-time flag and the answer survive the tab unmounting. The answer's
  // clock is adopted only when this page held the row's clock from just before
  // the removal. Otherwise the record changed elsewhere too: the pointers still
  // apply, and the full record is re-read and goes through the same
  // external-change check as a socket refresh.
  const [removingPointerSheet, setRemovingPointerSheet] = useState(null);
  const removingPointerSheetRef = useRef(null);
  const handleRemovePointerSheet = useCallback(async (variant, filename) => {
    if (!id || removingPointerSheetRef.current) return;
    const recordId = id;
    removingPointerSheetRef.current = filename;
    setRemovingPointerSheet(filename);
    const result = await removeCatalogPointerSheet(recordId, variant, filename, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not remove the sheet'); return null; });
    removingPointerSheetRef.current = null;
    if (!mountedRef.current) return;
    setRemovingPointerSheet(null);
    if (!result?.pointers || activeVisitRef.current.id !== recordId) return;
    toast.success('Reference sheet removed');
    ++sheetPointerSequence.current;
    const adopt = !!result.priorUpdatedAt && result.priorUpdatedAt === editSnapshot.current?.updatedAt;
    applySheetPointers(recordId, result.pointers, adopt ? result.updatedAt : undefined);
    if (adopt) return;
    const details = await getCatalogIngredientDetails(recordId, { silent: true, view: detailView }).catch(() => null);
    if (!mountedRef.current || activeVisitRef.current.id !== recordId || !details?.ingredient) return;
    if (details.ingredient.updatedAt === editSnapshot.current?.updatedAt) return;
    if (editSnapshot.current?.dirty) setExternalDetails(details);
    else applyDetails(details);
  }, [id, applySheetPointers, applyDetails, detailView, mountedRef, activeVisitRef, editSnapshot, setExternalDetails]);

  return {
    saveWardrobes: handleSaveWardrobes, greyboxSaved: handleGreyboxSaved,
    refreshSheetPointers, removePointerSheet: handleRemovePointerSheet, removingPointerSheet,
  };
}
