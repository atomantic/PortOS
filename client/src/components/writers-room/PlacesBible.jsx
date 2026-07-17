import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, MapPin, Pencil, Plus, Trash2, X } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listWritersRoomPlaces,
  createWritersRoomPlace,
  updateWritersRoomPlace,
  deleteWritersRoomPlace,
} from '../../services/apiWritersRoom';
import useMounted from '../../hooks/useMounted';

const PLACE_FIELDS = [
  { key: 'description',      label: 'Description',       placeholder: 'Architecture, scale, materials, lighting sources, recurring set-dressing. Used directly in image-gen prompts.', kind: 'multiline', rows: 3 },
  { key: 'palette',          label: 'Palette',           placeholder: 'Comma-separated dominant colors / lighting cues',                                                              kind: 'text' },
  { key: 'era',              label: 'Era',               placeholder: 'near-future, 1950s noir, present day…',                                                                        kind: 'text' },
  { key: 'weather',          label: 'Weather / mood',    placeholder: 'Recurring atmospheric conditions inside this place',                                                           kind: 'text' },
  { key: 'recurringDetails', label: 'Recurring details', placeholder: 'Distinctive props or fixtures the prose returns to',                                                           kind: 'multiline', rows: 2 },
  { key: 'notes',            label: 'Notes',             placeholder: 'Anything else worth tracking',                                                                                 kind: 'multiline', rows: 2 },
];

// Editable places/world bible — persistent across analysis runs and consumed
// by image gen to inject location descriptions into per-scene prompts.
//
// Controlled vs. uncontrolled: caller may pass `places` to keep multiple
// mounts in sync (e.g. drawer + storyboard chip count). When omitted we fetch
// and own the list so this can stand alone.
export default function PlacesBible({ workId, places: placesProp, onPlacesChange, readingTheme = 'dark', hotRefId = null }) {
  const [internalPlaces, setInternalPlaces] = useState(placesProp || []);
  const places = placesProp ?? internalPlaces;
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const mountedRef = useMounted();

  useEffect(() => {
    if (placesProp) return;
    if (!workId) return;
    setLoading(true);
    listWritersRoomPlaces(workId)
      .then((list) => { if (mountedRef.current) setInternalPlaces(list); })
      .catch(() => { if (mountedRef.current) setInternalPlaces([]); })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [workId, placesProp, mountedRef]);

  const upsert = (next) => {
    const update = (prev) => {
      const idx = prev.findIndex((s) => s.id === next.id);
      const sorted = (arr) => arr.sort((a, b) => (a.slugline || a.name || '').localeCompare(b.slugline || b.name || ''));
      if (idx < 0) return sorted([...prev, next]);
      const copy = [...prev];
      copy[idx] = next;
      return sorted(copy);
    };
    setInternalPlaces(update);
    onPlacesChange?.(update(places));
  };

  const removeOne = (id) => {
    const next = places.filter((s) => s.id !== id);
    setInternalPlaces(next);
    onPlacesChange?.(next);
  };

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] text-gray-500">
          {places.length} location{places.length === 1 ? '' : 's'} · Edits persist across re-runs and feed image gen.
        </div>
        <button
          onClick={() => { setCreating(true); setEditingId(null); }}
          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-port-accent"
        >
          <Plus size={12} /> Add
        </button>
      </div>

      {loading && places.length === 0 && (
        <div className="text-gray-500 italic">Loading…</div>
      )}

      {!loading && places.length === 0 && !creating && (
        <div className="text-gray-500 italic px-1 mb-2">
          No locations yet. Click "Refresh from prose" above to extract them, or add one manually.
        </div>
      )}

      {creating && (
        <PlaceEditor
          workId={workId}
          place={null}
          onSaved={(s) => { upsert(s); setCreating(false); }}
          onCancel={() => setCreating(false)}
        />
      )}

      <ul className="space-y-1.5">
        {places.map((s) => {
          const isEditing = editingId === s.id;
          if (isEditing) {
            return (
              <li key={s.id}>
                <PlaceEditor
                  workId={workId}
                  place={s}
                  onSaved={(updated) => { upsert(updated); setEditingId(null); }}
                  onDeleted={() => { removeOne(s.id); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            );
          }
          const isHot = hotRefId === s.id;
          return (
            <li
              key={s.id}
              className={`border rounded transition-all ${
                isHot
                  ? 'border-port-accent ring-2 ring-port-accent/40 shadow-[0_0_0_3px_rgba(59,130,246,0.08)]'
                  : 'border-port-border'
              }`}
            >
              <PlaceRow place={s} onEdit={() => setEditingId(s.id)} readingTheme={readingTheme} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PlaceRow({ place, onEdit, readingTheme }) {
  const light = readingTheme === 'light';
  const blanks = PLACE_FIELDS.filter((f) => {
    if (f.key === 'notes') return false;
    return !String(place[f.key] || '').trim();
  });
  return (
    <div className="px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <MapPin size={11} className="text-port-accent shrink-0" />
            {place.slugline ? (
              <span className={`font-mono text-[11px] uppercase ${light ? 'text-gray-900' : 'text-white'}`}>{place.slugline}</span>
            ) : (
              <span className={`font-semibold ${light ? 'text-gray-900' : 'text-white'}`}>{place.name}</span>
            )}
            {place.slugline && place.name && place.name !== place.slugline && (
              <span className="text-[10px] text-gray-500 truncate">aka {place.name}</span>
            )}
            {place.era && (
              <span className="text-[9px] uppercase tracking-wider text-port-accent">{place.era}</span>
            )}
            {place.source === 'ai' && (
              <span className="text-[9px] text-gray-500" title="Created by AI extraction — edit to mark as user-curated">ai</span>
            )}
          </div>
          {place.description ? (
            <div className={`text-[11px] mt-0.5 ${light ? 'text-gray-700' : 'text-gray-400'}`}>
              {place.description}
            </div>
          ) : (
            <div className="text-[11px] mt-0.5 text-port-warning italic">No description — image gen will use the scene's visualPrompt only</div>
          )}
          {place.palette && (
            <div className="text-[10px] text-gray-500 mt-1">
              <span className="uppercase tracking-wider text-[9px]">Palette:</span> {place.palette}
            </div>
          )}
          {place.recurringDetails && (
            <div className="text-[10px] text-gray-500 mt-0.5">
              <span className="uppercase tracking-wider text-[9px]">Anchors:</span> {place.recurringDetails}
            </div>
          )}
          {blanks.length > 0 && (
            <div className="text-[10px] text-port-warning mt-1 flex items-center gap-1">
              <AlertTriangle size={9} /> Missing: {blanks.map((f) => f.label.toLowerCase()).join(', ')}
            </div>
          )}
          {place.missingFromProse?.length > 0 && (
            <div className="text-[10px] text-gray-500 mt-1">
              <span className="uppercase tracking-wider text-[9px]">Prose gaps:</span> {place.missingFromProse.join(', ')}
            </div>
          )}
        </div>
        <button
          onClick={onEdit}
          className="text-gray-500 hover:text-port-accent shrink-0"
          title="Edit place"
          aria-label={`Edit ${place.slugline || place.name}`}
        >
          <Pencil size={11} />
        </button>
      </div>
    </div>
  );
}

function PlaceEditor({ workId, place, onSaved, onDeleted, onCancel }) {
  const isCreate = !place;
  const [draft, setDraft] = useState(() => {
    const seed = {
      slugline: place?.slugline || '',
      name: place?.name || '',
    };
    for (const f of PLACE_FIELDS) {
      seed[f.key] = place?.[f.key] || '';
    }
    return seed;
  });
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setDraft((d) => ({ ...d, [field]: e.target.value }));

  const save = async () => {
    if (!draft.slugline.trim() && !draft.name.trim()) {
      toast.error('Slugline or name is required');
      return;
    }
    setSaving(true);
    const payload = {
      slugline: draft.slugline.trim(),
      name: draft.name.trim(),
    };
    for (const f of PLACE_FIELDS) {
      payload[f.key] = draft[f.key];
    }
    const result = await (isCreate
      ? createWritersRoomPlace(workId, payload, { silent: true })
      : updateWritersRoomPlace(workId, place.id, payload, { silent: true })
    ).catch((err) => {
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    setSaving(false);
    if (!result) return;
    toast.success(`${result.slugline || result.name} saved`);
    onSaved?.(result);
  };

  const remove = async () => {
    if (!place) return;
    setSaving(true);
    const ok = await deleteWritersRoomPlace(workId, place.id, { silent: true }).then(() => true).catch((err) => {
      toast.error(`Delete failed: ${err.message}`);
      return false;
    });
    setSaving(false);
    if (ok) {
      toast.success(`${place.slugline || place.name} removed`);
      onDeleted?.();
    }
  };

  const inputCls = 'w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent outline-none';

  return (
    <div className="border border-port-accent/40 rounded p-2 bg-port-card/40 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <input
          value={draft.slugline}
          onChange={set('slugline')}
          placeholder="INT. KITCHEN — NIGHT"
          className={`${inputCls} font-mono uppercase`}
        />
        <button
          onClick={onCancel}
          className="text-gray-500 hover:text-white shrink-0"
          aria-label="Cancel edit"
          title="Cancel"
        >
          <X size={12} />
        </button>
      </div>
      <label className="block">
        <span className="text-[9px] uppercase tracking-wider text-gray-500">Name (optional, human-readable)</span>
        <input value={draft.name} onChange={set('name')} placeholder="The Kitchen, Curry O'City…" className={inputCls} />
      </label>
      {PLACE_FIELDS.map((f) => (
        <label key={f.key} className="block">
          <span className="text-[9px] uppercase tracking-wider text-gray-500">{f.label}</span>
          {f.kind === 'multiline' ? (
            <textarea value={draft[f.key]} onChange={set(f.key)} placeholder={f.placeholder} rows={f.rows || 2} className={`${inputCls} font-sans resize-y`} />
          ) : (
            <input value={draft[f.key]} onChange={set(f.key)} placeholder={f.placeholder} className={inputCls} />
          )}
        </label>
      ))}
      <div className="flex items-center justify-between pt-1">
        {!isCreate ? (
          <button
            onClick={remove}
            disabled={saving}
            className="flex items-center gap-1 text-[10px] text-port-error hover:underline disabled:opacity-50"
          >
            <Trash2 size={10} /> Delete
          </button>
        ) : <span />}
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1 px-2 py-1 bg-port-accent text-white rounded text-[10px] hover:bg-port-accent/80 disabled:opacity-50"
        >
          {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Save
        </button>
      </div>
    </div>
  );
}
