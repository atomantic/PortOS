import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ChevronLeft, ChevronRight, Clapperboard, Drama, ImagePlus, ImageUp, Loader2, Mountain, Package, Palette, PenLine, Plus,
  StickyNote, Trash2, Users, Wand2, X,
} from 'lucide-react';
import Drawer from '../Drawer';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import IngredientPicker from '../IngredientPicker';
import useDrawerTab from '../../hooks/useDrawerTab';
import { listCatalogIngredientMedia, listCatalogIngredientsByIds } from '../../services/api';
import { STORYBOARD_LIMITS } from '../../../../server/lib/storyboardVocabulary.js';
import {
  SHOT_ANGLES, SHOT_ANGLE_HINTS, SHOT_ANGLE_LABELS, SHOT_COMPOSITIONS, SHOT_COMPOSITION_HINTS, SHOT_COMPOSITION_LABELS,
  SHOT_EYELINES, SHOT_EYELINE_HINTS, SHOT_EYELINE_LABELS, SHOT_FACINGS, SHOT_FACING_HINTS, SHOT_FACING_LABELS,
  SHOT_FOCUSES, SHOT_FOCUS_HINTS, SHOT_FOCUS_LABELS, SHOT_LENSES, SHOT_LENS_HINTS, SHOT_LENS_LABELS,
  SHOT_MOVES, SHOT_MOVE_HINTS, SHOT_MOVE_LABELS,
  SHOT_TYPES, SHOT_TYPE_HINTS, SHOT_TYPE_LABELS,
} from '../../lib/shotGrammar';
import CommitField from './CommitField';
import ShotDiagramPicker from './ShotDiagramPicker';
import MoodBoardPinPicker from './MoodBoardPinPicker';
import DrawPanelButton from './DrawPanelButton';
import PanelCorrection from './PanelCorrection';
import PanelMakeTab from './PanelMakeTab';
import PanelSongTiming from './PanelSongTiming';
import { aspectClass, selectedTake, takeSrc } from './storyboardArt';

const TABS = [
  { id: 'shot', label: 'Shot', icon: Clapperboard },
  { id: 'make', label: 'Prompts', icon: Wand2 },
  { id: 'cast', label: 'Cast & sets', icon: Users },
  { id: 'notes', label: 'Notes', icon: StickyNote },
];
const TAB_IDS = TABS.map((tab) => tab.id);

const REF_GROUPS = [
  { field: 'castIds', label: 'Cast', type: 'character', icon: Drama },
  { field: 'environmentIds', label: 'Environments', type: 'place', icon: Mountain },
  { field: 'objectIds', label: 'Objects', type: 'object', icon: Package },
];

// Shot pickers in panel order. `half` pickers have few options, so two share a row once there is width.
const SHOT_PICKERS = [
  { field: 'framing', label: 'Framing', options: SHOT_TYPES, labels: SHOT_TYPE_LABELS, hints: SHOT_TYPE_HINTS },
  { field: 'angle', label: 'Angle', options: SHOT_ANGLES, labels: SHOT_ANGLE_LABELS, hints: SHOT_ANGLE_HINTS },
  { field: 'facing', label: 'Subject to camera', options: SHOT_FACINGS, labels: SHOT_FACING_LABELS, hints: SHOT_FACING_HINTS },
  { field: 'eyeline', label: 'Eyeline', options: SHOT_EYELINES, labels: SHOT_EYELINE_LABELS, hints: SHOT_EYELINE_HINTS },
  { field: 'composition', label: 'Composition', options: SHOT_COMPOSITIONS, labels: SHOT_COMPOSITION_LABELS, hints: SHOT_COMPOSITION_HINTS },
  { field: 'lens', label: 'Lens', options: SHOT_LENSES, labels: SHOT_LENS_LABELS, hints: SHOT_LENS_HINTS, half: true },
  { field: 'focus', label: 'Focus', options: SHOT_FOCUSES, labels: SHOT_FOCUS_LABELS, hints: SHOT_FOCUS_HINTS, half: true },
  { field: 'move', label: 'Camera move (video)', options: SHOT_MOVES, labels: SHOT_MOVE_LABELS, hints: SHOT_MOVE_HINTS },
];

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const iconButton = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-30 disabled:pointer-events-none';
const labelClass = 'block text-[11px] text-gray-500 mb-0.5';

function ArtSection({ panel, aspectRatio, sketchNonce, moodBoardId, busy, onAddTake, onSelectTake, onRemoveTake, onSketch, onSendToScene, sendLabel, onCorrect }) {
  const [galleryOpen, setGalleryOpen] = useState(false);
  // `?correct=open` keeps the open correction across a reload or deep link.
  const [searchParams, setSearchParams] = useSearchParams();
  const correcting = searchParams.get('correct') === 'open';
  const setCorrecting = (on) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (on) next.set('correct', 'open');
    else next.delete('correct');
    return next;
  }, { replace: true });
  const [sending, setSending] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const take = selectedTake(panel);
  const src = takeSrc(take, sketchNonce(take?.sketchKey));
  const canCorrect = !!(onCorrect && take?.image);

  return (
    <div className="space-y-2">
      {canCorrect && correcting ? (
        <PanelCorrection key={take.id} take={take} onCorrect={onCorrect} onClose={() => setCorrecting(false)} />
      ) : (
        <div className={`${aspectClass(aspectRatio)} w-full rounded-lg border border-port-border bg-port-bg overflow-hidden flex items-center justify-center`}>
          {src ? (
            <img src={src} alt="Selected panel art" className="w-full h-full object-contain" />
          ) : (
            <p className="text-xs text-gray-500">No art yet</p>
          )}
        </div>
      )}
      {panel.takes.length > 1 ? (
        <ul className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Takes">
          {panel.takes.map((item, index) => (
            <li key={item.id} className="shrink-0">
              <button type="button" onClick={() => onSelectTake(item.id)}
                aria-label={`Take ${index + 1}`} aria-pressed={item.id === panel.selectedTakeId}
                className={`block w-16 h-11 rounded overflow-hidden border ${item.id === panel.selectedTakeId ? 'border-port-accent ring-1 ring-port-accent' : 'border-port-border'}`}>
                <img src={takeSrc(item, sketchNonce(item.sketchKey))} alt="" loading="lazy" className="w-full h-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {confirmRemove && take ? (
        <InlineConfirmRow
          question="Remove this take from the panel? The image stays in your gallery."
          confirmText="Remove"
          onConfirm={() => { setConfirmRemove(false); onRemoveTake(take.id); }}
          onCancel={() => setConfirmRemove(false)}
          autoFocus
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={actionButton} onClick={() => setGalleryOpen(true)} disabled={busy}>
          <ImagePlus size={16} aria-hidden="true" /> Pick or upload
        </button>
        {canCorrect ? (
          <button type="button" className={actionButton} onClick={() => setCorrecting(true)} disabled={busy || correcting}>
            <PenLine size={16} aria-hidden="true" /> Draw on frame
          </button>
        ) : (
          <button type="button" className={actionButton} onClick={onSketch} disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <PenLine size={16} aria-hidden="true" />} Sketch
          </button>
        )}
        {moodBoardId ? (
          <button type="button" className={actionButton} onClick={() => setPinsOpen(true)} disabled={busy}>
            <Palette size={16} aria-hidden="true" /> Mood board
          </button>
        ) : null}
        {onSendToScene && take?.image ? (
          <button type="button" className={actionButton} disabled={sending}
            onClick={async () => { setSending(true); await onSendToScene(); setSending(false); }}>
            {sending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <ImageUp size={16} aria-hidden="true" />} {sendLabel}
          </button>
        ) : null}
        {take ? (
          <button type="button" className={`${actionButton} ml-auto hover:text-port-error`} onClick={() => setConfirmRemove(true)}>
            <Trash2 size={16} aria-hidden="true" /> Take
          </button>
        ) : null}
      </div>
      <GalleryImagePicker
        open={galleryOpen}
        allowUpload
        onClose={() => setGalleryOpen(false)}
        onSelect={(image) => { if (image?.filename) onAddTake({ source: 'gallery', image: image.filename }); }}
      />
      <MoodBoardPinPicker
        open={pinsOpen}
        moodBoardId={moodBoardId}
        onClose={() => setPinsOpen(false)}
        onSelect={(pin) => onAddTake({ source: 'moodBoard', image: pin.filename, refId: moodBoardId })}
      />
    </div>
  );
}

function ShotTab({ board, found, panelNumber, sketchNonce, busy, handlers, timing, songTiming }) {
  const { panel, beat, beatIndex, index } = found;
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A panel made from a production's scene or shot can send its art back there.
  const sendLabel = board.source?.kind === 'fableloom' && panel.sourceSceneId ? 'Use as scene art'
    : board.source?.kind === 'pipeline' && panel.sourceShotId ? 'Use as shot art' : null;
  const fieldId = (name) => `panel-${panel.id}-${name}`;
  const [secondsDraft, setSecondsDraft] = useState(panel.seconds ?? '');
  useEffect(() => { setSecondsDraft(panel.seconds ?? ''); }, [panel.seconds]);

  const commitSeconds = () => {
    const raw = String(secondsDraft).trim();
    const next = raw === '' ? null : Number(raw);
    if (next !== null && (!Number.isFinite(next) || next <= 0 || next > STORYBOARD_LIMITS.panelSecondsMax)) {
      setSecondsDraft(panel.seconds ?? '');
      return;
    }
    if (next !== panel.seconds) handlers.onPatch({ seconds: next });
  };

  // A phone stacks everything in one column (art, words, pickers, then the rest);
  // a wide side panel puts the art and words beside the pickers so the whole shot fits.
  return (
    <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-5">
      <div className="contents lg:col-start-1 lg:row-start-1 lg:block lg:space-y-3">
        <ArtSection
          panel={panel}
          aspectRatio={board.aspectRatio}
          sketchNonce={sketchNonce}
          moodBoardId={board.moodBoardId}
          busy={busy}
          onAddTake={handlers.onAddTake}
          onSelectTake={handlers.onSelectTake}
          onRemoveTake={handlers.onRemoveTake}
          onSketch={handlers.onSketch}
          onCorrect={handlers.onCorrect}
          onSendToScene={sendLabel ? handlers.onSendToScene : null}
          sendLabel={sendLabel}
        />
        <div>
          <label htmlFor={fieldId('action')} className={labelClass}>Action</label>
          <CommitField id={fieldId('action')} multiline value={panel.action} maxLength={STORYBOARD_LIMITS.panelText}
            placeholder="What we see" onCommit={(action) => handlers.onPatch({ action })} />
        </div>
        {songTiming?.span ? (
          <PanelSongTiming panel={panel} span={songTiming.span} lyricCues={songTiming.lyricCues} onPatch={handlers.onPatch} />
        ) : null}
        {timing ? (
          <div>
            <label htmlFor={fieldId('dialogue')} className={labelClass}>Dialogue or lyric</label>
            <CommitField id={fieldId('dialogue')} multiline value={panel.dialogue} maxLength={STORYBOARD_LIMITS.panelText}
              onCommit={(dialogue) => handlers.onPatch({ dialogue })} />
          </div>
        ) : null}
      </div>
      <div className="order-1 grid grid-cols-2 gap-x-3 gap-y-2 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1">
        {SHOT_PICKERS.map(({ field, label, options, labels, hints, half }) => (
          <div key={field} className={half ? 'col-span-2 sm:col-span-1' : 'col-span-2'}>
            <ShotDiagramPicker label={label} options={options} labels={labels} hints={hints}
              value={panel[field]} labelId={fieldId(field)} onChange={(next) => handlers.onPatch({ [field]: next })} />
          </div>
        ))}
      </div>
      {/* Seconds, Draw panel and the panel's place: under the pickers on a phone, under the art on desktop. */}
      <div className="order-2 space-y-3 lg:order-none lg:col-start-1 lg:row-start-2">
        {timing ? (
          <div>
            <label htmlFor={fieldId('seconds')} className={labelClass}>Seconds (estimate)</label>
            <input id={fieldId('seconds')} type="number" inputMode="decimal" min="0.01" step="0.01" max={STORYBOARD_LIMITS.panelSecondsMax}
              value={secondsDraft} onChange={(event) => setSecondsDraft(event.target.value)} onBlur={commitSeconds}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
              className="w-full max-w-[10rem] min-h-[44px] bg-port-bg border border-port-border rounded px-2 text-sm text-white tabular-nums" />
          </div>
        ) : null}
        <DrawPanelButton panel={panel} onDraw={handlers.onDraw} disabled={busy} />
        <div className="flex flex-wrap items-center gap-2 border-t border-port-border pt-3">
          <button type="button" className={iconButton} onClick={() => handlers.onMove({ index: index - 1 })} disabled={index === 0} aria-label="Move panel earlier">
            <ChevronLeft size={18} />
          </button>
          <span className="text-xs text-gray-500 tabular-nums">Panel {panelNumber}</span>
          <button type="button" className={iconButton} onClick={() => handlers.onMove({ index: index + 1 })} disabled={index >= beat.panels.length - 1} aria-label="Move panel later">
            <ChevronRight size={18} />
          </button>
          {board.beats.length > 1 ? (
            <>
              <label htmlFor={fieldId('beat')} className="sr-only">Beat</label>
              <select id={fieldId('beat')} value={beat.id}
                onChange={(event) => handlers.onMove({ beatId: event.target.value, index: 10_000 })}
                className="min-h-[44px] max-w-[12rem] bg-port-bg border border-port-border rounded px-2 text-sm text-white">
                {board.beats.map((b, i) => <option key={b.id} value={b.id}>{`Beat ${i + 1}${b.title ? ` · ${b.title}` : ''}`}</option>)}
              </select>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={actionButton} onClick={() => handlers.onInsert(index)} disabled={busy}>
            <Plus size={16} aria-hidden="true" /> Insert before
          </button>
          <button type="button" className={actionButton} onClick={() => handlers.onInsert(index + 1)} disabled={busy}>
            <Plus size={16} aria-hidden="true" /> Insert after
          </button>
          <button type="button" className={`${actionButton} ml-auto hover:text-port-error`} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} aria-hidden="true" /> Delete panel
          </button>
        </div>
        {confirmDelete ? (
          <InlineConfirmRow
            question={`Delete panel ${panelNumber} from beat ${beatIndex + 1}?`}
            onConfirm={() => { setConfirmDelete(false); handlers.onDelete(); }}
            onCancel={() => setConfirmDelete(false)}
            autoFocus
          />
        ) : null}
      </div>
    </div>
  );
}

const LINKED_IMAGE = /\.(png|jpe?g|webp)$/i;

function linkedImageRows(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || (row.kind !== 'portrait' && row.kind !== 'reference') || !LINKED_IMAGE.test(row.mediaKey || '')) continue;
    if (seen.has(row.mediaKey)) continue;
    seen.add(row.mediaKey);
    out.push(row);
  }
  return out;
}

function imageChoiceLabel(row) {
  const variantLabel = row.library?.variant?.label;
  const name = (typeof variantLabel === 'string' && variantLabel.trim())
    || (typeof row.caption === 'string' && row.caption.trim())
    || (row.kind === 'portrait' ? 'Portrait' : 'Reference');
  const status = row.library?.review?.status;
  return status === 'bad' || status === 'rejected' ? `${name} (bad)` : name;
}

function choiceLabels(rows) {
  const base = rows.map(imageChoiceLabel);
  const counts = new Map();
  for (const label of base) counts.set(label, (counts.get(label) || 0) + 1);
  return rows.map((row, index) => (counts.get(base[index]) > 1 ? `${base[index]} (${row.kind})` : base[index]));
}

/** Which image of each linked record Make sends. No choice keeps the newest portrait. */
function LinkedImagePicker({ panel, names, onPatch }) {
  const ids = useMemo(() => {
    const all = [...panel.environmentIds, ...panel.objectIds, ...panel.castIds];
    return all.filter((id, index) => all.indexOf(id) === index);
  }, [panel.environmentIds, panel.objectIds, panel.castIds]);
  const [media, setMedia] = useState({});

  useEffect(() => {
    const missing = ids.filter((id) => !(id in media));
    if (!missing.length) return undefined;
    let active = true;
    Promise.all(missing.map((id) => listCatalogIngredientMedia(id, { silent: true })
      .then((rows) => [id, Array.isArray(rows) ? rows : null])
      .catch(() => [id, null])))
      .then((entries) => {
        if (!active) return;
        setMedia((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      });
    return () => { active = false; };
  }, [ids, media]);

  if (!ids.length) return null;
  const picks = panel.linkMedia || {};
  const choose = (id, mediaKey) => {
    const next = { ...picks };
    if (mediaKey) next[id] = mediaKey;
    else delete next[id];
    onPatch({ linkMedia: Object.keys(next).length ? next : null });
  };

  return (
    <section aria-label="Images sent" className="space-y-3">
      <h3 className="text-xs font-medium text-gray-300">Images sent</h3>
      <p className="text-xs text-gray-500">Make sends the image you choose. With none chosen, it sends the newest portrait.</p>
      {ids.map((id) => {
        const name = names[id] || (id in names ? 'Missing record' : '…');
        const selectId = `link-image-${panel.id}-${id}`;
        const loaded = id in media;
        const failed = media[id] === null;
        const choices = linkedImageRows(media[id]);
        const labels = choiceLabels(choices);
        const picked = typeof picks[id] === 'string' ? picks[id] : '';
        const known = choices.some((row) => row.mediaKey === picked);
        const shown = choices.find((row) => row.mediaKey === picked) || choices[0];
        const automatic = !choices.length
          ? 'Newest portrait'
          : choices[0].kind === 'portrait'
            ? `Newest portrait (${labels[0]})`
            : `Newest reference (${labels[0]})`;
        return (
          <div key={id} className="flex items-center gap-2">
            {shown ? (
              <img src={`/data/images/${encodeURIComponent(shown.mediaKey)}`} alt="" className="h-11 w-11 shrink-0 rounded object-cover bg-port-bg" />
            ) : (
              <span className="h-11 w-11 shrink-0 rounded bg-port-bg" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <label htmlFor={selectId} className="mb-1 block truncate text-xs font-medium text-gray-300">Image for {name}</label>
              <select
                id={selectId}
                value={picked || ''}
                disabled={!loaded}
                onChange={(e) => choose(id, e.target.value)}
                className="w-full min-h-[44px] rounded-lg border border-port-border bg-port-bg px-2 text-sm text-gray-200"
              >
                <option value="">{loaded ? automatic : 'Loading images…'}</option>
                {picked && !known && <option value={picked}>{loaded && !failed ? 'Saved image missing' : 'Saved image'}</option>}
                {choices.map((row, index) => <option key={row.mediaKey} value={row.mediaKey}>{labels[index]}</option>)}
              </select>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Which saved camera of a linked place the panel is seen from; its shot sends that camera's photo of the set. */
function SetCameraPicker({ panel, names, cameras, onPatch }) {
  const places = panel.environmentIds.filter((id) => cameras[id]?.length);
  const chosen = panel.setShot;
  const value = chosen ? `${chosen.environmentId}|${chosen.shotId}` : '';
  const known = chosen && cameras[chosen.environmentId]?.some((shot) => shot.id === chosen.shotId);
  if (!places.length && !chosen) return null;
  return (
    <section aria-label="Seen from">
      <label htmlFor={`set-camera-${panel.id}`} className="block text-xs font-medium text-gray-300 mb-1">Seen from (set camera)</label>
      <select id={`set-camera-${panel.id}`} value={value}
        onChange={(e) => {
          const [environmentId, shotId] = e.target.value.split('|');
          onPatch({ setShot: shotId ? { environmentId, shotId } : null });
        }}
        className="w-full min-h-[44px] rounded-lg border border-port-border bg-port-bg px-2 text-sm text-gray-200">
        <option value="">No set camera</option>
        {chosen && !known && <option value={value}>Missing camera</option>}
        {places.map((id) => (
          <optgroup key={id} label={names[id] || 'Set'}>
            {cameras[id].map((shot) => <option key={shot.id} value={`${id}|${shot.id}`}>{shot.label}</option>)}
          </optgroup>
        ))}
      </select>
      <p className="mt-1 text-xs text-gray-500">The shot uses this view of the set in place of the generic set image.</p>
    </section>
  );
}

function CastTab({ panel, onPatch }) {
  const [names, setNames] = useState({});
  // Saved greybox cameras of the linked places, by place id.
  const [cameras, setCameras] = useState({});
  const [picking, setPicking] = useState(null);
  const allIds = useMemo(() => REF_GROUPS.flatMap(({ field }) => panel[field]), [panel]);
  const idsKey = allIds.join('|');

  useEffect(() => {
    // A place picked in this drawer already has its name but not its cameras yet.
    const missing = idsKey ? idsKey.split('|').filter((id) => !(id in names) || (panel.environmentIds.includes(id) && !(id in cameras))) : [];
    if (!missing.length) return undefined;
    let active = true;
    listCatalogIngredientsByIds(missing, { silent: true })
      .then((items) => {
        if (!active) return;
        setNames((prev) => {
          const next = { ...prev };
          for (const id of missing) next[id] = null;
          for (const item of items) next[item.id] = item.name || null;
          return next;
        });
        setCameras((prev) => ({ ...prev, ...Object.fromEntries(items.filter((item) => item.type === 'place')
          .map((item) => [item.id, (item.payload?.greybox?.shots || []).map(({ id, label }) => ({ id, label }))])) }));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [idsKey]); // `names` and `cameras` are the caches this effect fills, so they are not dependencies

  const group = REF_GROUPS.find((g) => g.field === picking);

  return (
    <div className="space-y-4">
      {REF_GROUPS.map(({ field, label, icon: Icon }) => (
        <section key={field} aria-label={label}>
          <div className="flex items-center gap-2 mb-1">
            <Icon size={14} className="text-gray-500" aria-hidden="true" />
            <h3 className="text-xs font-medium text-gray-300">{label}</h3>
            <button type="button" className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${iconButton} ml-auto`} onClick={() => setPicking(field)} aria-label={`Add ${label.toLowerCase()}`}>
              <Plus size={16} />
            </button>
          </div>
          {panel[field].length ? (
            <ul className="flex flex-wrap gap-1.5">
              {panel[field].map((id) => (
                <li key={id} className="inline-flex items-center gap-1 rounded-full border border-port-border bg-port-bg pl-3 text-sm text-gray-200">
                  <span className="truncate max-w-[12rem]">{names[id] || (id in names ? 'Missing record' : '…')}</span>
                  <button type="button" onClick={() => onPatch({
                    [field]: panel[field].filter((x) => x !== id),
                    ...(field === 'environmentIds' && panel.setShot?.environmentId === id ? { setShot: null } : {}),
                  })}
                    className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-full text-gray-500 hover:text-port-error"
                    aria-label={`Remove ${names[id] || 'record'}`}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-600">None</p>
          )}
        </section>
      ))}
      <LinkedImagePicker panel={panel} names={names} onPatch={onPatch} />
      <SetCameraPicker panel={panel} names={names} cameras={cameras} onPatch={onPatch} />
      <IngredientPicker
        open={!!group}
        type={group?.type}
        multi
        excludeIds={group ? panel[group.field] : []}
        onClose={() => setPicking(null)}
        onSelect={(items) => {
          if (!group) return;
          const picked = (Array.isArray(items) ? items : [items]).filter(Boolean);
          setNames((prev) => ({ ...prev, ...Object.fromEntries(picked.map((item) => [item.id, item.name || null])) }));
          onPatch({ [group.field]: [...panel[group.field], ...picked.map((item) => item.id)].slice(0, STORYBOARD_LIMITS.refs) });
          setPicking(null);
        }}
      />
    </div>
  );
}

/**
 * The open panel in the side panel, deep-linked at `<boardPath>/panel/:panelId`
 * with the tab in `?panelTab=`; `onStep(delta)` opens the previous or next
 * panel in story order (`onStep(delta, true)` only asks whether there is one).
 * Every field saves on its own; the parent applies the board each write returns.
 * On a music video's board `songTiming` (`{ span, lyricCues }`) shows the
 * panel's time on the song and the line sung over it, and sets its length.
 */
export default function PanelDrawer({ open, board, found, panelNumber, sketchNonce, busy, onClose, onStep, handlers, timing = true, songTiming = null }) {
  const [activeTab, setActiveTab] = useDrawerTab('panelTab', 'shot', TAB_IDS);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={found ? `Panel ${panelNumber}` : 'Panel'}
      subtitle={found ? (found.beat.title || `Beat ${found.beatIndex + 1}`) : undefined}
      size="xl"
      tabs={found ? TABS : null}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      closeLabel="Close panel"
      headerActions={onStep ? (
        <>
          <button type="button" className={iconButton} aria-label="Previous panel" disabled={!onStep(-1, true)} onClick={() => onStep(-1)}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label="Next panel" disabled={!onStep(1, true)} onClick={() => onStep(1)}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </>
      ) : null}
    >
      {!found ? (
        <p className="text-sm text-gray-400">This panel is no longer on the storyboard.</p>
      ) : activeTab === 'make' ? (
        <PanelMakeTab board={board} found={found} sketchNonce={sketchNonce} handlers={handlers} />
      ) : activeTab === 'cast' ? (
        <CastTab panel={found.panel} onPatch={handlers.onPatch} />
      ) : activeTab === 'notes' ? (
        <div>
          <label htmlFor={`panel-${found.panel.id}-notes`} className={labelClass}>Notes</label>
          <CommitField id={`panel-${found.panel.id}-notes`} multiline minHeightClass="min-h-[10rem]" value={found.panel.notes}
            maxLength={STORYBOARD_LIMITS.notes} onCommit={(notes) => handlers.onPatch({ notes })} />
        </div>
      ) : (
        <ShotTab board={board} found={found} panelNumber={panelNumber} sketchNonce={sketchNonce} busy={busy} handlers={handlers} timing={timing} songTiming={songTiming} />
      )}
    </Drawer>
  );
}
