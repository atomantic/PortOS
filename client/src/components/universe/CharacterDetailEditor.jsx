/**
 * CharacterDetailEditor — sectioned form for the extended character fields
 * (pronouns, motivations, stats, color palette, props, expressions, hand
 * gestures, etc.) used by the Universe Builder Cast tab.
 *
 * Mirrors the WardrobeSection draft+blur pattern in CanonCard.jsx: per-field
 * drafts buffered locally and PATCHed on blur (or row mutation) so typing
 * doesn't fire a universe-wide round-trip per keystroke. The parent owns the
 * persisted `entry` and the `onPatch(patch)` write channel — this component
 * only knows the field shape.
 */

import { useState } from 'react';
import {
  ChevronDown, ChevronRight, Plus, Trash2, WandSparkles, Loader2,
  Palette, Hand, Smile, Package, BookOpen, Eye, Activity,
} from 'lucide-react';
import { BIBLE_LIMITS as L } from '../../lib/bibleLimits';
import useFieldDraft from '../../hooks/useFieldDraft';

const SECTIONS = Object.freeze([
  {
    key: 'identity', label: 'Identity', icon: BookOpen,
    fields: [
      { name: 'pronouns', label: 'Pronouns', placeholder: 'she/her · they/them · it/its', max: L.PRONOUNS_MAX, type: 'input' },
      { name: 'age', label: 'Age', placeholder: '27 · centuries old · unknown', max: L.AGE_MAX, type: 'input' },
      { name: 'coreTheme', label: 'Core theme', placeholder: 'one-sentence essence', max: L.CORE_THEME_MAX, type: 'textarea' },
      { name: 'speechAccent', label: 'Speech / accent', placeholder: 'clipped Edinburgh; rarely contracts; nautical metaphors', max: L.SPEECH_ACCENT_MAX, type: 'textarea' },
      { name: 'visualNotes', label: 'Visual notes (at-a-glance)', placeholder: 'layered streetwear; faded mustard + charcoal; chunky boots', max: L.VISUAL_NOTES_MAX, type: 'textarea' },
    ],
  },
  {
    key: 'personality', label: 'Personality & motivations', icon: Smile,
    fields: [
      { name: 'motivations', label: 'Motivations', placeholder: 'what they WANT and what they fear losing', max: L.MOTIVATIONS_MAX, type: 'textarea' },
      { name: 'likes', label: 'Likes', placeholder: 'short prose; comma-separated', max: L.LIKES_MAX, type: 'textarea' },
      { name: 'dislikes', label: 'Dislikes', placeholder: 'short prose; comma-separated', max: L.DISLIKES_MAX, type: 'textarea' },
      { name: 'mannerisms', label: 'Mannerisms', placeholder: 'habitual physical / verbal tics', max: L.MANNERISMS_MAX, type: 'textarea' },
      { name: 'relationships', label: 'Relationships', placeholder: 'who they\'re connected to and the tenor of each connection', max: L.RELATIONSHIPS_MAX, type: 'textarea' },
      { name: 'skills', label: 'Skills', placeholder: 'concrete abilities, soft and hard', max: L.SKILLS_MAX, type: 'textarea' },
    ],
  },
  {
    key: 'visualIdentity', label: 'Visual identity', icon: Eye,
    fields: [
      { name: 'silhouetteNotes', label: 'Silhouette notes', placeholder: 'compact upper body; tapered lower half; short hair adds 5cm height', max: L.SILHOUETTE_NOTES_MAX, type: 'textarea' },
      { name: 'postureNotes', label: 'Posture notes', placeholder: 'slight forward lean; weight in left foot; shoulders loose', max: L.POSTURE_NOTES_MAX, type: 'textarea' },
      { name: 'specialTraits', label: 'Special traits', placeholder: 'quick hands; scar on right eyebrow; observant', max: L.SPECIAL_TRAITS_MAX, type: 'textarea' },
      { name: 'visualIdentity', label: 'Visual identity (design language)', placeholder: 'knobs + sights; urban utilitarian; analog tech feel', max: L.VISUAL_IDENTITY_MAX, type: 'textarea' },
    ],
  },
]);

const LIST_SECTIONS = Object.freeze([
  {
    key: 'stats', label: 'Stats', icon: Activity, field: 'stats',
    addLabel: 'Add stat', singular: 'stat',
    columns: [
      { name: 'label', placeholder: 'Height · Eyes · Form', max: L.STAT_LABEL_MAX },
      { name: 'value', placeholder: '5\'7" · amber · vapor', max: L.STAT_VALUE_MAX },
    ],
    summary: (s) => `${s.label}${s.value ? `: ${s.value}` : ''}`,
  },
  {
    key: 'colorPalette', label: 'Color palette', icon: Palette, field: 'colorPalette',
    addLabel: 'Add swatch', singular: 'swatch',
    columns: [
      { name: 'name', placeholder: 'amber', max: L.COLOR_NAME_MAX },
      { name: 'hex', placeholder: '#f59e0b', max: L.COLOR_HEX_MAX, narrow: true },
      { name: 'role', placeholder: 'skin · jacket primary · boot leather', max: L.COLOR_ROLE_MAX },
    ],
    summary: (c) => `${c.name}${c.hex ? ` ${c.hex}` : ''}${c.role ? ` — ${c.role}` : ''}`,
    swatchHex: (row) => row.hex,
  },
  {
    key: 'props', label: 'Props', icon: Package, field: 'props',
    addLabel: 'Add prop', singular: 'prop',
    columns: [
      { name: 'name', placeholder: 'Radio · Map case', max: L.PROP_NAME_MAX },
      { name: 'purpose', placeholder: 'comms · navigation · talisman', max: L.PROP_PURPOSE_MAX },
      { name: 'materials', placeholder: 'aluminum + ABS plastic', max: L.PROP_MATERIALS_MAX },
    ],
    summary: (p) => `${p.name}${p.purpose ? ` (${p.purpose})` : ''}`,
  },
  {
    key: 'expressions', label: 'Expression sheet', icon: Smile, field: 'expressions',
    addLabel: 'Add expression', singular: 'expression',
    columns: [
      { name: 'name', placeholder: 'neutral · curious · worried', max: L.EXPRESSION_NAME_MAX },
      { name: 'description', placeholder: 'wide eyes; lips parted; brow raised', max: L.EXPRESSION_DESC_MAX },
    ],
    summary: (e) => `${e.name}${e.description ? ` — ${e.description}` : ''}`,
  },
  {
    key: 'handGestures', label: 'Hand gestures', icon: Hand, field: 'handGestures',
    addLabel: 'Add gesture', singular: 'gesture',
    columns: [
      { name: 'name', placeholder: 'pointing · peace sign · gripping radio', max: L.GESTURE_NAME_MAX },
      { name: 'description', placeholder: 'open palm; index extended; relaxed', max: L.GESTURE_DESC_MAX },
    ],
    summary: (g) => `${g.name}${g.description ? ` — ${g.description}` : ''}`,
  },
]);

// Buffered text input — wraps useFieldDraft, commits to onCommit on blur.
function DraftField({ field, value, onCommit, disabled, idPrefix }) {
  const draft = useFieldDraft(value, onCommit);
  // idPrefix scopes the field id to one editor instance so two open
  // character cards don't render duplicate `chr-field-pronouns` DOM ids
  // and break the label/input association.
  const id = `chr-field-${idPrefix || 'unknown'}-${field.name}`;
  const common = {
    id,
    value: draft.value,
    onChange: draft.onChange,
    onBlur: draft.onBlur,
    disabled,
    placeholder: field.placeholder,
    maxLength: field.max,
    className: 'w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50',
  };
  return (
    <div className="space-y-0.5">
      <label htmlFor={id} className="block text-[10px] uppercase tracking-wider text-gray-500">
        {field.label}
      </label>
      {field.type === 'textarea'
        ? <textarea {...common} rows={2} />
        : <input type="text" {...common} />}
    </div>
  );
}

// Generic list editor row — one input per `columns` spec, plus delete.
function ListRow({ row, idx, columns, swatchHex, onChange, onDelete, disabled }) {
  const [drafts, setDrafts] = useState({});
  const draftFor = (col) => (col in drafts ? drafts[col] : (row[col] || ''));
  const setDraft = (col, v) => setDrafts((p) => ({ ...p, [col]: v }));
  const commit = (col) => {
    if (!(col in drafts)) return;
    const v = drafts[col];
    if (v === (row[col] || '')) {
      setDrafts((prev) => { const next = { ...prev }; delete next[col]; return next; });
      return;
    }
    // Spread `row` AND any other pending drafts so a fast A-blur → B-blur
    // sequence doesn't lose column A: if the parent hasn't re-rendered with
    // the committed A value by the time B blurs, B's commit would otherwise
    // spread the stale `row` prop and overwrite A back to its original. By
    // merging in `drafts`, the in-flight edits on sibling columns ride along.
    const nextRow = { ...row, ...drafts, [col]: v };
    setDrafts((prev) => { const next = { ...prev }; delete next[col]; return next; });
    onChange(nextRow);
  };
  return (
    <div className="flex items-start gap-1.5">
      {swatchHex ? (
        <span
          className="shrink-0 w-6 h-6 rounded border border-port-border mt-0.5"
          style={{ background: swatchHex(row) || 'transparent' }}
          title={`Preview ${swatchHex(row) || 'no hex'}`}
        />
      ) : null}
      {columns.map((col) => (
        <input
          key={col.name}
          type="text"
          value={draftFor(col.name)}
          onChange={(e) => setDraft(col.name, e.target.value)}
          onBlur={() => commit(col.name)}
          placeholder={col.placeholder}
          maxLength={col.max}
          disabled={disabled}
          className={`${col.narrow ? 'w-24 shrink-0' : 'flex-1 min-w-0'} px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50`}
          aria-label={`row ${idx + 1} ${col.name}`}
        />
      ))}
      <button
        type="button"
        onClick={() => onDelete(idx)}
        disabled={disabled}
        title="Remove row"
        className="shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function CollapsibleSection({ icon: Icon, label, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border border-port-border bg-port-bg/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] uppercase tracking-wider text-gray-400 hover:text-white"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Icon size={11} />
        <span className="text-gray-300">{label}</span>
        {summary && !open ? <span className="text-gray-500 normal-case truncate">— {summary}</span> : null}
      </button>
      {open ? <div className="px-2.5 pb-2.5 pt-1 space-y-2">{children}</div> : null}
    </div>
  );
}

export default function CharacterDetailEditor({ entry, onPatch, onExpand, expanding = false, disabled = false }) {
  // Per-section pending rows — kept local until the required column (first
  // column on each LIST_SECTION, always `name` or `label`) is non-empty.
  // Persisting a blank row immediately would round-trip a row the server
  // sanitizer drops, and the user's first keystroke would land in a row that
  // disappears on the next render. Mirrors WardrobeSection's pendingNew
  // pattern in CanonCard.jsx.
  const [pendingByList, setPendingByList] = useState({});

  if (!entry) return null;

  const patchField = (name, value) => onPatch?.({ [name]: value });
  const patchList = (field, next) => onPatch?.({ [field]: next });

  const persistedFor = (section) =>
    (Array.isArray(entry[section.field]) ? entry[section.field] : []);
  const pendingFor = (section) => pendingByList[section.key] || [];
  const mergedFor = (section) => [...persistedFor(section), ...pendingFor(section)];
  const requiredColumn = (section) => section.columns[0].name;

  const sectionSummary = (section) => {
    const filled = section.fields.filter((f) => (entry[f.name] || '').trim()).length;
    return filled ? `${filled}/${section.fields.length} filled` : 'empty';
  };
  const listSummary = (section) => {
    const merged = mergedFor(section);
    if (merged.length === 0) return 'empty';
    return `${merged.length} ${merged.length === 1 ? section.singular : section.singular + 's'}`;
  };

  const addRow = (section) => {
    // Client-only id on pending rows so ListRow's local draft state stays
    // bound to THIS row across re-renders and after-deletes — without it,
    // the React key falls through to index and an earlier-row delete shifts
    // a different row's drafts buffer onto this one. The `pending-` prefix
    // is stripped at promotion (see updateRow) so the server's `ensureId`
    // mints a fresh `<kind>-<uuid>` id under its own convention; without
    // that strip the sanitizer would round-trip the client prefix back onto
    // the persisted row.
    const id = `pending-${section.key}-${(globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2))}`;
    const blank = { id, ...Object.fromEntries(section.columns.map((c) => [c.name, ''])) };
    setPendingByList((prev) => ({
      ...prev,
      [section.key]: [...(prev[section.key] || []), blank],
    }));
  };

  const isPendingIdx = (section, idx) => idx >= persistedFor(section).length;
  const pendingIdxOf = (section, idx) => idx - persistedFor(section).length;

  const updateRow = (section, idx, nextRow) => {
    if (!isPendingIdx(section, idx)) {
      const persisted = persistedFor(section);
      patchList(section.field, persisted.map((r, i) => (i === idx ? nextRow : r)));
      return;
    }
    const pIdx = pendingIdxOf(section, idx);
    const pending = pendingFor(section);
    const requiredFilled = String(nextRow[requiredColumn(section)] || '').trim().length > 0;
    if (requiredFilled) {
      // Promote into persisted; drop from pending. Strip the client-only
      // `pending-*` id so the server's sanitizer mints a fresh `<kind>-<uuid>`
      // under its own convention (sanitizer's `ensureId` preserves any
      // non-empty string id verbatim, so an unstripped pending prefix would
      // round-trip onto the persisted row).
      const remaining = pending.filter((_, i) => i !== pIdx);
      setPendingByList((prev) => ({ ...prev, [section.key]: remaining }));
      const { id: _pendingId, ...promoted } = nextRow;
      patchList(section.field, [...persistedFor(section), promoted]);
      return;
    }
    const next = pending.map((r, i) => (i === pIdx ? nextRow : r));
    setPendingByList((prev) => ({ ...prev, [section.key]: next }));
  };

  const removeRow = (section, idx) => {
    if (isPendingIdx(section, idx)) {
      const pIdx = pendingIdxOf(section, idx);
      const next = pendingFor(section).filter((_, i) => i !== pIdx);
      setPendingByList((prev) => ({ ...prev, [section.key]: next }));
      return;
    }
    patchList(section.field, persistedFor(section).filter((_, i) => i !== idx));
  };

  return (
    <div className="mt-2 space-y-1.5">
      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          disabled={expanding || disabled}
          className="inline-flex items-center gap-1.5 px-2 py-1 text-[10px] rounded border border-port-accent/40 bg-port-accent/10 text-port-accent hover:bg-port-accent/20 disabled:opacity-40"
          title={`Fill blank fields on ${entry.name} via one LLM call. Populated fields are preserved.`}
        >
          {expanding ? <Loader2 size={10} className="animate-spin" /> : <WandSparkles size={10} />}
          AI: expand character
        </button>
      ) : null}

      {SECTIONS.map((section) => (
        <CollapsibleSection
          key={section.key}
          icon={section.icon}
          label={section.label}
          summary={sectionSummary(section)}
        >
          {section.fields.map((field) => (
            <DraftField
              key={field.name}
              field={field}
              value={entry[field.name]}
              onCommit={(v) => patchField(field.name, v)}
              disabled={disabled}
              idPrefix={entry.id}
            />
          ))}
        </CollapsibleSection>
      ))}

      {LIST_SECTIONS.map((section) => {
        const merged = mergedFor(section);
        return (
          <CollapsibleSection
            key={section.key}
            icon={section.icon}
            label={section.label}
            summary={listSummary(section)}
          >
            {merged.length === 0 ? (
              <p className="text-[11px] text-gray-500 italic">No {section.label.toLowerCase()} yet.</p>
            ) : (
              <div className="space-y-1.5">
                {merged.map((row, idx) => (
                  <ListRow
                    // Every persisted row carries a server-stamped id (see
                    // sanitizeStat / sanitizePaletteColor / etc.) and every
                    // pending row gets a client-only id from `addRow`. The
                    // index fallback would tie ListRow's local `drafts` state
                    // to a slot, so a delete on an earlier row would shift
                    // another row's drafts onto this one.
                    key={row.id || `${section.key}-${idx}`}
                    row={row}
                    idx={idx}
                    columns={section.columns}
                    swatchHex={section.swatchHex}
                    onChange={(next) => updateRow(section, idx, next)}
                    onDelete={() => removeRow(section, idx)}
                    disabled={disabled}
                  />
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => addRow(section)}
              disabled={disabled}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
            >
              <Plus size={10} /> {section.addLabel}
            </button>
          </CollapsibleSection>
        );
      })}
    </div>
  );
}
