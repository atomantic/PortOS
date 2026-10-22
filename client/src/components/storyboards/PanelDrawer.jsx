import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ChevronLeft, ChevronRight, Clapperboard, Drama, ImagePlus, Loader2, Mountain, Package, Palette, PenLine, Plus,
  StickyNote, Trash2, Users, Wand2, X,
} from 'lucide-react';
import Drawer from '../Drawer';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import IngredientPicker from '../IngredientPicker';
import useDrawerTab from '../../hooks/useDrawerTab';
import { listCatalogIngredientsByIds } from '../../services/api';
import { SHOT_TYPES, SHOT_TYPE_LABELS } from '../../lib/shotGrammar';
import { STORYBOARD_LIMITS } from '../../../../server/lib/storyboardVocabulary.js';
import CommitField from './CommitField';
import MoodBoardPinPicker from './MoodBoardPinPicker';
import PanelMakeTab from './PanelMakeTab';
import { aspectClass, selectedTake, takeSrc } from './storyboardArt';

const TABS = [
  { id: 'shot', label: 'Shot', icon: Clapperboard },
  { id: 'make', label: 'Make', icon: Wand2 },
  { id: 'cast', label: 'Cast & sets', icon: Users },
  { id: 'notes', label: 'Notes', icon: StickyNote },
];
const TAB_IDS = TABS.map((tab) => tab.id);

const REF_GROUPS = [
  { field: 'castIds', label: 'Cast', type: 'character', icon: Drama },
  { field: 'environmentIds', label: 'Environments', type: 'place', icon: Mountain },
  { field: 'objectIds', label: 'Objects', type: 'object', icon: Package },
];

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const iconButton = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-30 disabled:pointer-events-none';
const labelClass = 'block text-[11px] text-gray-500 mb-0.5';

function ArtSection({ panel, aspectRatio, sketchNonce, moodBoardId, busy, onAddTake, onSelectTake, onRemoveTake, onSketch }) {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const take = selectedTake(panel);
  const src = takeSrc(take, sketchNonce(take?.sketchKey));

  return (
    <div className="space-y-2">
      <div className={`${aspectClass(aspectRatio)} w-full rounded-lg border border-port-border bg-port-bg overflow-hidden flex items-center justify-center`}>
        {src ? (
          <img src={src} alt="Selected panel art" className="w-full h-full object-contain" />
        ) : (
          <p className="text-xs text-gray-500">No art yet</p>
        )}
      </div>
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
        <button type="button" className={actionButton} onClick={onSketch} disabled={busy}>
          {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <PenLine size={16} aria-hidden="true" />} Sketch
        </button>
        {moodBoardId ? (
          <button type="button" className={actionButton} onClick={() => setPinsOpen(true)} disabled={busy}>
            <Palette size={16} aria-hidden="true" /> Mood board
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

function ShotTab({ board, found, panelNumber, sketchNonce, busy, handlers }) {
  const { panel, beat, beatIndex, index } = found;
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  return (
    <div className="space-y-3">
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
      />
      <div>
        <label htmlFor={fieldId('action')} className={labelClass}>Action</label>
        <CommitField id={fieldId('action')} multiline value={panel.action} maxLength={STORYBOARD_LIMITS.panelText}
          placeholder="What we see" onCommit={(action) => handlers.onPatch({ action })} />
      </div>
      <div>
        <label htmlFor={fieldId('dialogue')} className={labelClass}>Dialogue or lyric</label>
        <CommitField id={fieldId('dialogue')} multiline value={panel.dialogue} maxLength={STORYBOARD_LIMITS.panelText}
          onCommit={(dialogue) => handlers.onPatch({ dialogue })} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div>
          <label htmlFor={fieldId('framing')} className={labelClass}>Framing</label>
          <select id={fieldId('framing')} value={panel.framing || ''}
            onChange={(event) => handlers.onPatch({ framing: event.target.value || null })}
            className="w-full min-h-[44px] bg-port-bg border border-port-border rounded px-2 text-sm text-white">
            <option value="">Not set</option>
            {SHOT_TYPES.map((type) => <option key={type} value={type}>{SHOT_TYPE_LABELS[type] || type}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={fieldId('seconds')} className={labelClass}>Seconds (estimate)</label>
          <input id={fieldId('seconds')} type="number" inputMode="decimal" min="0.01" step="0.01" max={STORYBOARD_LIMITS.panelSecondsMax}
            value={secondsDraft} onChange={(event) => setSecondsDraft(event.target.value)} onBlur={commitSeconds}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            className="w-full min-h-[44px] bg-port-bg border border-port-border rounded px-2 text-sm text-white tabular-nums" />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <label htmlFor={fieldId('camera')} className={labelClass}>Camera</label>
          <CommitField id={fieldId('camera')} value={panel.camera} maxLength={STORYBOARD_LIMITS.camera}
            placeholder="e.g. slow push in" onCommit={(camera) => handlers.onPatch({ camera })} />
        </div>
      </div>
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
        <button type="button" className={`${iconButton} ml-auto hover:text-port-error`} onClick={() => setConfirmDelete(true)} aria-label="Delete panel">
          <Trash2 size={18} />
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
  );
}

function CastTab({ panel, onPatch }) {
  const [names, setNames] = useState({});
  const [picking, setPicking] = useState(null);
  const allIds = useMemo(() => REF_GROUPS.flatMap(({ field }) => panel[field]), [panel]);
  const idsKey = allIds.join('|');

  useEffect(() => {
    const missing = idsKey ? idsKey.split('|').filter((id) => !(id in names)) : [];
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
      })
      .catch(() => {});
    return () => { active = false; };
  }, [idsKey]); // `names` is the cache this effect fills, so it is not a dependency

  const group = REF_GROUPS.find((g) => g.field === picking);

  return (
    <div className="space-y-4">
      {REF_GROUPS.map(({ field, label, icon: Icon }) => (
        <section key={field} aria-label={label}>
          <div className="flex items-center gap-2 mb-1">
            <Icon size={14} className="text-gray-500" aria-hidden="true" />
            <h3 className="text-xs font-medium text-gray-300">{label}</h3>
            <button type="button" className={`${iconButton} ml-auto`} onClick={() => setPicking(field)} aria-label={`Add ${label.toLowerCase()}`}>
              <Plus size={16} />
            </button>
          </div>
          {panel[field].length ? (
            <ul className="flex flex-wrap gap-1.5">
              {panel[field].map((id) => (
                <li key={id} className="inline-flex items-center gap-1 rounded-full border border-port-border bg-port-bg pl-3 text-sm text-gray-200">
                  <span className="truncate max-w-[12rem]">{names[id] || (id in names ? 'Missing record' : '…')}</span>
                  <button type="button" onClick={() => onPatch({ [field]: panel[field].filter((x) => x !== id) })}
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
 * The open panel, deep-linked at `/storyboards/:id/panel/:panelId` with the
 * tab in `?panelTab=`. Every field saves on its own; the parent applies the
 * board each write returns.
 */
export default function PanelDrawer({ open, board, found, panelNumber, sketchNonce, busy, onClose, handlers }) {
  const [activeTab, setActiveTab] = useDrawerTab('panelTab', 'shot', TAB_IDS);
  const [searchParams] = useSearchParams();
  // The recipe canvas (desktop) needs the room; every other tab stays a column.
  const wide = activeTab === 'make' && searchParams.get('makeView') === 'canvas';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={found ? `Panel ${panelNumber}` : 'Panel'}
      subtitle={found ? (found.beat.title || `Beat ${found.beatIndex + 1}`) : undefined}
      size={wide ? 'xl' : 'md'}
      tabs={found ? TABS : null}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      closeLabel="Close panel"
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
        <ShotTab board={board} found={found} panelNumber={panelNumber} sketchNonce={sketchNonce} busy={busy} handlers={handlers} />
      )}
    </Drawer>
  );
}
