import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Loader2, Plus } from 'lucide-react';
import { GREYBOX_STARTERS } from '../../lib/greyboxStarters';
import { GREYBOX_ASPECTS, DEFAULT_FOCAL_LENGTH_MM } from '../../lib/greybox';
import FilePickerButton from '../ui/FilePickerButton';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import GreyboxEditor from './GreyboxEditor';
import GreyboxShotsSidebar from './GreyboxShotsSidebar';
import GreyboxAiDraftCard, { GreyboxAiDraftPreview } from './GreyboxAiDraftCard';
import useGreyboxActions from './useGreyboxActions';

// three.js stays out of the main chunk: the viewer loads when the tab opens.
const GreyboxViewer = lazy(() => import('./GreyboxViewer'));

const actionButton = 'min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';

function ModelRemoval({ disabled, removing, onRemove }) {
  const [confirm, setConfirm] = useState(false);

  return confirm
    ? <ConfirmButtonPair className="flex-wrap" prompt="Remove the Blender model?" confirmText="Remove model"
      onConfirm={onRemove} onCancel={() => setConfirm(false)} busy={disabled} busyText={removing ? 'Removing…' : undefined} />
    : <button type="button" className={actionButton} disabled={disabled} onClick={() => setConfirm(true)}>Remove model</button>;
}

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
  const id = useId();
  const [lens, setLens] = useState(DEFAULT_FOCAL_LENGTH_MM);
  const [aspect, setAspect] = useState('16:9');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const selected = params.get('greyboxItem') || '';
  const shotId = params.get('shot') || '';
  const locked = readOnly || record.payload?.locked === true;

  const selectItem = (id) => setParams((prev) => { const next = new URLSearchParams(prev); if (id) next.set('greyboxItem', id); else next.delete('greyboxItem'); return next; }, { replace: true });

  const selectShot = (id) => setParams((prev) => { const next = new URLSearchParams(prev); if (id) next.set('shot', id); else next.delete('shot'); return next; }, { replace: true });

  const {
    model, saved, scene, shot, editErrors, manual, setManual, busy, blocked,
    saveManual, moveAnchor, saveNewShot, updateShotView, captureShot, recaptureAll, removeShot,
    removeGreybox, startBlank, startStarter, attachModel, removeModel, setSource, setPlate, ai,
  } = useGreyboxActions({
    record, media, locked, disabled, viewerRef, shotId, selectShot, lens, aspect, onBusyChange, onSaved, onCaptured,
  });
  const { draft } = ai;

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

  const confirmRemoveGreybox = async () => {
    if (await removeGreybox()) setConfirmRemove(false);
  };

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
            ? <ConfirmButtonPair prompt="Remove the greybox?" confirmText="Remove" onConfirm={confirmRemoveGreybox} onCancel={() => setConfirmRemove(false)} busy={busy === 'remove'} busyText="Removing…" />
            : <button type="button" className={`${actionButton} pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-port-accent`} onClick={() => setConfirmRemove(true)} disabled={blocked || !!manual}>Remove greybox</button>)}
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

      {draft && <GreyboxAiDraftPreview ai={ai} locked={locked} blocked={blocked} busy={busy} actionButton={actionButton} />}

      {!locked && <div className="flex flex-wrap items-center gap-2">
        <FilePickerButton accept=".glb,model/gltf-binary" className={actionButton} disabled={blocked || !!manual || !!draft}
          onChange={(event) => attachModel(event.target.files?.[0])}>
          {model ? 'Replace Blender export (.glb)' : 'Attach Blender export (.glb)'}
        </FilePickerButton>
        {model && <>
          <ModelRemoval key={`${record.id}:${model.mediaKey}`} disabled={blocked || !!manual || !!draft}
            removing={busy === 'removeModel'} onRemove={removeModel} />
          {saved && <label htmlFor={`${id}-source`} className="text-xs text-gray-400">Layout source
            <select id={`${id}-source`} value={saved.source} disabled={blocked || !!manual || !!draft} className="ml-2 min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white"
              onChange={(event) => setSource(event.target.value)}>
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
              <label htmlFor={`${id}-lens`} className="text-xs text-gray-400">
                Lens: {Math.round(lens)} mm
                <input id={`${id}-lens`} type="range" min="14" max="135" step="1" value={lens} onChange={(e) => setLens(Number(e.target.value))} className="w-full" />
              </label>
              <label htmlFor={`${id}-aspect`} className="text-xs text-gray-400">
                Frame
                <select id={`${id}-aspect`} value={aspect} onChange={(e) => setAspect(e.target.value)} className="mt-1 block w-full min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white">
                  {GREYBOX_ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
            </div>
            <p className="text-xs text-gray-500">Drag to orbit, scroll to zoom, right-drag to pan. Drag an anchor to move it on the floor in 0.1 m steps; numeric fields also support precise placement. Faded anchors are excluded from the selected shot’s capture. Grid, pins and selection highlights are editor guides only.</p>
          </div>

          <GreyboxShotsSidebar key={record.id} shots={scene.shots} shot={shot} saved={saved} media={media} canEdit={!draft && !manual && !locked}
            blocked={blocked} busy={busy} actionButton={actionButton} selectShot={selectShot}
            saveNewShot={saveNewShot} updateShotView={updateShotView} captureShot={captureShot}
            recaptureAll={recaptureAll} removeShot={removeShot} setPlate={setPlate} />
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

      {!locked && <GreyboxAiDraftCard saved={saved} manual={manual} blocked={blocked} busy={busy} actionButton={actionButton} ai={ai} />}
    </section>
  );
}
