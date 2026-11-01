import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Camera, Check, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';
import toast from '../ui/Toast';
import { readFileAsBase64 } from '../../utils/fileUpload';
import { GREYBOX_STARTERS } from '../../lib/greyboxStarters';
import MusicVideoLlmPicker from '../musicVideo/MusicVideoLlmPicker';
import SentPromptPanel from '../media/SentPromptPanel';
import FilePickerButton from '../ui/FilePickerButton';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import GreyboxEditor from './GreyboxEditor';
import { captureCatalogGreyboxShot, renderCatalogGreyboxShot, detachCatalogIngredientMedia, uploadCatalogIngredientMediaFile, draftCatalogGreybox, previewCatalogGreyboxPrompt, saveCatalogGreybox } from '../../services/apiCatalog';
import { formatCount } from '../../utils/formatters';
import {
  GREYBOX_ASPECTS,
  DEFAULT_FOCAL_LENGTH_MM,
  blankGreybox,
  captureForShot,
  shotFromCamera,
  withShot,
  withoutShot,
  roundVec,
  greyboxEditErrors,
} from '../../lib/greybox';
import { GREYBOX_SHOT_ROLE_PREFIX } from '../../../../server/lib/greyboxVocabulary.js';
import MediaImage from '../MediaImage';

// three.js stays out of the main chunk: the viewer loads when the tab opens.
const GreyboxViewer = lazy(() => import('./GreyboxViewer'));

const actionButton = 'min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const EMPTY_LLM = { providerId: '', model: '', effort: '' };
const AUTO = 'Default — the active provider';

// Identity reads group media by its owning ingredient before recency. A
// retained source's older export can therefore precede the replacement on the
// surviving identity. Use the newest attachment consistently after refreshes
// and remounts, even when detaching the previous export failed.
const latestModel = (media = []) => media.filter((row) => row.kind === 'model' && !row.deleted)
  .reduce((latest, row) => !latest || (row.createdAt || '') > (latest.createdAt || '') ? row : latest, null);

/**
 * The Greybox tab of an Environment: orbit a coarse 3D layout of the place,
 * save camera angles as shots, capture a shot as a reference image on the
 * place, and have any provider › model › effort create or edit the layout.
 * The selected shot lives in the URL (`?shot=`). An AI draft is only a preview
 * until applied; every save goes through the server's scene validation.
 */
export default function GreyboxPanel({ record, media, readOnly = false, disabled = false, onBusyChange, onSaved, onCaptured }) {
  const [params, setParams] = useSearchParams();
  const viewerRef = useRef(null);
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
  const [lens, setLens] = useState(DEFAULT_FOCAL_LENGTH_MM);
  const [aspect, setAspect] = useState('16:9');
  const [newShotName, setNewShotName] = useState('');
  const [preview, setPreview] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRecapture, setConfirmRecapture] = useState(false);
  const actionInFlight = useRef(false);

  useEffect(() => {
    if (modelOverride?.recordId !== record.id) return;
    if (modelOverride.row ? syncedModel?.mediaKey === modelOverride.row.mediaKey : !syncedModel) setModelOverride(null);
  }, [record.id, syncedModel, modelOverride]);

  const scene = draft?.greybox || manual || saved;
  const editErrors = manual ? greyboxEditErrors(manual) : [];
  const selected = params.get('greyboxItem') || '';
  const shotId = params.get('shot') || '';
  const shot = scene?.shots?.find((s) => s.id === shotId) || null;
  const locked = readOnly || record.payload?.locked === true;
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

  // Selecting a shot (or a draft re-framing it) adopts its lens and aspect; the
  // viewer moves its own camera (`shotView`). A save re-creates the shot object
  // with the same framing, which changes nothing.
  const appliedShotKey = useRef(null);
  useEffect(() => {
    if (!shot) {
      appliedShotKey.current = null;
      return;
    }
    const key = `${shot.id}:${shot.focalLengthMm}:${shot.aspect}`;
    if (appliedShotKey.current === key) return;
    appliedShotKey.current = key;
    setLens(shot.focalLengthMm);
    setAspect(shot.aspect);
  }, [shot]);

  // The viewer applies it once per framing, so a new object after a save is harmless.
  const shotView = useMemo(() => (shot ? { id: shot.id, position: shot.position, target: shot.target } : null), [shot]);

  const selectItem = (id) => setParams((prev) => { const next = new URLSearchParams(prev); if (id) next.set('greyboxItem', id); else next.delete('greyboxItem'); return next; }, { replace: true });

  const selectShot = (id) => setParams((prev) => { const next = new URLSearchParams(prev); if (id) next.set('shot', id); else next.delete('shot'); return next; }, { replace: true });

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
    if (locked || blocked || draft || confirmRemove) return;
    setManual((prev) => {
      const current = prev || saved;
      return { ...current, anchors: current.anchors.map((anchor) => anchor.id === id ? { ...anchor, position } : anchor) };
    });
  };

  const currentView = () => {
    const view = viewerRef.current?.getView();
    return view ? { position: roundVec(view.position), target: roundVec(view.target) } : null;
  };

  const saveNewShot = () => run('shot', async () => {
    const view = currentView();
    if (!view || !saved) return;
    const created = shotFromCamera(saved, { label: newShotName, ...view, focalLengthMm: lens, aspect });
    if (await persist(withShot(saved, created))) {
      setNewShotName('');
      selectShot(created.id);
    }
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
    setConfirmRecapture(false);
    if (captured === saved.shots.length) toast.success(`Re-captured ${formatCount(captured)} shot${captured === 1 ? '' : 's'}`);
  });

  const removeShot = () => run('shot', async () => {
    if (!shot || !saved) return;
    if (await persist(withoutShot(saved, shot.id))) selectShot('');
  });

  const removeGreybox = () => run('remove', async () => {
    if (await persist(null)) {
      setConfirmRemove(false);
      setDraft(null);
      selectShot('');
      toast.success('Greybox removed');
    }
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

  const removeModel = () => run('model', async () => {
    if (!model) return;
    // Switch first so a failed detach leaves a recoverable, attached model.
    if (saved?.source === 'glb' && !(await persist({ ...saved, source: 'spec', parts: saved.parts.length ? saved.parts : blankGreybox().parts }))) return;
    const removed = await detachCatalogIngredientMedia(record.id, { mediaKey: model.mediaKey, kind: 'model' }, { silent: true })
      .then(() => true).catch((err) => { toast.error(err?.message || 'Failed to detach the model'); return false; });
    if (removed) {
      setModelOverride({ recordId: record.id, row: null });
      onCaptured?.();
    }
  });

  const selectedCapture = shot ? captureForShot(media, shot.id) : null;
  // A finished photo of the place from this camera: music video shots that pick the camera send it.
  const plateChoices = (media || []).filter((m) => !m.deleted && m.kind === 'reference' && !m.role?.startsWith(GREYBOX_SHOT_ROLE_PREFIX)
    && /^[^/\\]+\.(png|jpe?g|webp)$/i.test(m.mediaKey));
  const setPlate = (plate) => run('shot', async () => {
    if (!shot || !saved) return;
    const { plate: _previous, ...rest } = saved.shots.find((s) => s.id === shot.id) || shot;
    await persist(withShot(saved, plate ? { ...rest, plate } : rest));
  });
  const counts = scene ? [[scene.parts, 'part'], [scene.anchors, 'anchor'], [scene.shots, 'shot']]
    .map(([list, word]) => `${list.length} ${word}${list.length === 1 ? '' : 's'}`).join(' · ') : '';

  return (
    <section className="space-y-4" aria-label="Greybox">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Greybox layout</h2>
          <p className="text-xs text-gray-400">A coarse 3D layout of this place. Save camera angles as shots and capture them as reference images for shot generation.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {counts && <span className="text-xs text-gray-400">{counts}</span>}
          {saved && !locked && (confirmRemove
            ? <ConfirmButtonPair prompt="Remove the greybox?" confirmText="Remove" onConfirm={removeGreybox} onCancel={() => setConfirmRemove(false)} busy={busy === 'remove'} busyText="Removing…" />
            : <button type="button" className="text-xs text-gray-400 hover:text-white underline min-h-[32px]" onClick={() => setConfirmRemove(true)} disabled={blocked || !!manual}>Remove greybox</button>)}
        </div>
      </div>

      {!scene && (
        <div className="rounded-lg border border-dashed border-port-border p-4 text-sm text-gray-300 space-y-3">
          <p>No greybox yet. Choose a starter, start from a blank room, or describe it below and let a model draft it.</p>
          <button type="button" className={actionButton} onClick={startBlank} disabled={locked || blocked}>
            {busy === 'blank' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />} Start from a blank room
          </button>
          <div className="space-y-2" role="group" aria-label="Start from a starter">
            <h3 className="text-sm font-medium text-white">Start from a starter</h3>
            <p className="text-xs text-gray-400">Ready-made layouts and camera shots. No AI call needed.</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {GREYBOX_STARTERS.map((starter) => (
                <button key={starter.id} type="button" onClick={() => startStarter(starter)} disabled={locked || blocked}
                  className="min-h-[44px] min-w-0 rounded-lg border border-port-border p-3 text-left hover:border-port-accent/60 disabled:opacity-40">
                  <span className="flex items-center gap-2 text-sm font-medium text-white">
                    {busy === starter.id && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                    {starter.label}
                  </span>
                  <span className="mt-1 block text-xs text-gray-400">{starter.description}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {draft && (
        <div role="status" className="rounded-lg border border-port-accent/50 bg-port-accent/10 p-3 space-y-3">
          <p className="text-sm text-white">
            Draft preview, not saved yet ({draft.providerId}{draft.model ? ` › ${draft.model}` : ''}). {draft.edited ? 'This replaces the current layout.' : ''}
          </p>
          <SentPromptPanel prompt={instruction} sentPrompt={draft.sentPrompt} additions={draft.promptAdditions} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={actionButton} onClick={applyDraft} disabled={locked || blocked}>
              {busy === 'apply' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />} Apply draft
            </button>
            <button type="button" className={actionButton} onClick={() => setDraft(null)} disabled={blocked}>
              <X size={14} aria-hidden="true" /> Discard
            </button>
          </div>
        </div>
      )}

      {!locked && <div className="flex flex-wrap items-center gap-2">
        <FilePickerButton accept=".glb,model/gltf-binary" className={actionButton} disabled={blocked || !!manual || !!draft}
          onChange={(event) => attachModel(event.target.files?.[0])}>
          {model ? 'Replace Blender export (.glb)' : 'Attach Blender export (.glb)'}
        </FilePickerButton>
        {model && <>
          <button type="button" className={actionButton} disabled={blocked || !!manual || !!draft} onClick={removeModel}>Remove model</button>
          {saved && <label htmlFor="greybox-source" className="text-xs text-gray-400">Layout source
            <select id="greybox-source" value={saved.source} disabled={blocked || !!manual || !!draft} className="ml-2 min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white"
              onChange={(event) => { const source = event.target.value; void run('source', () => persist({ ...saved, source, parts: source === 'spec' && !saved.parts.length ? blankGreybox().parts : saved.parts })); }}>
              <option value="spec">Layout parts</option><option value="glb">Blender model</option>
            </select>
          </label>}
        </>}
      </div>}
      {scene?.source === 'glb' && !model && <p role="status" className="text-sm text-port-warning">The Blender model is missing or has not synced yet. Attach the export to render this layout.</p>}

      {scene && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3 min-w-0">
            <Suspense fallback={<div className="h-64 flex items-center justify-center text-sm text-gray-400"><Loader2 size={16} className="animate-spin mr-2" aria-hidden="true" />Loading viewer…</div>}>
              <GreyboxViewer key={record.id} ref={viewerRef} scene={editErrors.length ? saved : scene} modelSrc={model ? `/data/models/${encodeURIComponent(model.mediaKey)}` : null} aspect={aspect} focalLengthMm={lens} shotView={shotView}
                activeShot={shot} selected={selected} onSelect={selectItem} onMoveAnchor={!locked && !blocked && !draft && !confirmRemove ? moveAnchor : undefined} />
            </Suspense>
            <div className="grid gap-3 sm:grid-cols-2">
              <label htmlFor="greybox-lens" className="text-xs text-gray-400">
                Lens: {Math.round(lens)} mm
                <input id="greybox-lens" type="range" min="14" max="135" step="1" value={lens} onChange={(e) => setLens(Number(e.target.value))} className="w-full" />
              </label>
              <label htmlFor="greybox-aspect" className="text-xs text-gray-400">
                Frame
                <select id="greybox-aspect" value={aspect} onChange={(e) => setAspect(e.target.value)} className="mt-1 block w-full min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white">
                  {GREYBOX_ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
            </div>
            <p className="text-xs text-gray-500">Drag to orbit, scroll to zoom, right-drag to pan. Drag an anchor to move it on the floor in 0.1 m steps; numeric fields also support precise placement. Faded anchors are excluded from the selected shot’s capture. Grid, pins and selection highlights are editor guides only.</p>
          </div>

          <div className="space-y-3 min-w-0">
            <h3 className="text-sm font-medium text-white">Shots</h3>
            {scene.shots.length === 0 && <p className="text-xs text-gray-400">No shots yet. Frame the view, name it, and save.</p>}
            <ul className="space-y-1" aria-label="Saved shots">
              {scene.shots.map((s) => {
                const capture = captureForShot(media, s.id);
                return (
                  <li key={s.id}>
                    <button type="button" aria-pressed={s.id === shotId} onClick={() => selectShot(s.id)}
                      className={`w-full min-h-[44px] flex items-center gap-2 rounded-lg border px-2 text-left text-sm ${s.id === shotId ? 'border-port-accent text-white bg-port-accent/10' : 'border-port-border text-gray-300 hover:text-white'}`}>
                      {capture
                        ? <MediaImage thumbnail src={`/data/images/${encodeURIComponent(capture.mediaKey)}`} alt="" loading="lazy" decoding="async" className="h-8 w-12 object-cover rounded" />
                        : <span className="h-8 w-12 rounded bg-port-bg border border-port-border flex items-center justify-center text-gray-500"><Camera size={14} aria-hidden="true" /></span>}
                      <span className="min-w-0 flex-1 truncate">{s.label}</span>
                      <span className="text-[11px] text-gray-500">{s.focalLengthMm}mm · {s.aspect}</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {shot && <button type="button" className={actionButton} onClick={() => selectShot('')}>Free view — show all anchors</button>}
            {!draft && !manual && !locked && (
              <div className="space-y-2">
                {saved?.source === 'spec' && saved.shots.length > 0 && (confirmRecapture
                  ? <div className="space-y-2">
                    <p className="text-xs text-gray-400">Saved shots: {formatCount(saved.shots.length)}. Existing reference images to replace: {formatCount(saved.shots.filter((s) => captureForShot(media, s.id)).length)}. Saved camera angles will be used.</p>
                    <ConfirmButtonPair confirmText="Re-capture all shots" onConfirm={recaptureAll} onCancel={() => setConfirmRecapture(false)}
                      busy={blocked} busyText="Capturing…" tone="warning" className="flex-wrap" />
                  </div>
                  : <button type="button" className={actionButton} disabled={blocked} onClick={() => setConfirmRecapture(true)}>
                    <Camera size={14} aria-hidden="true" />Re-capture all shots ({formatCount(saved.shots.length)})
                  </button>)}
                <label htmlFor="greybox-new-shot" className="block text-xs text-gray-400">New shot name</label>
                <div className="flex gap-2">
                  <input id="greybox-new-shot" value={newShotName} onChange={(e) => setNewShotName(e.target.value)} maxLength={120} placeholder="e.g. DJ booth, low angle"
                    className="min-w-0 flex-1 min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white" />
                  <button type="button" className={actionButton} onClick={saveNewShot} disabled={blocked}>
                    {busy === 'shot' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />} Save view
                  </button>
                </div>
                {shot && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={actionButton} onClick={updateShotView} disabled={blocked}>Update “{shot.label}” to this view</button>
                    <button type="button" className={actionButton} onClick={captureShot} disabled={blocked}>
                      {busy === 'capture' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Camera size={14} aria-hidden="true" />}
                      {selectedCapture ? 'Replace reference image' : 'Capture reference image'}
                    </button>
                    <button type="button" className={actionButton} onClick={removeShot} disabled={blocked} aria-label={`Delete shot ${shot.label}`}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                )}
                {shot && <p className="text-[11px] text-gray-500">Captures attach to this environment as a reference image tagged for this shot, ready to pick as an input to shot image generation.</p>}
                {shot && plateChoices.length > 0 && (
                  <fieldset className="space-y-1" disabled={blocked || !!manual}>
                    <legend className="text-xs text-gray-400">Photo plate for “{shot.label}”: music video shots that pick this camera send it in place of the flat capture.</legend>
                    <ul className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Photo plate choices">
                      <li className="shrink-0">
                        <button type="button" aria-pressed={!shot.plate} onClick={() => setPlate(null)}
                          className={`h-12 px-2 rounded border text-[11px] ${!shot.plate ? 'border-port-accent text-white' : 'border-port-border text-gray-400'}`}>None</button>
                      </li>
                      {plateChoices.map((m) => (
                        <li key={m.mediaKey} className="shrink-0">
                          <button type="button" aria-pressed={shot.plate === m.mediaKey} aria-label={m.caption || m.mediaKey} onClick={() => setPlate(m.mediaKey)}
                            className={`block h-12 w-20 rounded overflow-hidden border ${shot.plate === m.mediaKey ? 'border-port-accent ring-1 ring-port-accent' : 'border-port-border'}`}>
                            <MediaImage thumbnail src={`/data/images/${encodeURIComponent(m.mediaKey)}`} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                )}
              </div>
            )}

          </div>
        </div>
      )}

      {saved && !draft && !locked && (
        <div className="space-y-3">
          {manual && <div className="rounded-lg border border-port-accent p-3 space-y-2" role="status">
            <p className="text-sm text-gray-200">Unsaved layout edits. Save before capturing a shot or using AI.</p>
            {editErrors.length > 0 && <ul className="text-sm text-port-warning" aria-label="Layout errors">{editErrors.map((error) => <li key={error}>{error}</li>)}</ul>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={actionButton} onClick={saveManual} disabled={blocked || editErrors.length > 0}>Save layout edits</button>
              <button type="button" className={actionButton} onClick={() => setManual(null)} disabled={blocked}>Discard layout edits</button>
            </div>
          </div>}
          <GreyboxEditor scene={manual || saved} shotId={shotId} selected={selected} onSelect={selectItem} onChange={setManual} disabled={blocked || confirmRemove} />
        </div>
      )}

      {!locked && (
        <div className="rounded-lg border border-port-border p-3 space-y-3">
          <h3 className="text-sm font-medium text-white flex items-center gap-1.5"><Sparkles size={14} aria-hidden="true" />{saved ? 'Edit with AI' : 'Create with AI'}</h3>
          <MusicVideoLlmPicker idPrefix="greybox" value={llm} onChange={setLlm} label="Provider › model › effort"
            emptyProviderOption={AUTO} fallbackName="The active provider" hint="Runs only when you tap the button. The place description and your words are sent as shown under Show full prompt." />
          <div>
            <label htmlFor="greybox-instruction" className="block text-xs text-gray-400 mb-1">
              {saved && !fromScratch ? 'What should change?' : 'Describe the layout'}
            </label>
            <textarea id="greybox-instruction" value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} maxLength={4000}
              placeholder={saved ? 'Move the DJ booth to the east wall and add a rental counter by the entrance' : 'An oval roller-skating rink, 30 by 14 meters, with a rail, a DJ booth, a snack bar and bench seating along the north wall'}
              className="w-full rounded-lg bg-port-bg border border-port-border p-2 text-sm text-white" />
          </div>
          {saved && (
            <label htmlFor="greybox-scratch" className="flex items-center gap-2 text-xs text-gray-300 min-h-[32px]">
              <input id="greybox-scratch" type="checkbox" checked={fromScratch} onChange={(e) => setFromScratch(e.target.checked)} />
              Start over instead of editing the current layout
            </label>
          )}
          {preview && <SentPromptPanel prompt={instruction} sentPrompt={preview.sentPrompt} additions={preview.promptAdditions} />}
          <button type="button" className={actionButton} onClick={generate} disabled={blocked || !!manual || !instruction.trim()}>
            {busy === 'draft' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
            {busy === 'draft' ? 'Drafting…' : saved && !fromScratch ? 'Draft the edit' : 'Draft a greybox'}
          </button>
        </div>
      )}
    </section>
  );
}
