// Media mutations for a catalog ingredient (attach, portrait, detach, upload,
// voice memo, roles, generated/sheet/look renders) and the quick-edit renders
// still in flight, which persist per ingredient in session storage.

import { useCallback, useEffect, useState } from 'react';
import toast from '../../ui/Toast';
import {
  attachCatalogIngredientMedia,
  setCatalogIngredientPortrait,
  attachCatalogIngredientGeneratedImage,
  detachCatalogIngredientMedia,
  uploadCatalogIngredientMediaFile,
  recordCatalogIngredientVoiceMemo,
  updateCatalogIngredientMediaLibrary,
} from '../../../services/apiCatalog';
import { arrayBufferToBase64 } from '../../../lib/audioRecorder';
import { safeReadJsonSession, safeWriteJsonSession, safeRemoveSession } from '../../../lib/safeStorage';

export default function useIngredientMediaActions({ id, record, identityReadOnly, media, setMedia, refreshMedia }) {
  // Attach a media key (gallery filename) as a typed attachment. `kind` defaults
  // to 'reference' for drag-drop / picker; the "set portrait" path routes
  // through handleSetPortrait instead. Optimistic — prepend then reconcile.
  const handleAttachMedia = async (mediaKey, kind = 'reference') => {
    if (!record || identityReadOnly || !mediaKey) return;
    const ok = await attachCatalogIngredientMedia(record.id, { mediaKey, kind }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to attach media'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('Media attached');
  };

  const handleSetPortrait = async (mediaKey) => {
    if (!record || identityReadOnly || !mediaKey) return;
    const ok = await setCatalogIngredientPortrait(record.id, { mediaKey }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to set portrait'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('Canonical image set');
  };

  const handleDetachMedia = async (mediaKey, kind) => {
    if (!record || identityReadOnly) return;
    const ok = await detachCatalogIngredientMedia(record.id, { mediaKey, kind }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to detach media'); return false; });
    if (!ok) return;
    setMedia((prev) => prev.filter((m) => !(m.mediaKey === mediaKey && m.kind === kind)));
  };

  // A freshly-generated image lands in the media library as `<jobId>.png`; wire
  // it onto this ingredient. The server decides under the ingredient lock: the
  // first image becomes the portrait (so it shows as the card thumbnail
  // immediately), later ones references, and a render the completion hook
  // already filed is left as is (#13833).
  const handleGeneratedImage = useCallback(async (filename) => {
    if (!record || identityReadOnly || !filename) return;
    const result = await attachCatalogIngredientGeneratedImage(record.id, { mediaKey: filename }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to attach generated image'); return null; });
    if (!result) return;
    refreshMedia();
    toast.success(result.kind === 'portrait' ? 'Generated portrait set' : 'Generated image attached');
  }, [record, refreshMedia, identityReadOnly]);

  // A film-look copy saved from one of this record's images joins its
  // references, carrying the source's form, age and tags so library filters
  // keep it beside the original. Images from elsewhere stay gallery-only.
  const handleVariantSaved = useCallback(async (variant, source) => {
    if (!record || identityReadOnly || !variant?.filename) return;
    const rows = media.filter((m) => !m.deleted && m.mediaKey === source?.filename && (m.kind === 'reference' || m.kind === 'portrait'));
    if (rows.length === 0) return;
    const ok = await attachCatalogIngredientMedia(record.id, { mediaKey: variant.filename, kind: 'reference' }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Could not add the copy to references'); return false; });
    if (!ok) return;
    const library = (rows.find((m) => m.kind === 'reference') || rows[0]).library || {};
    const variantFields = Object.fromEntries(['age', 'era', 'wardrobeId', 'formId', 'label']
      .filter((field) => library.variant?.[field] !== undefined).map((field) => [field, library.variant[field]]));
    const carried = {
      ...(Object.keys(variantFields).length > 0 ? { variant: variantFields } : {}),
      ...(library.tags?.length ? { tags: library.tags } : {}),
    };
    if (Object.keys(carried).length > 0) {
      await updateCatalogIngredientMediaLibrary(record.id, { mediaKey: variant.filename, kind: 'reference', ...carried }, { silent: true })
        .catch((err) => toast.error(err?.message || 'Could not copy the reference details'));
    }
    refreshMedia();
    toast.success('Filtered copy added to references');
  }, [record, media, refreshMedia, identityReadOnly]);

  const [pendingRenders, setPendingRenders] = useState(() => (
    id ? (safeReadJsonSession(`catalog_pending_renders_${id}`, []) || []) : []
  ));

  useEffect(() => {
    if (!id) return;
    if (pendingRenders.length > 0) {
      safeWriteJsonSession(`catalog_pending_renders_${id}`, pendingRenders);
    } else {
      safeRemoveSession(`catalog_pending_renders_${id}`);
    }
  }, [id, pendingRenders]);

  const handleQuickEditQueued = useCallback((result, { item, instruction } = {}) => {
    if (!result) return;
    if (result.jobId) {
      setPendingRenders((prev) => [
        ...prev.filter(p => p.jobId !== result.jobId),
        {
          jobId: result.jobId,
          ingredientId: record?.id || id,
          instruction: instruction || '',
          sourceFilename: item?.filename || '',
          startedAt: Date.now(),
        },
      ]);
    } else if (result.filename) {
      handleGeneratedImage(result.filename);
    }
  }, [record?.id, id, handleGeneratedImage]);

  const handlePendingRenderComplete = useCallback(async (jobId, filename) => {
    setPendingRenders((prev) => prev.filter(p => p.jobId !== jobId));
    if (filename) {
      await handleGeneratedImage(filename);
    }
  }, [handleGeneratedImage]);

  const handlePendingRenderFailed = useCallback((jobId, status, error) => {
    setPendingRenders((prev) => prev.filter(p => p.jobId !== jobId));
    if (error) toast.error(error);
    else if (status === 'canceled') toast.error('Render canceled');
    else toast.error('Render failed');
  }, []);

  // Upload a dropped/picked file straight onto the ingredient. The server picks
  // the media kind (image→reference, audio, video) from the MIME and stores the
  // bytes in the matching federating library dir. Reconcile via refreshMedia.
  const handleUploadFile = useCallback(async (file) => {
    if (!record || identityReadOnly || !file) return false;
    try {
      const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
      await uploadCatalogIngredientMediaFile(
        record.id,
        { dataBase64, mimeType: file.type || 'application/octet-stream', filename: file.name },
        { silent: true },
      );
      refreshMedia();
      toast.success('File attached');
      return true;
    } catch (err) {
      toast.error(err?.message || 'Upload failed');
      return false;
    }
  }, [record, refreshMedia, identityReadOnly]);

  // Attach a recorded voice memo — the server transcribes it via Whisper and
  // stores the transcript in the audio row's caption.
  const handleRecordVoiceMemo = useCallback(async (clip) => {
    if (!record || identityReadOnly || !clip?.audioBase64) return;
    const ok = await recordCatalogIngredientVoiceMemo(
      record.id,
      { audioBase64: clip.audioBase64, mimeType: clip.mimeType },
      { silent: true },
    ).then(() => true).catch((err) => { toast.error(err?.message || 'Voice memo failed'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('Voice memo attached');
  }, [record, refreshMedia, identityReadOnly]);

  // Re-attach an existing media row under a new role (mark/unmark a plate, add
  // an image to a look). The attach endpoint upserts role/caption on the
  // (ingredient, key, kind) row, so the caption is passed back unchanged.
  const handleSetMediaRole = useCallback(async (m, role, message) => {
    if (!record || identityReadOnly || m?.readOnly || !m?.mediaKey) return false;
    // A role never goes on the portrait row: using the portrait for a look
    // files a reference copy of the same image and leaves the portrait as is.
    const copyPortrait = m.kind === 'portrait';
    const updated = await attachCatalogIngredientMedia(
      record.id,
      { mediaKey: m.mediaKey, kind: copyPortrait ? 'reference' : m.kind, role, caption: m.caption ?? null },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Failed to update media'); return null; });
    if (!updated) return false;
    if (copyPortrait) refreshMedia();
    else setMedia((prev) => prev.map((row) => (
      row.mediaKey === m.mediaKey && row.kind === m.kind ? { ...row, ...updated, role } : row
    )));
    toast.success(message || (role ? 'Marked as plate' : 'Plate unmarked'));
    return true;
  }, [record, identityReadOnly, refreshMedia, setMedia]);

  // A finished catalog-only sheet render: attach it under its `sheet:<variant>`
  // role right away (the server-side attach hook files the same row and is
  // idempotent against this), then reconcile the media list.
  const handleSheetFile = useCallback(async (filename, role, readyMessage = 'Reference sheet ready') => {
    if (!record || identityReadOnly || !filename) return false;
    const ok = await attachCatalogIngredientMedia(record.id, { mediaKey: filename, kind: 'reference', role }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to attach the rendered image'); return false; });
    refreshMedia();
    if (ok) toast.success(readyMessage);
    return ok;
  }, [record, refreshMedia, identityReadOnly]);
  const handleLookFile = useCallback((filename, role) => handleSheetFile(filename, role, 'Look ready'), [handleSheetFile]);

  return {
    attach: handleAttachMedia, setPortrait: handleSetPortrait, detach: handleDetachMedia,
    generated: handleGeneratedImage, variantSaved: handleVariantSaved, quickEditQueued: handleQuickEditQueued,
    pendingRenders: pendingRenders.filter(p => !p.ingredientId || p.ingredientId === record?.id),
    pendingComplete: handlePendingRenderComplete, pendingFailed: handlePendingRenderFailed,
    upload: handleUploadFile, recordVoice: handleRecordVoiceMemo, setRole: handleSetMediaRole,
    sheetFile: handleSheetFile, lookFile: handleLookFile,
  };
}
