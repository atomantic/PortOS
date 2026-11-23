import { memo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Film, Plus, RefreshCw, Trash2, Video } from 'lucide-react';
import GalleryVideoPicker from '../../videoGen/GalleryVideoPicker';
import toast from '../../ui/Toast';
import { uploadGalleryImage } from '../../../services/apiSystem.js';
import { blenderMotionReferenceLimits } from '../../../lib/musicVideoBlender.js';
import { useFilmApi } from './FilmApiContext.jsx';
import { buttonCls, inputCls, labelCls, primaryCls } from './blenderStyles.js';

const limits = blenderMotionReferenceLimits;
const num = (value) => (value === '' || value == null ? NaN : Number(value));
const sheetName = (file) => (typeof file === 'string' ? file.split('/').pop() : null);

/** The sheet tile the playhead is in, as a box over a grid of `columns` x `rows` tiles. */
function playheadBox({ sheet, fps, playheadSec }) {
  if (!sheet?.columns || !sheet.tiles || !(sheet.every > 0) || !(fps > 0) || !Number.isFinite(playheadSec)) return null;
  const index = Math.max(0, Math.min(sheet.tiles - 1, Math.floor((playheadSec * fps - sheet.firstFrame) / sheet.every)));
  const rows = Math.ceil(sheet.tiles / sheet.columns);
  return { left: `${(index % sheet.columns) * (100 / sheet.columns)}%`, top: `${Math.floor(index / sheet.columns) * (100 / rows)}%`, width: `${100 / sheet.columns}%`, height: `${100 / rows}%` };
}

function ReferenceRow({ reference, saving, onSave, onRemove }) {
  const [draft, setDraft] = useState({ inSec: String(reference.inSec), outSec: String(reference.outSec), speed: String(reference.speed), note: reference.note });
  const parsed = { ...reference, inSec: num(draft.inSec), outSec: num(draft.outSec), speed: num(draft.speed), note: draft.note };
  const valid = parsed.inSec >= 0 && parsed.outSec > parsed.inSec && parsed.speed >= limits.speed.min && parsed.speed <= limits.speed.max;
  const dirty = parsed.inSec !== reference.inSec || parsed.outSec !== reference.outSec || parsed.speed !== reference.speed || parsed.note !== reference.note;
  const set = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  const id = `mv-ref-${reference.id}`;
  return (
    <li className="min-w-0 space-y-1.5 rounded border border-port-border p-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5"><Film size={14} aria-hidden="true" className="shrink-0" /><span className="min-w-0 break-all font-mono">{reference.filename}</span></span>
        {reference.missing && <span role="status" className="text-port-warning">Video is no longer in Media History; the shot still renders</span>}
      </div>
      <div className="grid min-w-0 grid-cols-3 gap-2">
        <div><label htmlFor={`${id}-in`} className={labelCls}>In (s)</label><input id={`${id}-in`} type="number" min="0" step="0.1" value={draft.inSec} onChange={set('inSec')} className={inputCls} /></div>
        <div><label htmlFor={`${id}-out`} className={labelCls}>Out (s)</label><input id={`${id}-out`} type="number" min="0" step="0.1" value={draft.outSec} onChange={set('outSec')} className={inputCls} /></div>
        <div><label htmlFor={`${id}-speed`} className={labelCls}>Speed</label><input id={`${id}-speed`} type="number" min={limits.speed.min} max={limits.speed.max} step="0.25" value={draft.speed} onChange={set('speed')} className={inputCls} /></div>
      </div>
      <div>
        <label htmlFor={`${id}-note`} className={labelCls}>What to read from it</label>
        <input id={`${id}-note`} value={draft.note} maxLength={limits.noteMax} onChange={set('note')} placeholder="Read the footfall order" className={inputCls} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={primaryCls} disabled={!dirty || !valid || saving} onClick={() => onSave(parsed)}>{saving ? 'Saving…' : 'Save reference'}</button>
        <button type="button" className={buttonCls} disabled={saving} onClick={onRemove}><Trash2 size={14} aria-hidden="true" /> Remove</button>
        {!valid && <span role="alert" className="text-xs text-port-error">Out must be after in; speed is {limits.speed.min} to {limits.speed.max}</span>}
      </div>
    </li>
  );
}

/**
 * A shot's motion references, for timing only: they never enter a render, a cut or an out-of-date
 * check. Each one's strip is tiled on the newest contact sheet's grid (same columns, the sheet's
 * time step scaled by the reference's speed) and shown above that sheet, with the same
 * playhead tile marked on both.
 */
function BlenderMotionReferences({ blender, shot, sheet, still, playheadSec }) {
  const { musicVideoBlenderMediaUrl } = useFilmApi();
  const navigate = useNavigate();
  const { projectId, pending } = blender;
  const references = blender.state.motionReferences?.[shot.id] || [];
  const [picking, setPicking] = useState(false);
  const [opening, setOpening] = useState(false);
  const saving = !!pending[`refs:${shot.id}`];
  const box = playheadBox({ sheet, fps: blender.state.settings?.fps, playheadSec });
  const stored = (list) => list.map(({ id, filename, inSec, outSec, speed, note }) => ({ id, filename, inSec, outSec, speed, note }));

  const add = (item) => blender.saveMotionReferences(shot.id, [...stored(references), { filename: item.filename, inSec: 0, outSec: Math.min(limits.secMax, shot.end - shot.start), speed: 1, note: '' }]);
  const replace = (next) => blender.saveMotionReferences(shot.id, stored(references.map((ref) => (ref.id === next.id ? next : ref))));
  const remove = (id) => blender.saveMotionReferences(shot.id, stored(references.filter((ref) => ref.id !== id)));

  // The still becomes Video Gen's input image; nothing is queued and the prompt stays the user's to write.
  const makeReference = async () => {
    setOpening(true);
    try {
      const response = await fetch(musicVideoBlenderMediaUrl(projectId, still.file));
      if (!response.ok) throw new Error('The still could not be read');
      const saved = await uploadGalleryImage(new File([await response.blob()], sheetName(still.file), { type: 'image/png' }), { silent: true });
      navigate(`/video/generate?sourceImageFile=${encodeURIComponent(saved.filename)}`);
    } catch (error) {
      toast.error(error?.message || 'Could not open Video Gen');
    } finally {
      setOpening(false);
    }
  };

  const strips = references.filter((ref) => ref.strip && sheet);
  return (
    <section aria-label="Motion references" className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-xs text-port-text-muted">Motion references</h5>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={buttonCls} disabled={references.length >= limits.perShot || saving} onClick={() => setPicking(true)}
            title={references.length >= limits.perShot ? `A shot holds at most ${limits.perShot}` : 'Pick a Media History video to judge timing against'}>
            <Plus size={14} aria-hidden="true" /> Add reference
          </button>
          <button type="button" className={buttonCls} disabled={!still || opening} onClick={makeReference}
            title={still ? 'Opens Video Gen with this shot’s newest still as the input image; you write and submit the prompt' : 'Render a still first'}>
            <Video size={14} aria-hidden="true" /> {opening ? 'Opening…' : 'Make a motion reference'}
          </button>
        </div>
      </div>
      <GalleryVideoPicker open={picking} onClose={() => setPicking(false)} onSelect={(item) => { setPicking(false); add(item); }} />
      {references.length > 0 && (
        <ul className="space-y-1.5">
          {references.map((ref) => (
            <ReferenceRow key={`${ref.id}:${ref.inSec}:${ref.outSec}:${ref.speed}:${ref.note}`} reference={ref} saving={saving} onSave={replace} onRemove={() => remove(ref.id)} />
          ))}
        </ul>
      )}
      {strips.map((ref) => {
        const aligned = ref.strip.current && ref.strip.sheet === sheetName(sheet.file);
        const making = !!pending[`strip:${shot.id}:${ref.id}`];
        return (
          <figure key={ref.id} className="min-w-0 space-y-0.5">
            <div className="relative">
              <img src={`${musicVideoBlenderMediaUrl(projectId, ref.strip.file)}&v=${ref.strip.every}-${ref.strip.columns}-${ref.strip.sheet ?? ''}`} alt={`Motion reference strip: ${ref.filename}`} loading="lazy" decoding="async"
                className="w-full bg-black object-contain" />
              {box && <div aria-hidden="true" className="pointer-events-none absolute border-2 border-port-accent" style={box} />}
            </div>
            <figcaption className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-port-text-muted">
              <span>{ref.filename} at {ref.speed}x{ref.note ? `: ${ref.note}` : ''}</span>
              {!aligned && !ref.missing && (
                <button type="button" className={buttonCls} disabled={making} onClick={() => blender.makeMotionStrip(shot.id, ref.id, sheet.file)}>
                  <RefreshCw size={14} aria-hidden="true" /> {making ? 'Making…' : 'Line up with this sheet'}
                </button>
              )}
            </figcaption>
          </figure>
        );
      })}
    </section>
  );
}

export default memo(BlenderMotionReferences);
