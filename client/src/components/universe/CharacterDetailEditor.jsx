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
import useRowDraft from '../../hooks/useRowDraft';
import usePendingListRows from '../../hooks/usePendingListRows';
import VoicePicker from '../voice/VoicePicker';

const SECTIONS = Object.freeze([
  {
    key: 'identity', label: 'Identity', icon: BookOpen,
    fields: [
      { name: 'pronouns', label: 'Pronouns', placeholder: 'she/her · they/them · it/its', max: L.PRONOUNS_MAX, type: 'input' },
      { name: 'age', label: 'Age', placeholder: '27 · centuries old · unknown', max: L.AGE_MAX, type: 'input' },
      { name: 'coreTheme', label: 'Core theme', placeholder: 'one-sentence essence', max: L.CORE_THEME_MAX, type: 'textarea' },
      { name: 'speechAccent', label: 'Accent', placeholder: 'clipped Edinburgh · Brooklyn drawl · off-world inflection', max: L.SPEECH_ACCENT_MAX, type: 'textarea' },
      { name: 'speechPattern', label: 'Speech pattern', placeholder: 'rarely contracts; nautical metaphors; trails off into ellipses when uncertain', max: L.SPEECH_PATTERN_MAX, type: 'textarea' },
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
// Multi-column draft+blur (with sibling ride-along) lives in `useRowDraft`.
function ListRow({ row, idx, columns, swatchHex, onChange, onDelete, disabled }) {
  const { draftFor, setDraft, commit } = useRowDraft(row, onChange);
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

// One LIST_SECTION's row buffer + UI. Extracted so each section gets its
// own `usePendingListRows` instance (hooks can't be called inside the parent's
// `LIST_SECTIONS.map`). Pending ids carry the `pending-<key>-<uuid>` prefix
// and are stripped on promotion so the server's `ensureId` mints a fresh
// `<kind>-<uuid>` under its own convention — see usePendingListRows.js for
// the trade-off this strip implies for sibling drafts.
function ListSectionEditor({ section, entry, onPatchList, disabled }) {
  const persisted = Array.isArray(entry[section.field]) ? entry[section.field] : [];
  const { merged, addRow, updateRow, removeRow } = usePendingListRows({
    persisted,
    requiredColumn: section.columns[0].name,
    idPrefix: `pending-${section.key}-`,
    stripIdOnPromote: true,
    blankRow: () => Object.fromEntries(section.columns.map((c) => [c.name, ''])),
    onChange: (next) => onPatchList(section.field, next),
  });
  const summary = merged.length === 0
    ? 'empty'
    : `${merged.length} ${merged.length === 1 ? section.singular : section.singular + 's'}`;
  return (
    <CollapsibleSection
      icon={section.icon}
      label={section.label}
      summary={summary}
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
              onChange={(next) => updateRow(idx, next)}
              onDelete={() => removeRow(idx)}
              disabled={disabled}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={addRow}
        disabled={disabled}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
      >
        <Plus size={10} /> {section.addLabel}
      </button>
    </CollapsibleSection>
  );
}

export default function CharacterDetailEditor({ entry, onPatch, onExpand, expanding = false, disabled = false }) {
  if (!entry) return null;

  const patchField = (name, value) => onPatch?.({ [name]: value });
  const patchList = (field, next) => onPatch?.({ [field]: next });

  const sectionSummary = (section) => {
    const filled = section.fields.filter((f) => (entry[f.name] || '').trim()).length;
    return filled ? `${filled}/${section.fields.length} filled` : 'empty';
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
          {section.key === 'identity' ? (
            <VoicePicker
              label="Voice (TTS)"
              value={entry.voiceId || null}
              onChange={(v) => patchField('voiceId', v)}
              disabled={disabled}
              placeholder="Project default voice"
              previewText={entry.name ? `Hi, I'm ${entry.name}. This is how I sound.` : undefined}
            />
          ) : null}
        </CollapsibleSection>
      ))}

      {LIST_SECTIONS.map((section) => (
        <ListSectionEditor
          key={section.key}
          section={section}
          entry={entry}
          onPatchList={patchList}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
