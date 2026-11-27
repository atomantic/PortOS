import { useState } from 'react';
import toast from '../ui/Toast';
import { verifyImageNow } from '../../services/apiImageVerifier';
import { addMediaCollectionItem, removeMediaCollectionItem } from '../../services/apiImageVideo.js';

export default function useCollectionBulkActions({
  collection, setCollection, selectedItems, setSelected, updateAnnotation, isUnsorted,
  pickerMode, setPickerMode, returningBulkFocus, exitSelectMode, refresh, refreshPage,
}) {
  const [bulkBusy, setBulkBusy] = useState(false);

  // Sequential — annotations and collections both do read-modify-write of a
  // single JSON file with no per-record lock; parallel writes lose updates.
  const bulkStar = async (starred) => {
    if (selectedItems.length === 0) return;
    setBulkBusy(true);
    let successCount = 0;
    let failedCount = 0;
    for (const it of selectedItems) {
      const { ok } = await updateAnnotation(it.key, { starred }, { silent: true });
      if (ok) successCount++; else failedCount++;
    }
    setBulkBusy(false);
    const verb = starred ? 'Favorited' : 'Unfavorited';
    if (failedCount === 0) {
      toast.success(`${verb} ${successCount} item${successCount === 1 ? '' : 's'}`);
    } else if (successCount === 0) {
      toast.error(`Failed to ${starred ? 'favorite' : 'unfavorite'} items`);
    } else {
      toast.error(`${verb} ${successCount} item${successCount === 1 ? '' : 's'}; ${failedCount} failed`);
    }
  };

  const bulkRemove = async () => {
    if (selectedItems.length === 0) return;
    returningBulkFocus.current = true;
    setBulkBusy(true);
    let lastOk = null;
    let failed = 0;
    for (const it of selectedItems) {
      const r = await removeMediaCollectionItem(collection.id, it.key, { silent: true }).catch(() => null);
      if (r) lastOk = r; else failed++;
    }
    if (lastOk) { setCollection(lastOk); refreshPage(); }
    setBulkBusy(false);
    exitSelectMode();
    if (failed) toast.error(`Removed ${selectedItems.length - failed}; ${failed} failed`);
    else toast.success(`Removed ${selectedItems.length} item${selectedItems.length === 1 ? '' : 's'} from "${collection.name}"`);
  };

  const bulkVerify = async () => {
    const imagesToVerify = selectedItems.filter((it) => it.kind === 'image' && it.filename);
    if (imagesToVerify.length === 0) {
      toast.info('No images selected for verification');
      return;
    }
    setBulkBusy(true);
    let passCount = 0;
    let failCount = 0;
    let errorCount = 0;
    for (const it of imagesToVerify) {
      try {
        const res = await verifyImageNow({
          filename: it.filename,
          profileId: 'strict_anatomy',
          prompt: it.prompt || '',
        }, { silent: true });
        if (res?.verdict === 'pass') passCount++;
        else if (res?.verdict === 'fail') failCount++;
      } catch {
        errorCount++;
      }
    }
    setBulkBusy(false);
    if (errorCount > 0) toast.warning(`Batch verification: ${passCount} passed, ${failCount} defect(s) flagged, ${errorCount} could not be verified.`);
    else toast.success(`Verified ${imagesToVerify.length} images: ${passCount} passed, ${failCount} defect(s) flagged.`);
    refreshPage();
  };

  const bulkMoveOrCopy = async (targetId, targetName) => {
    if (selectedItems.length === 0 || !pickerMode) return;
    const mode = pickerMode;
    returningBulkFocus.current = true;
    setPickerMode(null);
    setBulkBusy(true);
    const placedKeys = new Set();
    let added = 0;
    let dupes = 0;
    for (const it of selectedItems) {
      const ref = it.kind === 'video' ? it.id : it.filename;
      const r = await addMediaCollectionItem(targetId, { kind: it.kind, ref }, { silent: true }).catch((err) => {
        if (err?.code === 'DUPLICATE') { dupes++; placedKeys.add(it.key); return 'dupe'; }
        return null;
      });
      if (r && r !== 'dupe') { added++; placedKeys.add(it.key); }
    }
    // A move is two writes: add to the target, then remove from here. When the
    // second half fails the item now lives in BOTH collections — that is a
    // half-completed move, not a success, so track those keys separately from
    // the add failures and keep them selected for a retry.
    const removeFailedKeys = new Set();
    if (mode === 'move' && placedKeys.size > 0) {
      if (isUnsorted) {
        // Source is synthetic — placing items in any real collection takes
        // them out of Unsorted automatically. Just re-derive the view.
        await refresh();
      } else {
        let lastOk = null;
        for (const it of selectedItems) {
          if (!placedKeys.has(it.key)) continue;
          const r = await removeMediaCollectionItem(collection.id, it.key, { silent: true }).catch(() => null);
          if (r) lastOk = r; else removeFailedKeys.add(it.key);
        }
        // The last successful removal carries the authoritative server state,
        // so a partial failure still reconciles the items that did move out.
        if (lastOk) { setCollection(lastOk); refreshPage(); }
      }
    }
    setBulkBusy(false);
    if (removeFailedKeys.size > 0) {
      // Stay in select mode with only the half-moved items selected so the
      // user can re-run the move (or remove) on exactly what failed.
      setSelected(new Map(selectedItems.filter(item => removeFailedKeys.has(item.key)).map(item => [item.key, item])));
    } else {
      exitSelectMode();
    }
    const verb = mode === 'move' ? (isUnsorted ? 'Filed' : 'Moved') : 'Copied';
    const note = dupes > 0 ? ` (${dupes} already there)` : '';
    const stranded = selectedItems.length - added - dupes;
    const addNote = stranded > 0 ? `; ${stranded} failed to add` : '';
    if (removeFailedKeys.size > 0) {
      // Deliberately says "Copied" — calling a half-completed move a "Move"
      // is the false success this branch exists to prevent.
      toast.error(`Copied ${added} to "${targetName}"${note}, but ${removeFailedKeys.size} could not be removed from "${collection.name}"${addNote}`);
    } else if (stranded > 0) {
      toast.error(`${verb} ${added} to "${targetName}"${note}; ${stranded} failed`);
    } else {
      toast.success(`${verb} ${added} to "${targetName}"${note}`);
    }
  };

  return { bulkBusy, bulkStar, bulkRemove, bulkVerify, bulkMoveOrCopy };
}
