import { useId, useState } from 'react';
import { Camera, Loader2, Plus, Trash2 } from 'lucide-react';
import { captureForShot } from '../../lib/greybox';
import { formatCount } from '../../utils/formatters';
import { GREYBOX_SHOT_ROLE_PREFIX } from '../../../../server/lib/greyboxVocabulary.js';
import MediaImage from '../MediaImage';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import CollapsibleListItem from '../ui/CollapsibleListItem';

const iconActionButton = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg border border-port-border text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';

function ShotRemoval({ label, blocked, deleting, onRemove }) {
  const [confirm, setConfirm] = useState(false);

  return confirm
    ? <ConfirmButtonPair className="flex-wrap" prompt={`Delete shot “${label}”?`} confirmText="Delete shot"
      onConfirm={onRemove} onCancel={() => setConfirm(false)} busy={blocked} busyText={deleting ? 'Deleting…' : undefined} />
    : <button type="button" className={iconActionButton} onClick={() => setConfirm(true)} disabled={blocked} aria-label={`Delete shot ${label}`}>
      <Trash2 size={14} aria-hidden="true" />
    </button>;
}

export default function GreyboxShotsSidebar({
  shots, shot, saved, media, canEdit, blocked, busy, actionButton, selectShot,
  saveNewShot, updateShotView, captureShot, recaptureAll, removeShot, setPlate,
}) {
  const nameId = `${useId()}-new-shot`;
  const [newShotName, setNewShotName] = useState('');
  const [confirmRecapture, setConfirmRecapture] = useState(false);
  const [exitingShots, setExitingShots] = useState([]);
  const selectedCapture = shot ? captureForShot(media, shot.id) : null;
  // A finished photo of the place from this camera: music video shots that pick the camera send it.
  const plateChoices = (media || []).filter((m) => !m.deleted && m.kind === 'reference' && !m.role?.startsWith(GREYBOX_SHOT_ROLE_PREFIX)
    && /^[^/\\]+\.(png|jpe?g|webp)$/i.test(m.mediaKey));

  const saveView = async () => {
    if (await saveNewShot(newShotName)) setNewShotName('');
  };

  const confirmRecaptureAll = async () => {
    await recaptureAll();
    setConfirmRecapture(false);
  };

  const deleteSelectedShot = async () => {
    const index = shots.findIndex((item) => item.id === shot.id);
    if (await removeShot()) setExitingShots((previous) => [...previous, { shot, index }]);
  };
  const visibleShots = [...shots];
  for (const exiting of exitingShots) {
    if (!shots.some((item) => item.id === exiting.shot.id)) visibleShots.splice(exiting.index, 0, exiting.shot);
  }

  return (
    <div className="space-y-3 min-w-0">
      <h3 className="text-sm font-medium text-white">Shots</h3>
      {visibleShots.length === 0 && <p className="text-xs text-gray-400">No shots yet. Frame the view, name it, and save.</p>}
      <div role="list" aria-label="Saved shots">
        {visibleShots.map((s) => {
          const capture = captureForShot(media, s.id);
          return (
            <CollapsibleListItem key={s.id} role="listitem" spacing="0.25rem"
              removing={exitingShots.some((item) => item.shot.id === s.id)}
              onExited={() => setExitingShots((previous) => previous.filter((item) => item.shot.id !== s.id))}>
              <button type="button" aria-pressed={s.id === shot?.id} onClick={() => selectShot(s.id)}
                className={`w-full min-h-[44px] flex items-center gap-2 rounded-lg border px-2 text-left text-sm ${s.id === shot?.id ? 'border-port-accent text-white bg-port-accent/10' : 'border-port-border text-gray-300 hover:text-white'}`}>
                {capture
                  ? <MediaImage thumbnail src={`/data/images/${encodeURIComponent(capture.mediaKey)}`} alt="" loading="lazy" decoding="async" className="h-8 w-12 object-cover rounded" />
                  : <span className="h-8 w-12 rounded bg-port-bg border border-port-border flex items-center justify-center text-gray-500"><Camera size={14} aria-hidden="true" /></span>}
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className="text-[11px] text-gray-500">{s.focalLengthMm}mm · {s.aspect}</span>
              </button>
            </CollapsibleListItem>
          );
        })}
      </div>

      {shot && <button type="button" className={actionButton} onClick={() => selectShot('')}>Free view — show all anchors</button>}
      {canEdit && (
        <div className="space-y-2">
          {saved?.source === 'spec' && saved.shots.length > 0 && (confirmRecapture
            ? <div className="space-y-2">
              <p className="text-xs text-gray-400">Saved shots: {formatCount(saved.shots.length)}. Existing reference images to replace: {formatCount(saved.shots.filter((s) => captureForShot(media, s.id)).length)}. Saved camera angles will be used.</p>
              <ConfirmButtonPair confirmText="Re-capture all shots" onConfirm={confirmRecaptureAll} onCancel={() => setConfirmRecapture(false)}
                busy={blocked} busyText={busy === 'recapture' ? 'Capturing…' : undefined} tone="warning" className="flex-wrap" />
            </div>
            : <button type="button" className={actionButton} disabled={blocked} onClick={() => setConfirmRecapture(true)}>
              <Camera size={14} aria-hidden="true" />Re-capture all shots ({formatCount(saved.shots.length)})
            </button>)}
          <label htmlFor={nameId} className="block text-xs text-gray-400">New shot name</label>
          <div className="flex gap-2">
            <input id={nameId} value={newShotName} onChange={(e) => setNewShotName(e.target.value)} maxLength={120} placeholder="e.g. DJ booth, low angle"
              className="min-w-0 flex-1 min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white" />
            <button type="button" className={actionButton} onClick={saveView} disabled={blocked}>
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
              <ShotRemoval key={shot.id} label={shot.label} blocked={blocked} deleting={busy === 'removeShot'} onRemove={deleteSelectedShot} />
            </div>
          )}
          {shot && <p className="text-[11px] text-gray-500">Captures attach to this environment as a reference image tagged for this shot, ready to pick as an input to shot image generation.</p>}
          {shot && plateChoices.length > 0 && (
            <fieldset className="space-y-1" disabled={blocked}>
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
  );
}
