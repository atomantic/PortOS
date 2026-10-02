import { useState } from 'react';
import { Pencil, Save } from 'lucide-react';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
const IMAGE_ROLES = ['background', 'texture', 'decoration', 'cutout'];

// Text fields the director edits directly, with the server's caps (musicVideoCastAndSetsDirectionEditSchema).
const PROTAGONIST_FIELDS = [
  ['construction', 'Construction', 1000, true], ['shapeLanguage', 'Shape language', 500], ['materials', 'Materials', 500],
  ['palette', 'Palette', 300], ['movement', 'Movement', 1000, true],
];
const WORLD_FIELDS = [
  ['layout', 'Layout', 1000, true], ['depth', 'Depth', 500], ['lighting', 'Lighting', 500], ['camera', 'Camera', 500], ['transitions', 'Transitions', 500],
];

const draftFrom = (direction) => ({
  protagonist: {
    ...Object.fromEntries(PROTAGONIST_FIELDS.map(([key]) => [key, direction.protagonist?.[key] || ''])),
    expressions: (direction.protagonist?.expressions || []).join('\n'),
  },
  world: Object.fromEntries(WORLD_FIELDS.map(([key]) => [key, direction.world?.[key] || ''])),
  roles: Object.fromEntries((direction.sets || []).map((set) => [set.id, set.imageRole || 'background'])),
});

const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** Only what the director actually changed, in the PATCH body's shape. */
function editsFrom(direction, draft) {
  const base = draftFrom(direction);
  const pick = (keys, group) => Object.fromEntries(keys.filter((key) => draft[group][key] !== base[group][key]).map((key) => [key, draft[group][key]]));
  const protagonist = pick(PROTAGONIST_FIELDS.map(([key]) => key), 'protagonist');
  if (draft.protagonist.expressions !== base.protagonist.expressions) protagonist.expressions = lines(draft.protagonist.expressions);
  const world = pick(WORLD_FIELDS.map(([key]) => key), 'world');
  const sets = (direction.sets || []).filter((set) => draft.roles[set.id] !== base.roles[set.id]).map((set) => ({ id: set.id, imageRole: draft.roles[set.id] }));
  return {
    ...(Object.keys(protagonist).length ? { protagonist } : {}),
    ...(Object.keys(world).length ? { world } : {}),
    ...(sets.length ? { sets } : {}),
  };
}

/**
 * Direct edits to a procedural Cast & Sets direction — how the character is
 * built and moves, the world's rules and each set's image role — saved through
 * the check-in's revision path. Only changed fields are sent; the parent keys
 * this by revision so a saved (or regenerated) direction resets the draft.
 */
export default function CastAndSetsDirectionEditor({ project, direction, busy, onSave }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => draftFrom(direction));
  const edits = editsFrom(direction, draft);
  const dirty = Object.keys(edits).length > 0;
  const idFor = (name) => `mv-cs-edit-${project.id}-${name}`;
  const setField = (group, key, value) => setDraft((d) => ({ ...d, [group]: { ...d[group], [key]: value } }));

  const field = (group, [key, label, max, long]) => {
    const id = idFor(`${group}-${key}`);
    const onChange = (e) => setField(group, key, e.target.value);
    return (
      <div key={`${group}-${key}`} className={long ? 'sm:col-span-2' : ''}>
        <label htmlFor={id} className="text-xs">{label}</label>
        {long
          ? <textarea id={id} rows={2} maxLength={max} className={inputClass} value={draft[group][key]} onChange={onChange} />
          : <input id={id} type="text" maxLength={max} className={inputClass} value={draft[group][key]} onChange={onChange} />}
      </div>
    );
  };

  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)} className="flex items-center gap-1 rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 border border-port-border disabled:opacity-50">
        <Pencil size={14} aria-hidden="true" /> Edit direction
      </button>
    );
  }
  return (
    <fieldset disabled={busy} className="w-full min-w-0 space-y-3 rounded border border-port-border p-2">
      <legend className="px-1 text-xs text-port-text-muted">Edit direction</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PROTAGONIST_FIELDS.map((f) => field('protagonist', f))}
        <div className="sm:col-span-2">
          <label htmlFor={idFor('expressions')} className="text-xs">Expressions (one per line)</label>
          <textarea id={idFor('expressions')} rows={3} className={inputClass} value={draft.protagonist.expressions} onChange={(e) => setField('protagonist', 'expressions', e.target.value)} />
        </div>
        {WORLD_FIELDS.map((f) => field('world', f))}
      </div>
      {(direction.sets || []).length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {direction.sets.map((set) => (
            <div key={set.id}>
              <label htmlFor={idFor(`role-${set.id}`)} className="text-xs">Image role · {set.name}</label>
              <select id={idFor(`role-${set.id}`)} className={inputClass} value={draft.roles[set.id]} onChange={(e) => setDraft((d) => ({ ...d, roles: { ...d.roles, [set.id]: e.target.value } }))}>
                {IMAGE_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-port-text-muted">Saving revises this check-in. Only images whose prompt changes are re-rendered.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!dirty} onClick={() => onSave(edits).then((res) => { if (res) setOpen(false); })} className="flex items-center gap-1 rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 bg-port-accent text-white disabled:opacity-50">
          <Save size={14} aria-hidden="true" /> Save direction
        </button>
        <button type="button" onClick={() => { setDraft(draftFrom(direction)); setOpen(false); }} className="rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 text-port-text-muted">Cancel</button>
      </div>
    </fieldset>
  );
}
