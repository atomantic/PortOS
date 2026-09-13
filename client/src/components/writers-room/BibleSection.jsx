import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';

// Shared implementation behind ObjectsBible / PlacesBible / CharactersBible —
// three near-identical editable "bible" lists (recurring objects, world
// locations, characters) that persist across analysis runs and feed
// image-gen prompts. Each kind differs only in field config, icon, copy, and
// a couple of row-header/title quirks — everything else (controlled vs.
// uncontrolled list state, fetch-on-mount, upsert/removeOne with
// sort-on-write, Row + Editor shells, inputCls, toast handling) lives here.
//
// `config` (per kind, built by the thin ObjectsBible.jsx / PlacesBible.jsx /
// CharactersBible.jsx wrappers) shape:
//   noun, icon, iconClassName          — row icon (icon may be null)
//   countLabel(n)                      — text under the header ("N objects · …")
//   emptyText                          — shown when the list is empty
//   editButtonTitle                    — title="" on the row's edit button
//   primary: { key, label, placeholder, inputExtraClass, autoFocus, trim }
//     — the bare identity input (object/character name, place slugline)
//   fields: [{ key, label, placeholder, kind, rows, trim, options, heading }]
//     — every other editable field, rendered in order in the Editor.
//     kind: 'text' (input) | 'multiline' (textarea) | 'csv' (comma-separated
//     → string[]) | 'lines' (one entry per line → string[], for a list the
//     entries are long enough to want their own row) | 'select' (a <select>
//     over `options: [{ value, label }]`, persisting '' as null so the field
//     can be cleared) | 'custom' (a structured value — a nested object, a
//     numeric axis set, a row list — supplied as
//     `{ seed(item), marshal(value), Component }`. The Component owns its own
//     labels and its own emptiness, so both the shared `<label>` wrapper and
//     the row's "Missing: …" check skip it and no `label` is needed).
//     `heading` renders a small group label above the field.
//   bodyField, bodyEmptyText           — the row's primary description line
//   detailBlocks: [{ key, label, marginClass }] — extra "Label: value" lines
//   blanksExcludeKeys                  — fields skipped by the "Missing: …" warning
//   renderTitle(item, { light })       — row title JSX
//   renderHeaderExtras(item)           — badges after the title (aka/role/era/ai…)
//   getDisplayName(item)               — used in toasts + edit-button aria-label
//   getSortKey(item)                   — list sort comparator key
//   validate(draft)                    — returns an error string, or null
//   api: { list, create, update, remove }
// Marshal a `csv` / `lines` textarea back to the string[] the API stores.
// An empty box yields `[]` — a real clear, not an omitted key.
const splitEntries = (raw, separator) =>
  String(raw || '').split(separator).map((s) => s.trim()).filter(Boolean);

export function BibleAiBadge() {
  return (
    <span className="text-[9px] text-gray-500" title="Created by AI extraction — edit to mark as user-curated">
      ai
    </span>
  );
}

export default function BibleSection({
  workId, items: itemsProp, onItemsChange, readingTheme = 'dark', hotRefId = null, config,
  // Extra props spread onto every `kind: 'custom'` field component. The shared
  // shell knows nothing about them — it is how a wrapper hands a structured
  // editor host context it cannot fetch for itself (the Writers Room evolution
  // lens needs the active draft's segment index to offer real anchors).
  customProps = null,
}) {
  const [internalItems, setInternalItems] = useState(itemsProp || []);
  const items = itemsProp ?? internalItems;
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const mountedRef = useMounted();

  useEffect(() => {
    if (itemsProp) return undefined;
    if (!workId) return undefined;
    // `active` is the WORK-switch guard and `mountedRef` the unmount one; they
    // are not interchangeable. The component stays mounted across a work swap,
    // so only `active` keeps the previous work's bible out of this one.
    let active = true;
    setLoading(true);
    config.api.list(workId)
      .then((list) => { if (active && mountedRef.current) setInternalItems(list); })
      .catch(() => { if (active && mountedRef.current) setInternalItems([]); })
      .finally(() => { if (active && mountedRef.current) setLoading(false); });
    return () => { active = false; };
  }, [workId, itemsProp, mountedRef]);

  // Internal state uses a functional updater so back-to-back saves (the add
  // form and a row editor can both be open) each merge against the freshest
  // list. The onItemsChange callback stays outside the updater (side effects
  // in updaters double-fire under StrictMode) and receives the view computed
  // from the current merged snapshot, as before.
  const upsert = (record) => {
    const sorted = (arr) => arr.sort((a, b) => config.getSortKey(a).localeCompare(config.getSortKey(b)));
    const merge = (arr) => {
      const idx = arr.findIndex((it) => it.id === record.id);
      return idx < 0
        ? sorted([...arr, record])
        : sorted(arr.map((it, i) => (i === idx ? record : it)));
    };
    setInternalItems((prev) => merge(prev));
    onItemsChange?.(merge(items));
  };

  const removeOne = (id) => {
    setInternalItems((prev) => prev.filter((it) => it.id !== id));
    onItemsChange?.(items.filter((it) => it.id !== id));
  };

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] text-gray-500">{config.countLabel(items.length)}</div>
        <button
          onClick={() => { setCreating(true); setEditingId(null); }}
          className="flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 -mr-2 gap-1 text-[11px] text-gray-400 hover:text-port-accent"
        >
          <Plus size={12} /> Add
        </button>
      </div>

      {loading && items.length === 0 && (
        <BrailleSpinner text="Loading…" />
      )}

      {!loading && items.length === 0 && !creating && (
        <div className="text-gray-500 italic px-1 mb-2">{config.emptyText}</div>
      )}

      {creating && (
        <BibleEditor
          workId={workId}
          item={null}
          items={items}
          config={config}
          customProps={customProps}
          onSaved={(record) => { upsert(record); setCreating(false); }}
          onCancel={() => setCreating(false)}
        />
      )}

      <ul className="space-y-1.5">
        {items.map((item) => {
          const isEditing = editingId === item.id;
          if (isEditing) {
            return (
              <li key={item.id}>
                <BibleEditor
                  workId={workId}
                  item={item}
                  items={items}
                  config={config}
                  customProps={customProps}
                  onSaved={(updated) => { upsert(updated); setEditingId(null); }}
                  onDeleted={() => { removeOne(item.id); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            );
          }
          const isHot = hotRefId === item.id;
          return (
            <li
              key={item.id}
              className={`border rounded transition-all ${
                isHot
                  ? 'border-port-accent ring-2 ring-port-accent/40 shadow-[0_0_0_3px_rgba(59,130,246,0.08)]'
                  : 'border-port-border'
              }`}
            >
              <BibleRow item={item} config={config} onEdit={() => setEditingId(item.id)} readingTheme={readingTheme} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BibleRow({ item, config, onEdit, readingTheme }) {
  const light = readingTheme === 'light';
  const Icon = config.icon;
  const blanks = config.fields.filter((f) => {
    if (f.kind === 'custom' || config.blanksExcludeKeys.includes(f.key)) return false;
    return !String(item[f.key] || '').trim();
  });
  return (
    <div className="px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {Icon && <Icon size={11} className={config.iconClassName} />}
            {config.renderTitle(item, { light })}
            {config.renderHeaderExtras(item)}
          </div>
          {item[config.bodyField] ? (
            <div className={`text-[11px] mt-0.5 ${light ? 'text-gray-700' : 'text-gray-400'}`}>
              {item[config.bodyField]}
            </div>
          ) : (
            <div className="text-[11px] mt-0.5 text-port-warning italic">{config.bodyEmptyText}</div>
          )}
          {config.detailBlocks.map((b) => item[b.key] && (
            <div key={b.key} className={`text-[10px] text-gray-500 ${b.marginClass}`}>
              <span className="uppercase tracking-wider text-[9px]">{b.label}:</span> {item[b.key]}
            </div>
          ))}
          {blanks.length > 0 && (
            <div className="text-[10px] text-port-warning mt-1 flex items-center gap-1">
              <AlertTriangle size={9} /> Missing: {blanks.map((f) => f.label.toLowerCase()).join(', ')}
            </div>
          )}
          {item.missingFromProse?.length > 0 && (
            <div className="text-[10px] text-gray-500 mt-1">
              <span className="uppercase tracking-wider text-[9px]">Prose gaps:</span> {item.missingFromProse.join(', ')}
            </div>
          )}
        </div>
        {/* 44px tap target; the negative margins let it bleed into the row's
            own px-3/py-2 padding so a one-line row doesn't grow taller. */}
        <button
          onClick={onEdit}
          className="shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 -mr-3 text-gray-500 hover:text-port-accent"
          title={config.editButtonTitle}
          aria-label={`Edit ${config.getDisplayName(item)}`}
        >
          <Pencil size={11} />
        </button>
      </div>
    </div>
  );
}

function BibleEditor({ workId, item, items = [], config, customProps = null, onSaved, onDeleted, onCancel }) {
  const isCreate = !item;
  const { primary, fields } = config;
  const [draft, setDraft] = useState(() => {
    const seed = { [primary.key]: item?.[primary.key] || '' };
    for (const f of fields) {
      if (f.kind === 'csv') seed[f.key] = (item?.[f.key] || []).join(', ');
      else if (f.kind === 'lines') seed[f.key] = (item?.[f.key] || []).join('\n');
      // A structured field seeds from the stored value verbatim (never ''), so
      // reopening an untouched record and saving round-trips it unchanged.
      else if (f.kind === 'custom') seed[f.key] = f.seed(item);
      else seed[f.key] = item?.[f.key] || '';
    }
    return seed;
  });
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setDraft((d) => ({ ...d, [field]: e.target.value }));

  const save = async () => {
    const error = config.validate(draft);
    if (error) {
      toast.error(error);
      return;
    }
    setSaving(true);
    const payload = { [primary.key]: draft[primary.key].trim() };
    // Every field is always sent, including as its empty value — '' / [] /
    // null is how the writer CLEARS one, and the server distinguishes that
    // from an absent key (which would preserve the stored value).
    for (const f of fields) {
      if (f.kind === 'csv') payload[f.key] = splitEntries(draft[f.key], ',');
      else if (f.kind === 'lines') payload[f.key] = splitEntries(draft[f.key], '\n');
      else if (f.kind === 'select') payload[f.key] = draft[f.key] || null;
      else if (f.kind === 'custom') payload[f.key] = f.marshal(draft[f.key]);
      else payload[f.key] = f.trim ? draft[f.key].trim() : draft[f.key];
    }
    const result = await (isCreate
      ? config.api.create(workId, payload, { silent: true })
      : config.api.update(workId, item.id, payload, { silent: true })
    ).catch((err) => {
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    setSaving(false);
    if (!result) return;
    toast.success(`${config.getDisplayName(result)} saved`);
    onSaved?.(result);
  };

  const remove = async () => {
    if (!item) return;
    setSaving(true);
    const ok = await config.api.remove(workId, item.id, { silent: true }).then(() => true).catch((err) => {
      toast.error(`Delete failed: ${err.message}`);
      return false;
    });
    setSaving(false);
    if (ok) {
      toast.success(`${config.getDisplayName(item)} removed`);
      onDeleted?.();
    }
  };

  const inputCls = 'w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent outline-none';

  return (
    <div className="border border-port-accent/40 rounded p-2 bg-port-card/40 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="flex-1">
          <span className="sr-only">{primary.label}</span>
          <input
            value={draft[primary.key]}
            onChange={set(primary.key)}
            placeholder={primary.placeholder}
            className={`${inputCls} ${primary.inputExtraClass || ''}`}
            autoFocus={primary.autoFocus}
          />
        </label>
        <button
          onClick={onCancel}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 hover:text-white shrink-0 -my-2 -mr-2"
          aria-label="Cancel edit"
          title="Cancel"
        >
          <X size={12} />
        </button>
      </div>
      {fields.map((f) => (
        <div key={f.key}>
          {f.heading && (
            <div className="text-[9px] uppercase tracking-wider text-port-accent/80 pt-1.5 pb-0.5 border-t border-port-border/60 mt-1.5">
              {f.heading}
            </div>
          )}
          {f.kind === 'custom' ? (
            <f.Component
              value={draft[f.key]}
              onChange={(next) => setDraft((d) => ({ ...d, [f.key]: next }))}
              siblings={items.filter((it) => it.id && it.id !== item?.id)}
              idPrefix={`bible-field-${f.key}`}
              inputCls={inputCls}
              {...customProps}
            />
          ) : (
            <label htmlFor={`bible-field-${f.key}`} className="block">
              <span className="text-[9px] uppercase tracking-wider text-gray-500">{f.label}</span>
              {f.kind === 'multiline' || f.kind === 'lines' ? (
                <textarea id={`bible-field-${f.key}`} value={draft[f.key]} onChange={set(f.key)} placeholder={f.placeholder} rows={f.rows || 2} className={`${inputCls} font-sans resize-y`} />
              ) : f.kind === 'select' ? (
                <select id={`bible-field-${f.key}`} value={draft[f.key]} onChange={set(f.key)} className={inputCls}>
                  <option value="">{f.placeholder || '—'}</option>
                  {(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input id={`bible-field-${f.key}`} value={draft[f.key]} onChange={set(f.key)} placeholder={f.placeholder} className={inputCls} />
              )}
            </label>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between pt-1">
        {!isCreate ? (
          <button
            onClick={remove}
            disabled={saving}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center gap-1 text-[10px] text-port-error hover:underline disabled:opacity-50 -my-2 -ml-2"
          >
            <Trash2 size={10} /> Delete
          </button>
        ) : <span />}
        <button
          onClick={save}
          disabled={saving}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center gap-1 px-2 py-1 bg-port-accent text-white rounded text-[10px] hover:bg-port-accent/80 disabled:opacity-50 -my-2 -mr-2"
        >
          {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Save
        </button>
      </div>
    </div>
  );
}
