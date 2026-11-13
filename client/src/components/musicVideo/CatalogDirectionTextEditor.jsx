import { useState } from 'react';
import { Pencil, Plus, Save, Trash2 } from 'lucide-react';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
const buttonClass = 'flex items-center gap-1 rounded px-3 py-1.5 text-sm min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50';
// Caps mirror musicVideoCastAndSetsDirectionTextEditSchema / CAST_SETS_LIMITS.
const MAX = { rules: 6, expressions: 8, props: 6, elements: 4 };

const draftFrom = (direction = {}) => {
  const d = direction || {};
  return {
    look: d.look || '',
    signature: d.protagonist?.signature || '',
    rules: (d.protagonist?.rules || []).join('\n'),
    expressions: (d.protagonist?.expressions || []).join('\n'),
    props: (d.props || []).map(({ id, name = '', owner = '', description = '' }) => ({ id, name, owner, description })),
    summary: d.overlayConcept?.summary || '',
    elements: (d.overlayConcept?.elements || []).map(({ name = '', description = '' }) => ({ name, description })),
  };
};

const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
const complete = (items) => items.filter((item) => item.name.trim() && item.description.trim());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Only the changed fields, in the PATCH body's shape. */
function editsFrom(direction, draft) {
  const base = draftFrom(direction);
  const protagonist = {
    ...(draft.signature !== base.signature ? { signature: draft.signature } : {}),
    ...(draft.rules !== base.rules ? { rules: lines(draft.rules) } : {}),
    ...(draft.expressions !== base.expressions ? { expressions: lines(draft.expressions) } : {}),
  };
  const overlayConcept = {
    ...(draft.summary !== base.summary ? { summary: draft.summary } : {}),
    ...(!same(draft.elements, base.elements) ? { elements: complete(draft.elements) } : {}),
  };
  return {
    ...(draft.look !== base.look ? { look: draft.look } : {}),
    ...(Object.keys(protagonist).length ? { protagonist } : {}),
    ...(!same(draft.props, base.props) ? { props: complete(draft.props).map(({ id, ...prop }) => (id ? { id, ...prop } : prop)) } : {}),
    ...(Object.keys(overlayConcept).length ? { overlayConcept } : {}),
  };
}

/**
 * The words a catalog check-in keeps from its earlier generated direction: the
 * look line, the protagonist's signature, rules and expressions, the props and
 * the overlay concept. The catalog owns the cast, environments and objects, so
 * saving re-renders nothing; Rebuild guide shows the edited text. Keyed by the
 * parent on the direction itself so a saved direction resets the draft.
 */
export default function CatalogDirectionTextEditor({ project, direction, busy, onSave }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => draftFrom(direction));
  const edits = editsFrom(direction, draft);
  const dirty = Object.keys(edits).length > 0;
  const idFor = (name) => `mv-catalog-direction-${project.id}-${name}`;
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const setItem = (list, index, key, value) => setDraft((d) => ({ ...d, [list]: d[list].map((item, i) => (i === index ? { ...item, [key]: value } : item)) }));
  const removeItem = (list, index) => setDraft((d) => ({ ...d, [list]: d[list].filter((_, i) => i !== index) }));
  const addItem = (list, item) => setDraft((d) => ({ ...d, [list]: [...d[list], item] }));

  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)} className={`${buttonClass} border border-port-border`}>
        <Pencil size={14} aria-hidden="true" /> Edit direction text
      </button>
    );
  }

  const textField = (key, label, max, rows = 2) => (
    <div className="sm:col-span-2">
      <label htmlFor={idFor(key)} className="text-xs">{label}</label>
      <textarea id={idFor(key)} rows={rows} maxLength={max} className={inputClass} value={draft[key]} onChange={(e) => set(key, e.target.value)} />
    </div>
  );
  const itemRows = (list, label, withOwner) => draft[list].map((item, index) => (
    <div key={index} className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded border border-port-border p-2">
      <div>
        <label htmlFor={idFor(`${list}-${index}-name`)} className="text-xs">{label} {index + 1} name</label>
        <input id={idFor(`${list}-${index}-name`)} type="text" maxLength={120} className={inputClass} value={item.name} onChange={(e) => setItem(list, index, 'name', e.target.value)} />
      </div>
      {withOwner && (
        <div>
          <label htmlFor={idFor(`${list}-${index}-owner`)} className="text-xs">Owner</label>
          <input id={idFor(`${list}-${index}-owner`)} type="text" maxLength={120} className={inputClass} value={item.owner} onChange={(e) => setItem(list, index, 'owner', e.target.value)} />
        </div>
      )}
      <div className="sm:col-span-2">
        <label htmlFor={idFor(`${list}-${index}-description`)} className="text-xs">Description</label>
        <textarea id={idFor(`${list}-${index}-description`)} rows={2} maxLength={1000} className={inputClass} value={item.description} onChange={(e) => setItem(list, index, 'description', e.target.value)} />
      </div>
      <button type="button" onClick={() => removeItem(list, index)} aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} className={`${buttonClass} text-port-text-muted`}>
        <Trash2 size={14} aria-hidden="true" /> Remove
      </button>
    </div>
  ));

  return (
    <fieldset disabled={busy} className="w-full min-w-0 space-y-3 rounded border border-port-border p-2">
      <legend className="px-1 text-xs text-port-text-muted">Edit direction text</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {textField('look', 'Look', 500)}
        {textField('signature', 'Protagonist signature', 1000)}
        {textField('rules', `Protagonist rules (one per line, up to ${MAX.rules})`, undefined, 3)}
        {textField('expressions', `Expressions (one per line, up to ${MAX.expressions})`, undefined, 3)}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">Props</p>
        {itemRows('props', 'Prop', true)}
        {draft.props.length < MAX.props && (
          <button type="button" onClick={() => addItem('props', { name: '', owner: '', description: '' })} className={`${buttonClass} border border-port-border`}>
            <Plus size={14} aria-hidden="true" /> Add prop
          </button>
        )}
      </div>
      <div className="space-y-2">
        {textField('summary', 'Overlay concept', 1000)}
        {itemRows('elements', 'Overlay element', false)}
        {draft.elements.length < MAX.elements && (
          <button type="button" onClick={() => addItem('elements', { name: '', description: '' })} className={`${buttonClass} border border-port-border`}>
            <Plus size={14} aria-hidden="true" /> Add overlay element
          </button>
        )}
      </div>
      <p className="text-xs text-port-text-muted">Saving changes only these words: nothing re-renders and the approval stays. A prop or element without a name and description is left out. Rebuild the guide to show the new text.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!dirty} onClick={() => onSave(edits).then((res) => { if (res) setOpen(false); })} className={`${buttonClass} bg-port-accent text-white`}>
          <Save size={14} aria-hidden="true" /> Save direction text
        </button>
        <button type="button" onClick={() => { setDraft(draftFrom(direction)); setOpen(false); }} className={`${buttonClass} text-port-text-muted`}>Cancel</button>
      </div>
    </fieldset>
  );
}
