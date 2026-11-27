import { useEffect, useRef, useState } from 'react';
import toast from '../ui/Toast';
import { readFileAsBase64 } from '../../utils/fileUpload';
import { captureCatalogGreyboxShot, renderCatalogGreyboxShot, detachCatalogIngredientMedia, uploadCatalogIngredientMediaFile, draftCatalogGreybox, previewCatalogGreyboxPrompt, saveCatalogGreybox } from '../../services/apiCatalog';
import { formatCount } from '../../utils/formatters';
import { blankGreybox, shotFromCamera, withShot, withoutShot, roundVec, greyboxEditErrors } from '../../lib/greybox';

const EMPTY_LLM = { providerId: '', model: '', effort: '' };

// Identity reads group media by its owning ingredient before recency. A
// retained source's older export can therefore precede the replacement on the
// surviving identity. Use the newest attachment consistently after refreshes
// and remounts, even when detaching the previous export failed.
const latestModel = (media = []) => media.filter((row) => row.kind === 'model' && !row.deleted)
  .reduce((latest, row) => !latest || (row.createdAt || '') > (latest.createdAt || '') ? row : latest, null);

export default function useGreyboxActions({
  record, media, locked, disabled, viewerRef, shotId, selectShot, lens, aspect, onBusyChange, onSaved, onCaptured,
}) {
  const [modelOverride, setModelOverride] = useState(null);
  const syncedModel = latestModel(media || []);
  const model = modelOverride?.recordId === record.id ? modelOverride.row : syncedModel;
  const saved = record.payload?.greybox ?? null;
  const [draft, setDraft] = useState(null);
  const [manual, setManual] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [llm, setLlm] = useState(EMPTY_LLM);
  const [fromScratch, setFromScratch] = useState(false);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const actionInFlight = useRef(false);

  useEffect(() => {
    if (modelOverride?.recordId !== record.id) return;
    if (modelOverride.row ? syncedModel?.mediaKey === modelOverride.row.mediaKey : !syncedModel) setModelOverride(null);
  }, [record.id, syncedModel, modelOverride]);

  const scene = draft?.greybox || manual || saved;
  const editErrors = manual ? greyboxEditErrors(manual) : [];
  const shot = scene?.shots?.find((s) => s.id === shotId) || null;
  const blocked = !!busy || disabled;

  // The prompt a draft would send, composed by the server, shown before the
  // button is pressed. Debounced; a superseded response is dropped.
  useEffect(() => {
    if (!instruction.trim()) { setPreview(null); return undefined; }
    let active = true;
    const timer = setTimeout(() => {
      previewCatalogGreyboxPrompt(record.id, { instruction, useCurrent: Boolean(saved) && !fromScratch }, { silent: true })
        .then((res) => { if (active) setPreview(res); })
        .catch(() => { if (active) setPreview(null); });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [record.id, record.updatedAt, instruction, fromScratch, saved]);

  const persist = async (nextScene, { source } = {}) => {
    const updated = await saveCatalogGreybox(record.id, nextScene, { source, silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to save the greybox'); return null; });
    if (updated) onSaved(updated);
    return updated;
  };

  // The parent holds its Save while a write is in flight. It is told directly (not
  // via an effect) so the release still fires if the tab was left mid-write.
  const run = (name, fn) => {
    if (actionInFlight.current || disabled) return Promise.resolve();
    actionInFlight.current = true;
    setBusy(name);
    onBusyChange?.(true);
    return fn().finally(() => {
      setBusy('');
      actionInFlight.current = false;
      onBusyChange?.(false);
    });
  };

  const saveManual = () => run('manual', async () => {
    if (!manual || greyboxEditErrors(manual).length) return;
    if (await persist(manual)) setManual(null);
  });

  const moveAnchor = (id, position) => {
    if (locked || blocked || draft) return;
    setManual((prev) => {
      const current = prev || saved;
      return { ...current, anchors: current.anchors.map((anchor) => anchor.id === id ? { ...anchor, position } : anchor) };
    });
  };

  const currentView = () => {
    const view = viewerRef.current?.getView();
    return view ? { position: roundVec(view.position), target: roundVec(view.target) } : null;
  };

  const saveNewShot = (name) => run('shot', async () => {
    const view = currentView();
    if (!view || !saved) return;
    const created = shotFromCamera(saved, { label: name, ...view, focalLengthMm: lens, aspect });
    if (!(await persist(withShot(saved, created)))) return false;
    selectShot(created.id);
    return true;
  });

  // The selected shot as framed in the viewer right now.
  const framedShot = () => {
    const view = currentView();
    return view && shot ? { ...shot, ...view, focalLengthMm: Math.round(lens), aspect } : null;
  };

  const updateShotView = () => run('shot', async () => {
    const next = framedShot();
    if (next && saved) await persist(withShot(saved, next));
  });

  const captureShot = () => run('capture', async () => {
    if (!shot || !saved) return;
    // Snapshot the pixels and the framing together, before any await, so a camera
    // move or shot change while saving cannot change what is uploaded.
    const next = framedShot();
    const dataUrl = viewerRef.current?.capture();
    if (!dataUrl) { toast.error('Wait for the Blender model to finish loading before capturing.'); return; }
    // Save the camera first when it moved, so the capture matches the saved shot.
    if (next && JSON.stringify(next) !== JSON.stringify(shot) && !(await persist(withShot(saved, next)))) return;
    const row = await captureCatalogGreyboxShot(record.id, shot.id, dataUrl.split(',')[1], { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to save the reference'); return null; });
    if (row) {
      toast.success(`Saved "${shot.label}" as a reference image`);
      onCaptured?.();
    }
  });

  const recaptureAll = () => run('recapture', async () => {
    if (locked || draft || manual || saved?.source !== 'spec' || !saved?.shots.length) return;
    let captured = 0;
    // Use saved cameras, not the currently orbited/unsaved view. Stop at the
    // first failure and report the prefix that was replaced; never retry a shot.
    for (const savedShot of saved.shots) {
      const row = await renderCatalogGreyboxShot(record.id, savedShot.id, { silent: true })
        .catch((err) => {
          toast.error(`Captured ${formatCount(captured)} of ${formatCount(saved.shots.length)} shots. “${savedShot.label}” failed: ${err?.message || 'Could not render'}; remaining shots were not changed.`);
          return null;
        });
      if (!row) break;
      captured++;
      onCaptured?.();
    }
    if (captured === saved.shots.length) toast.success(`Re-captured ${formatCount(captured)} shot${captured === 1 ? '' : 's'}`);
  });

  const removeShot = () => run('removeShot', async () => {
    if (locked || draft || manual || !shot || !saved) return;
    if (!(await persist(withoutShot(saved, shot.id)))) return false;
    selectShot('');
    return true;
  });

  const removeGreybox = () => run('remove', async () => {
    if (!(await persist(null))) return false;
    setDraft(null);
    selectShot('');
    toast.success('Greybox removed');
    return true;
  });

  const startBlank = () => run('blank', () => persist(blankGreybox()));

  const startStarter = (starter) => run(starter.id, async () => {
    if (await persist(structuredClone(starter.scene))) selectShot(starter.scene.shots[0].id);
  });

  const generate = () => run('draft', async () => {
    const res = await draftCatalogGreybox(record.id, {
      instruction, ...llm, useCurrent: Boolean(saved) && !fromScratch,
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'The model could not make a greybox'); return null; });
    if (res) setDraft(res);
  });

  const applyDraft = () => run('apply', async () => {
    if (await persist(draft.greybox, { source: 'refine' })) {
      setDraft(null);
      setInstruction('');
      toast.success('Greybox saved');
    }
  });

  const attachModel = (file) => run('model', async () => {
    if (!file) return;
    if (!/\.glb$/i.test(file.name) || file.size > 24 * 1024 * 1024) {
      toast.error('Choose a .glb file up to 24 MB.');
      return;
    }
    const row = await readFileAsBase64(file)
      .then((dataBase64) => uploadCatalogIngredientMediaFile(record.id, { dataBase64, mimeType: 'model/gltf-binary', filename: file.name, role: 'greybox-model' }, { silent: true }))
      .catch((err) => { toast.error(err?.message || 'Failed to attach the model'); return null; });
    if (!row) return;
    setModelOverride({ recordId: record.id, row });
    onCaptured?.();
    if (!(await persist({ ...(saved || blankGreybox()), source: 'glb' }))) return;
    if (model && model.mediaKey !== row.mediaKey) {
      await detachCatalogIngredientMedia(record.id, { mediaKey: model.mediaKey, kind: 'model' }, { silent: true })
        .catch((err) => toast.error(err?.message || 'The previous model could not be detached'));
      onCaptured?.();
    }
  });

  const removeModel = () => run('removeModel', async () => {
    if (locked || manual || draft || !model) return;
    // Switch first so a failed detach leaves a recoverable, attached model.
    if (saved?.source === 'glb' && !(await persist({ ...saved, source: 'spec', parts: saved.parts.length ? saved.parts : blankGreybox().parts }))) return;
    const removed = await detachCatalogIngredientMedia(record.id, { mediaKey: model.mediaKey, kind: 'model' }, { silent: true })
      .then(() => true).catch((err) => { toast.error(err?.message || 'Failed to detach the model'); return false; });
    if (removed) {
      setModelOverride({ recordId: record.id, row: null });
      onCaptured?.();
    }
  });

  const setPlate = (plate) => run('shot', async () => {
    if (!shot || !saved) return;
    const { plate: _previous, ...rest } = saved.shots.find((s) => s.id === shot.id) || shot;
    await persist(withShot(saved, plate ? { ...rest, plate } : rest));
  });

  const setSource = (source) => run('source', () => persist({
    ...saved, source, parts: source === 'spec' && !saved.parts.length ? blankGreybox().parts : saved.parts,
  }));

  return {
    model, saved, scene, shot, editErrors, manual, setManual, busy, blocked,
    saveManual, moveAnchor, saveNewShot, updateShotView, captureShot, recaptureAll, removeShot,
    removeGreybox, startBlank, startStarter, attachModel, removeModel, setSource, setPlate,
    ai: { draft, setDraft, instruction, setInstruction, llm, setLlm, fromScratch, setFromScratch, preview, generate, applyDraft },
  };
}
