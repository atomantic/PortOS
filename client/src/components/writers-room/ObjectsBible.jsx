import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Package, Pencil, Plus, Trash2, X } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listWritersRoomObjects,
  createWritersRoomObject,
  updateWritersRoomObject,
  deleteWritersRoomObject,
} from '../../services/apiWritersRoom';
import useMounted from '../../hooks/useMounted';

const OBJECT_FIELDS = [
  { key: 'description',  label: 'Description',  placeholder: 'Material, color, condition, distinguishing marks. Used in image-gen prompts when this object appears in a scene.', kind: 'multiline', rows: 3 },
  { key: 'significance', label: 'Significance', placeholder: 'Why does this object matter? What does it represent? How does its meaning evolve across scenes?',                  kind: 'multiline', rows: 2 },
  { key: 'notes',        label: 'Notes',        placeholder: 'Anything else worth tracking',                                                                                     kind: 'multiline', rows: 2 },
];

// Editable recurring-objects bible. Mirrors CharactersBible / SettingsBible.
// Distinct from analysis snapshots — this is the canonical roster that
// survives across `objects` analysis runs and accepts hand-edits.
export default function ObjectsBible({ workId, objects: objectsProp, onObjectsChange, readingTheme = 'dark', hotRefId = null }) {
  const [internalObjects, setInternalObjects] = useState(objectsProp || []);
  const objects = objectsProp ?? internalObjects;
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const mountedRef = useMounted();

  useEffect(() => {
    if (objectsProp) return;
    if (!workId) return;
    setLoading(true);
    listWritersRoomObjects(workId)
      .then((list) => { if (mountedRef.current) setInternalObjects(list); })
      .catch(() => { if (mountedRef.current) setInternalObjects([]); })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [workId, objectsProp, mountedRef]);

  const upsert = (next) => {
    const update = (prev) => {
      const idx = prev.findIndex((o) => o.id === next.id);
      const sorted = (arr) => arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      if (idx < 0) return sorted([...prev, next]);
      const copy = [...prev];
      copy[idx] = next;
      return sorted(copy);
    };
    setInternalObjects(update);
    onObjectsChange?.(update(objects));
  };

  const removeOne = (id) => {
    const next = objects.filter((o) => o.id !== id);
    setInternalObjects(next);
    onObjectsChange?.(next);
  };

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] text-gray-500">
          {objects.length} object{objects.length === 1 ? '' : 's'} · Recurring symbolic items extracted from prose.
        </div>
        <button
          onClick={() => { setCreating(true); setEditingId(null); }}
          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-port-accent"
        >
          <Plus size={12} /> Add
        </button>
      </div>

      {loading && objects.length === 0 && (
        <div className="text-gray-500 italic">Loading…</div>
      )}

      {!loading && objects.length === 0 && !creating && (
        <div className="text-gray-500 italic px-1 mb-2">
          No recurring objects yet. Click "Refresh from prose" above to extract them, or add one manually.
        </div>
      )}

      {creating && (
        <ObjectEditor
          workId={workId}
          object={null}
          onSaved={(o) => { upsert(o); setCreating(false); }}
          onCancel={() => setCreating(false)}
        />
      )}

      <ul className="space-y-1.5">
        {objects.map((o) => {
          const isEditing = editingId === o.id;
          if (isEditing) {
            return (
              <li key={o.id}>
                <ObjectEditor
                  workId={workId}
                  object={o}
                  onSaved={(updated) => { upsert(updated); setEditingId(null); }}
                  onDeleted={() => { removeOne(o.id); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            );
          }
          const isHot = hotRefId === o.id;
          return (
            <li
              key={o.id}
              className={`border rounded transition-all ${
                isHot
                  ? 'border-port-accent ring-2 ring-port-accent/40 shadow-[0_0_0_3px_rgba(59,130,246,0.08)]'
                  : 'border-port-border'
              }`}
            >
              <ObjectRow object={o} onEdit={() => setEditingId(o.id)} readingTheme={readingTheme} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ObjectRow({ object, onEdit, readingTheme }) {
  const light = readingTheme === 'light';
  const blanks = OBJECT_FIELDS.filter((f) => {
    if (f.key === 'notes') return false;
    return !String(object[f.key] || '').trim();
  });
  return (
    <div className="px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Package size={11} className="text-amber-400 shrink-0" />
            <span className={`font-semibold ${light ? 'text-gray-900' : 'text-white'}`}>{object.name}</span>
            {object.aliases?.length > 0 && (
              <span className="text-[10px] text-gray-500 truncate">aka {object.aliases.join(', ')}</span>
            )}
            {object.source === 'ai' && (
              <span className="text-[9px] text-gray-500" title="Created by AI extraction — edit to mark as user-curated">ai</span>
            )}
          </div>
          {object.description ? (
            <div className={`text-[11px] mt-0.5 ${light ? 'text-gray-700' : 'text-gray-400'}`}>
              {object.description}
            </div>
          ) : (
            <div className="text-[11px] mt-0.5 text-port-warning italic">No description yet</div>
          )}
          {object.significance && (
            <div className="text-[10px] text-gray-500 mt-1">
              <span className="uppercase tracking-wider text-[9px]">Significance:</span> {object.significance}
            </div>
          )}
          {blanks.length > 0 && (
            <div className="text-[10px] text-port-warning mt-1 flex items-center gap-1">
              <AlertTriangle size={9} /> Missing: {blanks.map((f) => f.label.toLowerCase()).join(', ')}
            </div>
          )}
          {object.missingFromProse?.length > 0 && (
            <div className="text-[10px] text-gray-500 mt-1">
              <span className="uppercase tracking-wider text-[9px]">Prose gaps:</span> {object.missingFromProse.join(', ')}
            </div>
          )}
        </div>
        <button
          onClick={onEdit}
          className="text-gray-500 hover:text-port-accent shrink-0"
          title="Edit object"
          aria-label={`Edit ${object.name}`}
        >
          <Pencil size={11} />
        </button>
      </div>
    </div>
  );
}

function ObjectEditor({ workId, object, onSaved, onDeleted, onCancel }) {
  const isCreate = !object;
  const [draft, setDraft] = useState(() => {
    const seed = {
      name: object?.name || '',
      aliases: (object?.aliases || []).join(', '),
    };
    for (const f of OBJECT_FIELDS) seed[f.key] = object?.[f.key] || '';
    return seed;
  });
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setDraft((d) => ({ ...d, [field]: e.target.value }));

  const save = async () => {
    if (!draft.name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    const payload = {
      name: draft.name.trim(),
      aliases: draft.aliases.split(',').map((a) => a.trim()).filter(Boolean),
    };
    for (const f of OBJECT_FIELDS) payload[f.key] = draft[f.key];
    const result = await (isCreate
      ? createWritersRoomObject(workId, payload)
      : updateWritersRoomObject(workId, object.id, payload)
    ).catch((err) => {
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    setSaving(false);
    if (!result) return;
    toast.success(`${result.name} saved`);
    onSaved?.(result);
  };

  const remove = async () => {
    if (!object) return;
    setSaving(true);
    const ok = await deleteWritersRoomObject(workId, object.id).then(() => true).catch((err) => {
      toast.error(`Delete failed: ${err.message}`);
      return false;
    });
    setSaving(false);
    if (ok) {
      toast.success(`${object.name} removed`);
      onDeleted?.();
    }
  };

  const inputCls = 'w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent outline-none';

  return (
    <div className="border border-port-accent/40 rounded p-2 bg-port-card/40 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <input
          value={draft.name}
          onChange={set('name')}
          placeholder="the letter, the fedora, her grandmother's locket…"
          className={inputCls}
          autoFocus
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
        <span className="text-[9px] uppercase tracking-wider text-gray-500">Aliases (comma-separated)</span>
        <input value={draft.aliases} onChange={set('aliases')} placeholder="the envelope, the note" className={inputCls} />
      </label>
      {OBJECT_FIELDS.map((f) => (
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
