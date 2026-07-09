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
  Palette, Hand, Smile, Package, BookOpen, Eye, Activity, Users, Swords,
  Drama, KeyRound,
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
    key: 'framework', label: 'Character framework', icon: Drama,
    fields: [
      { name: 'ghost', label: 'Ghost (backstory wound cause)', placeholder: 'the past event that wounded them — must causally explain the Lie', max: L.GHOST_MAX, type: 'textarea' },
      { name: 'wound', label: 'Wound', placeholder: 'the lasting emotional damage the Ghost left', max: L.WOUND_MAX, type: 'textarea' },
      { name: 'lie', label: 'Lie (false belief)', placeholder: 'state in one sentence — "I only matter if I win"', max: L.LIE_MAX, type: 'textarea' },
      { name: 'need', label: 'Need (Truth — opposite of the Lie)', placeholder: 'the direct opposite of the Lie — "I matter whether I win or lose"', max: L.NEED_MAX, type: 'textarea' },
      { name: 'want', label: 'Want (external goal)', placeholder: 'the concrete goal they pursue — usually conflicts with the Need', max: L.WANT_MAX, type: 'textarea' },
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

// Mirrors `RELATIONSHIP_LINK_TYPES` / `RELATIONSHIP_OPPOSITION_AXES` in
// server/lib/storyBible.js (#1287). The server sanitizer coerces an
// unrecognized value to 'custom', so adding a token here without the server
// side just means the UI offers a value the server folds back to custom.
const RELATIONSHIP_LINK_TYPES = Object.freeze([
  'ally', 'antagonist', 'rival', 'mentor', 'love-interest', 'family', 'custom',
]);
const RELATIONSHIP_OPPOSITION_AXES = Object.freeze([
  'winner/loser', 'smart/dumb', 'hunter/prey', 'predator/prey', 'custom',
]);

// Mirrors `CHARACTER_ARC_TYPES` in server/lib/storyBible.js (#2175). The server
// sanitizer coerces an unrecognized value to null, so an empty selection clears
// the field. `''` = unset.
const CHARACTER_ARC_TYPES = Object.freeze(['positive', 'negative', 'flat']);
const SLIDER_AXES = Object.freeze(['proactivity', 'likability', 'competence']);

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
    key: 'secrets', label: 'Secrets', icon: KeyRound, field: 'secrets',
    addLabel: 'Add secret', singular: 'secret',
    // `secrets` is a plain string[] on the server (cleanStringArray). The
    // generic ListRow works on row objects keyed by column name, so this
    // section stores each secret as `{ text }` and marshals to/from string[]
    // via `toRows` / `fromRows` below (see ListSectionEditor).
    stringList: true,
    columns: [
      { name: 'text', placeholder: 'something they hide from others or themselves', max: L.SECRET_MAX },
    ],
    summary: (s) => s.text,
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
  const rawPersisted = Array.isArray(entry[section.field]) ? entry[section.field] : [];
  // A `stringList` section (e.g. `secrets`) persists a plain string[] on the
  // server, but the generic row editor works on objects keyed by the single
  // column name. Marshal string → { [col]: string } on the way in and back to
  // string on the way out so the section stays server-shape-correct.
  const col0 = section.columns[0].name;
  // Stamp a CONTENT-derived stable id on each marshalled string-list row so
  // ListRow's React key (and its `useRowDraft` buffer) survives a delete/reorder
  // of an earlier row — a plain index key would shift a sibling's draft onto the
  // wrong secret, the exact footgun the ListRow key comment warns about. The
  // per-content occurrence counter disambiguates exact-duplicate strings.
  const stringListRows = () => {
    const seen = new Map();
    return rawPersisted.map((s) => {
      const text = typeof s === 'string' ? s : '';
      const n = seen.get(text) || 0;
      seen.set(text, n + 1);
      return { id: `${section.key}-${n}-${text}`, [col0]: text };
    });
  };
  const persisted = section.stringList ? stringListRows() : rawPersisted;
  const emit = (next) => onPatchList(
    section.field,
    section.stringList
      ? next.map((r) => (r?.[col0] || '').trim()).filter(Boolean)
      : next,
  );
  const { merged, addRow, updateRow, removeRow } = usePendingListRows({
    persisted,
    requiredColumn: col0,
    idPrefix: `pending-${section.key}-`,
    stripIdOnPromote: true,
    blankRow: () => Object.fromEntries(section.columns.map((c) => [c.name, ''])),
    onChange: emit,
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

const REL_SELECT_CLASS = 'flex-1 min-w-0 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50';
const REL_INPUT_CLASS = 'w-full px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50';

// Opposing-force editor (#1287) — only mounted when a link carries an
// `opposition`, so its draft hooks stay consistent across renders. Captures the
// binary tension (axis + the two roles) the reader watches to see reverse.
function OppositionEditor({ idx, opposition, onChange, disabled }) {
  const thisRole = useFieldDraft(opposition.thisRole || '', (v) => onChange({ thisRole: v }));
  const targetRole = useFieldDraft(opposition.targetRole || '', (v) => onChange({ targetRole: v }));
  const note = useFieldDraft(opposition.note || '', (v) => onChange({ note: v }));
  const axisId = `rel-opp-axis-${idx}`;
  return (
    <div className="rounded border border-port-warning/40 bg-port-warning/5 p-1.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Swords size={11} className="text-port-warning" />
        <label htmlFor={axisId} className="text-[10px] uppercase tracking-wider text-port-warning">Opposing force</label>
      </div>
      <select
        id={axisId}
        value={RELATIONSHIP_OPPOSITION_AXES.includes(opposition.axis) ? opposition.axis : 'custom'}
        onChange={(e) => onChange({ axis: e.target.value })}
        disabled={disabled}
        className={REL_INPUT_CLASS}
      >
        {RELATIONSHIP_OPPOSITION_AXES.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      <div className="flex gap-1.5">
        <input
          type="text" value={thisRole.value} onChange={thisRole.onChange} onBlur={thisRole.onBlur}
          placeholder="this role (e.g. hunter)" maxLength={L.RELATIONSHIP_OPPOSITION_ROLE_MAX}
          disabled={disabled} aria-label={`opposition ${idx + 1} this role`}
          className={REL_SELECT_CLASS}
        />
        <input
          type="text" value={targetRole.value} onChange={targetRole.onChange} onBlur={targetRole.onBlur}
          placeholder="their role (e.g. prey)" maxLength={L.RELATIONSHIP_OPPOSITION_ROLE_MAX}
          disabled={disabled} aria-label={`opposition ${idx + 1} target role`}
          className={REL_SELECT_CLASS}
        />
      </div>
      <input
        type="text" value={note.value} onChange={note.onChange} onBlur={note.onBlur}
        placeholder="reader is waiting to see if these reverse" maxLength={L.RELATIONSHIP_OPPOSITION_NOTE_MAX}
        disabled={disabled} aria-label={`opposition ${idx + 1} note`}
        className={REL_INPUT_CLASS}
      />
    </div>
  );
}

// One relationship link row — target + type selects, prose description, and an
// optional opposing-force block. The whole `relationshipLinks` array is patched
// on every mutation (mirrors the list-section onPatchList contract); text
// fields buffer via useFieldDraft and commit on blur.
function RelationshipRow({ link, idx, others, onUpdate, onRemove, disabled }) {
  const desc = useFieldDraft(link.description || '', (v) => onUpdate({ description: v }));
  const hasOpposition = !!link.opposition;
  const toggleOpposition = () => onUpdate({
    opposition: hasOpposition ? null : { axis: 'custom', thisRole: '', targetRole: '', note: '' },
  });
  // A link whose target was deleted points at an id no longer in the cast. Show
  // it as an explicit "(missing)" option so the dangling state is visible and
  // the select still reflects the stored value (rather than silently snapping to
  // the first cast member) — the user can re-point it or delete the row.
  const targetMissing = !!link.targetCharacterId && !others.some((c) => c.id === link.targetCharacterId);
  return (
    <div className={`rounded border ${hasOpposition ? 'border-port-warning/40' : 'border-port-border'} bg-port-bg/40 p-2 space-y-1.5`}>
      <div className="flex items-center gap-1.5">
        <select
          value={link.targetCharacterId || ''}
          onChange={(e) => onUpdate({ targetCharacterId: e.target.value })}
          disabled={disabled}
          aria-label={`relationship ${idx + 1} target character`}
          className={REL_SELECT_CLASS}
        >
          {targetMissing ? (
            <option value={link.targetCharacterId}>(missing: {link.targetCharacterId})</option>
          ) : null}
          {others.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
        </select>
        <select
          value={RELATIONSHIP_LINK_TYPES.includes(link.type) ? link.type : 'custom'}
          onChange={(e) => onUpdate({ type: e.target.value })}
          disabled={disabled}
          aria-label={`relationship ${idx + 1} type`}
          className="w-28 shrink-0 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
        >
          {RELATIONSHIP_LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button
          type="button" onClick={onRemove} disabled={disabled}
          title="Remove relationship" aria-label={`remove relationship ${idx + 1}`}
          className="shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <input
        type="text" value={desc.value} onChange={desc.onChange} onBlur={desc.onBlur}
        placeholder="how they're connected and the tenor of the connection"
        maxLength={L.RELATIONSHIP_DESCRIPTION_MAX} disabled={disabled}
        aria-label={`relationship ${idx + 1} description`}
        className={REL_INPUT_CLASS}
      />
      <button
        type="button" onClick={toggleOpposition} disabled={disabled}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border disabled:opacity-40 ${
          hasOpposition
            ? 'border-port-warning/50 text-port-warning hover:bg-port-warning/10'
            : 'border-port-border text-gray-400 hover:text-white hover:border-gray-500'
        }`}
      >
        <Swords size={10} /> {hasOpposition ? 'Remove opposing force' : 'Tag opposing force'}
      </button>
      {hasOpposition ? (
        <OppositionEditor
          idx={idx}
          opposition={link.opposition}
          onChange={(patch) => onUpdate({ opposition: { ...link.opposition, ...patch } })}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

// Relationships section — structured character-to-character links + opposing
// forces (#1287). Needs the sibling cast (`characters`) to populate the target
// picker; renders a prompt to add more cast when the character is the only one.
//
// Unlike the generic LIST_SECTIONS (ListSectionEditor), this section does NOT
// use `usePendingListRows`: its primary control is a <select> that commits a
// VALID row immediately (a new link defaults targetCharacterId to a real cast
// id), so there's never a pending blank-row-awaiting-required-column to hold.
// Patching the whole array on each mutation mirrors the list-section
// onPatchList contract; text fields buffer via useFieldDraft and commit on blur.
function RelationshipsSection({ entry, characters, onPatch, disabled }) {
  const links = Array.isArray(entry.relationshipLinks) ? entry.relationshipLinks : [];
  const others = (Array.isArray(characters) ? characters : []).filter((c) => c?.id && c.id !== entry.id);
  const commit = (next) => onPatch?.({ relationshipLinks: next });
  const addLink = () => {
    if (!others.length) return;
    commit([...links, { targetCharacterId: others[0].id, type: 'custom', description: '' }]);
  };
  const updateLink = (idx, patch) => commit(links.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const removeLink = (idx) => commit(links.filter((_, i) => i !== idx));
  // `!!l.opposition` matches RelationshipRow's `hasOpposition` test — the toggle
  // always seeds `axis: 'custom'`, so a tagged link always has an axis; using
  // the same predicate keeps the summary count and the per-row border in sync.
  const oppositionCount = links.filter((l) => !!l.opposition).length;
  const summary = links.length === 0
    ? 'empty'
    : `${links.length} link${links.length === 1 ? '' : 's'}${oppositionCount ? ` · ${oppositionCount} opposing` : ''}`;
  return (
    <CollapsibleSection icon={Users} label="Relationships" summary={summary}>
      {/* Always render existing rows — even with no other cast — so a stale
          link (its target was deleted, leaving this the only character) stays
          removable/repointable instead of being stranded behind the add-cast
          prompt where the dangling-target check can flag what the UI hides. */}
      {links.length > 0 ? (
        <div className="space-y-2">
          {links.map((link, idx) => (
            <RelationshipRow
              key={link.id || `rel-${idx}`}
              link={link}
              idx={idx}
              others={others}
              onUpdate={(patch) => updateLink(idx, patch)}
              onRemove={() => removeLink(idx)}
              disabled={disabled}
            />
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-gray-500 italic">No relationships yet.</p>
      )}
      {others.length === 0 ? (
        <p className="text-[11px] text-gray-500 italic">Add another character to the cast to {links.length ? 're-point these links' : 'link relationships'}.</p>
      ) : (
        <button
          type="button" onClick={addLink} disabled={disabled}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
        >
          <Plus size={10} /> Add relationship
        </button>
      )}
    </CollapsibleSection>
  );
}

// Declared arc type + Three Sliders (CWQE Phase 10, #2175). Arc type is a plain
// enum <select> ('' clears); each slider is an integer 1–10 range input with an
// explicit "unset" state (null) so an un-rated axis stays absent rather than
// snapping to a default. Patches commit immediately (no draft buffer needed —
// these are discrete controls, not free text). `idPrefix` scopes the field ids
// so two open cards don't collide.
function ArcFrameworkControls({ entry, onPatch, disabled, idPrefix }) {
  const sliders = (entry.sliders && typeof entry.sliders === 'object') ? entry.sliders : {};
  const arcId = `chr-arc-${idPrefix || 'unknown'}`;
  const patchSlider = (axis, value) => onPatch?.({ sliders: { ...sliders, [axis]: value } });
  const setCount = SLIDER_AXES.reduce((n, a) => n + (typeof entry[a] === 'string' ? 0 : (sliders[a] != null ? 1 : 0)), 0);
  const summary = `${entry.arcType || 'no arc'}${setCount ? ` · ${setCount}/3 sliders` : ''}`;
  return (
    <CollapsibleSection icon={Drama} label="Arc type & sliders" summary={summary}>
      <div className="space-y-0.5">
        <label htmlFor={arcId} className="block text-[10px] uppercase tracking-wider text-gray-500">
          Arc type
        </label>
        <select
          id={arcId}
          value={entry.arcType || ''}
          onChange={(e) => onPatch?.({ arcType: e.target.value })}
          disabled={disabled}
          className="w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
        >
          <option value="">— unset —</option>
          {CHARACTER_ARC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <p className="text-[10px] text-gray-500 leading-snug">
        Rule: HIGH (≥7) on at least two sliders, or high on one with room to grow. All-low = boring; all-high = Mary Sue.
      </p>
      {SLIDER_AXES.map((axis) => {
        const id = `chr-slider-${idPrefix || 'unknown'}-${axis}`;
        const val = sliders[axis];
        const set = val != null;
        return (
          <div key={axis} className="space-y-0.5">
            <div className="flex items-center justify-between">
              <label htmlFor={id} className="text-[10px] uppercase tracking-wider text-gray-500 capitalize">
                {axis}
              </label>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-gray-400 tabular-nums w-6 text-right">{set ? val : '—'}</span>
                {set ? (
                  <button
                    type="button"
                    onClick={() => patchSlider(axis, null)}
                    disabled={disabled}
                    title={`Clear ${axis}`}
                    className="text-gray-500 hover:text-port-error disabled:opacity-30"
                  >
                    <Trash2 size={11} />
                  </button>
                ) : null}
              </div>
            </div>
            <input
              id={id}
              type="range"
              min={L.SLIDER_MIN}
              max={L.SLIDER_MAX}
              step={1}
              value={set ? val : L.SLIDER_MIN}
              onChange={(e) => patchSlider(axis, Number(e.target.value))}
              disabled={disabled}
              className="w-full disabled:opacity-50"
              aria-label={`${axis} rating 1 to 10`}
            />
          </div>
        );
      })}
    </CollapsibleSection>
  );
}

export default function CharacterDetailEditor({ entry, onPatch, onExpand, expanding = false, disabled = false, characters = [] }) {
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

      <ArcFrameworkControls
        entry={entry}
        onPatch={onPatch}
        disabled={disabled}
        idPrefix={entry.id}
      />

      <RelationshipsSection
        entry={entry}
        characters={characters}
        onPatch={onPatch}
        disabled={disabled}
      />

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
