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

import { useEffect, useRef, useState } from 'react';
import {
  Plus, Trash2, WandSparkles, Loader2,
  Palette, Hand, Smile, Package, BookOpen, Eye, Activity, Users, Swords,
  Drama, KeyRound, Mic, Images, BadgeCheck, Play,
} from 'lucide-react';
import { BIBLE_LIMITS as L } from '../../lib/bibleLimits';
import useFieldDraft from '../../hooks/useFieldDraft';
import useRowDraft from '../../hooks/useRowDraft';
import usePendingListRows from '../../hooks/usePendingListRows';
import useAsyncAction from '../../hooks/useAsyncAction';
import {
  listVoiceEngines,
  listVoiceProfiles,
  promoteVoicePreset,
  renderVoiceProfileBenchmark,
  createVoiceDesignCandidate,
  createClonedVoiceCandidate,
  promoteVoiceProfile,
  benchmarkProfileInteractive,
  startFineTuningJob,
} from '../../services/apiVoice';
import VoicePicker from '../voice/VoicePicker';
import CollapsibleSection from '../ui/CollapsibleSection';

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
const VOICE_SOURCE_POLICIES = Object.freeze(['designed', 'consented-performance', 'licensed']);
const IDENTITY_ASSET_ROLES = Object.freeze([
  'neutral', 'profile', 'full-body', 'expression-gesture', 'wardrobe',
  'prop-scale', 'negative-identity',
]);
const REQUIRED_IDENTITY_ROLES = Object.freeze(['neutral', 'profile', 'full-body']);

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
  // `id` stays off the shared spread and is written at each call site: a
  // control whose id arrives through `{...common}` reads as unnamed to any
  // reader — human or the a11y scan — that cannot resolve the spread.
  const common = {
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
        ? <textarea id={id} {...common} rows={2} />
        : <input type="text" id={id} {...common} />}
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
      {/* A `narrow` column (the hex swatch) keeps a fixed width so the rows line
          up, but 6rem of a phone-width row starves the free-text sibling —
          step it down under `sm`. */}
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
          className={`${col.narrow ? 'w-16 sm:w-24 shrink-0' : 'flex-1 min-w-0'} px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50`}
          aria-label={`row ${idx + 1} ${col.name}`}
        />
      ))}
      <button
        type="button"
        onClick={() => onDelete(idx)}
        disabled={disabled}
        title="Remove row" aria-label="Remove row"
        className="shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// Local wrapper over the shared primitive so the three call sites below keep
// their boxed chrome (bordered card, header/body padding) in one place.
function BoxedSection({ icon, label, summary, defaultOpen = false, children }) {
  return (
    <CollapsibleSection
      size="md"
      icon={icon}
      label={label}
      summary={summary ? `— ${summary}` : ''}
      defaultOpen={defaultOpen}
      className="rounded border border-port-border bg-port-bg/50"
      buttonClassName="px-2 py-1.5"
      bodyClassName="px-2.5 pb-2.5 pt-1 space-y-2"
    >
      {children}
    </CollapsibleSection>
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
    <BoxedSection
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
    </BoxedSection>
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
    <BoxedSection icon={Users} label="Relationships" summary={summary}>
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
    </BoxedSection>
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
    <BoxedSection icon={Drama} label="Arc type & sliders" summary={summary}>
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
                    title={`Clear ${axis}`} aria-label={`Clear ${axis}`}
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
    </BoxedSection>
  );
}

const splitProductionTerms = (value, max, itemMax) => value
  .split(',')
  .map((item) => item.trim().slice(0, itemMax))
  .filter(Boolean)
  .slice(0, max);

function VoiceCanonPronunciationRow({ row, idx, onChange, onRemove, disabled }) {
  const term = useFieldDraft(row.term || '', (value) => onChange({ term: value }));
  const pronunciation = useFieldDraft(row.pronunciation || '', (value) => onChange({ pronunciation: value }));
  return (
    <div className="flex items-start gap-1.5">
      <input
        type="text" value={term.value} onChange={term.onChange} onBlur={term.onBlur}
        maxLength={L.VOICE_CANON_PRONUNCIATION_TERM_MAX} placeholder="term"
        disabled={disabled} aria-label={`pronunciation ${idx + 1} term`}
        className={REL_SELECT_CLASS}
      />
      <input
        type="text" value={pronunciation.value} onChange={pronunciation.onChange} onBlur={pronunciation.onBlur}
        maxLength={L.VOICE_CANON_PRONUNCIATION_VALUE_MAX} placeholder="how it is said"
        disabled={disabled} aria-label={`pronunciation ${idx + 1} pronunciation`}
        className={REL_SELECT_CLASS}
      />
      <button
        type="button" onClick={onRemove} disabled={disabled}
        title="Remove pronunciation" aria-label={`remove pronunciation ${idx + 1}`}
        className="shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function VoiceCanonSection({ entry, onPatch, disabled }) {
  const canon = entry.voiceCanon || {};
  const [newPronunciation, setNewPronunciation] = useState({ term: '', pronunciation: '' });
  const commit = (patch) => {
    const approvalPatch = Object.hasOwn(patch, 'approved') ? {} : { approved: false };
    onPatch?.({
      voiceCanon: { version: 1, ...canon, ...patch, ...approvalPatch },
    });
  };
  const description = useFieldDraft(canon.description || '', (value) => commit({ description: value }));
  const delivery = useFieldDraft(canon.defaultDelivery || '', (value) => commit({ defaultDelivery: value }));
  const emotionalRange = useFieldDraft((canon.emotionalRange || []).join(', '), (value) => commit({
    emotionalRange: splitProductionTerms(value, L.VOICE_CANON_RANGE_MAX, L.VOICE_CANON_RANGE_ITEM_MAX),
  }));
  const avoid = useFieldDraft((canon.avoid || []).join(', '), (value) => commit({
    avoid: splitProductionTerms(value, L.VOICE_CANON_AVOID_MAX, L.VOICE_CANON_AVOID_ITEM_MAX),
  }));
  const pronunciations = Array.isArray(canon.pronunciations) ? canon.pronunciations : [];
  const newTerm = newPronunciation.term.trim();
  const newValue = newPronunciation.pronunciation.trim();
  const addPronunciation = () => {
    if (!newTerm || !newValue) return;
    commit({ pronunciations: [...pronunciations, { term: newTerm, pronunciation: newValue }] });
    setNewPronunciation({ term: '', pronunciation: '' });
  };
  const approved = canon.approved === true;
  return (
    <BoxedSection icon={Mic} label="Voice canon" summary={approved ? `v${canon.version || 1} approved` : 'candidate'}>
      <p className="text-[10px] leading-snug text-gray-500">
        Portable performance direction only. Local profiles, recordings, providers, and model artifacts stay machine-local.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <label htmlFor={`voice-canon-version-${entry.id}`} className="block text-[10px] uppercase tracking-wider text-gray-500">Revision</label>
          <input
            id={`voice-canon-version-${entry.id}`} type="number" min="1" max={L.VOICE_CANON_VERSION_MAX}
            value={canon.version || 1} onChange={(e) => commit({ version: Number(e.target.value) || 1 })}
            disabled={disabled} className={REL_INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor={`voice-canon-source-${entry.id}`} className="block text-[10px] uppercase tracking-wider text-gray-500">Source policy</label>
          <select
            id={`voice-canon-source-${entry.id}`} value={canon.sourcePolicy || ''}
            onChange={(e) => commit({ sourcePolicy: e.target.value || null })} disabled={disabled}
            className={REL_INPUT_CLASS}
          >
            <option value="">— unset —</option>
            {VOICE_SOURCE_POLICIES.map((policy) => <option key={policy} value={policy}>{policy}</option>)}
          </select>
        </div>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-gray-300">
        <input type="checkbox" checked={approved} onChange={(e) => commit({ approved: e.target.checked })} disabled={disabled} />
        <BadgeCheck size={12} className={approved ? 'text-port-success' : 'text-gray-500'} />
        {approved ? 'Approved revision' : 'Candidate revision'}
      </label>
      <textarea
        value={description.value} onChange={description.onChange} onBlur={description.onBlur}
        placeholder="Voice description: timbre, texture, breath, and register"
        maxLength={L.VOICE_CANON_DESCRIPTION_MAX} disabled={disabled} rows={2}
        aria-label="voice canon description" className={REL_INPUT_CLASS}
      />
      <textarea
        value={delivery.value} onChange={delivery.onChange} onBlur={delivery.onBlur}
        placeholder="Default delivery: pacing, pauses, energy, and distance"
        maxLength={L.VOICE_CANON_DELIVERY_MAX} disabled={disabled} rows={2}
        aria-label="voice canon default delivery" className={REL_INPUT_CLASS}
      />
      <input
        type="text" value={emotionalRange.value} onChange={emotionalRange.onChange} onBlur={emotionalRange.onBlur}
        placeholder="Emotional range, comma-separated" maxLength={L.VOICE_CANON_RANGE_MAX * L.VOICE_CANON_RANGE_ITEM_MAX}
        disabled={disabled} aria-label="voice canon emotional range" className={REL_INPUT_CLASS}
      />
      <input
        type="text" value={avoid.value} onChange={avoid.onChange} onBlur={avoid.onBlur}
        placeholder="Avoid in delivery, comma-separated" maxLength={L.VOICE_CANON_AVOID_MAX * L.VOICE_CANON_AVOID_ITEM_MAX}
        disabled={disabled} aria-label="voice canon avoid" className={REL_INPUT_CLASS}
      />
      <div className="space-y-1">
        <span className="block text-[10px] uppercase tracking-wider text-gray-500">Pronunciations</span>
        {pronunciations.map((row, idx) => (
          <VoiceCanonPronunciationRow
            key={idx} row={row} idx={idx} disabled={disabled}
            onChange={(patch) => commit({ pronunciations: pronunciations.map((item, i) => i === idx ? { ...item, ...patch } : item) })}
            onRemove={() => commit({ pronunciations: pronunciations.filter((_, i) => i !== idx) })}
          />
        ))}
        <div className="flex items-start gap-1.5">
          <input
            type="text" value={newPronunciation.term}
            onChange={(e) => setNewPronunciation((current) => ({ ...current, term: e.target.value }))}
            maxLength={L.VOICE_CANON_PRONUNCIATION_TERM_MAX} placeholder="new term"
            disabled={disabled} aria-label="new pronunciation term" className={REL_SELECT_CLASS}
          />
          <input
            type="text" value={newPronunciation.pronunciation}
            onChange={(e) => setNewPronunciation((current) => ({ ...current, pronunciation: e.target.value }))}
            maxLength={L.VOICE_CANON_PRONUNCIATION_VALUE_MAX} placeholder="how it is said"
            disabled={disabled} aria-label="new pronunciation value" className={REL_SELECT_CLASS}
          />
        </div>
        <button
          type="button" disabled={disabled || !newTerm || !newValue || pronunciations.length >= L.VOICE_CANON_PRONUNCIATIONS_MAX}
          onClick={addPronunciation}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
        >
          <Plus size={10} /> Add pronunciation
        </button>
      </div>
    </BoxedSection>
  );
}

function VoiceProfileSection({ universeId, entry, disabled }) {
  const [profile, setProfile] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(Boolean(universeId));
  const [loadError, setLoadError] = useState(null);
  const [_engineCapability, setEngineCapability] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  // Voice Design form state
  const [designInstructions, setDesignInstructions] = useState('');
  const [designSeed, setDesignSeed] = useState(42);
  const [designRate, setDesignRate] = useState(1.0);

  // Consented Cloning form state
  const [cloneFile, setCloneFile] = useState(null);
  const [cloneFileName, setCloneFileName] = useState('');
  const [cloneTranscript, setCloneTranscript] = useState('');
  const [cloneConsentConfirmed, setCloneConsentConfirmed] = useState(false);
  const [cloneLicensePosture, _setCloneLicensePosture] = useState('consented-performance');

  // Fine-tuning state
  const [fineTuneEpochs, setFineTuneEpochs] = useState(5);
  const [fineTuneJob, setFineTuneJob] = useState(null);

  const loadGeneration = useRef(0);

  const refreshProfiles = async () => {
    if (!universeId || !entry?.id) return;
    const result = await listVoiceProfiles({ universeId, characterId: entry.id }, { silent: true });
    const list = Array.isArray(result?.profiles) ? result.profiles : [];
    setProfiles(list);
    const active = list.find((p) => p.approval?.status === 'approved') || list[0] || null;
    if (active) setProfile(active);
  };

  useEffect(() => {
    let cancelled = false;
    const generation = ++loadGeneration.current;
    if (!universeId || !entry?.id) {
      setProfile(null);
      setProfiles([]);
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    listVoiceProfiles({ universeId, characterId: entry.id }, { silent: true })
      .then((result) => {
        if (cancelled || generation !== loadGeneration.current) return;
        const list = Array.isArray(result?.profiles) ? result.profiles : [];
        setProfiles(list);
        const active = list.find((p) => p.approval?.status === 'approved') || list[0] || null;
        setProfile(active);
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled && generation === loadGeneration.current) {
          setLoadError(err?.message || 'Failed to load voice profiles');
        }
      })
      .finally(() => {
        if (!cancelled && generation === loadGeneration.current) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [universeId, entry?.id]);

  useEffect(() => {
    if (!universeId) return undefined;
    let cancelled = false;
    listVoiceEngines({ silent: true })
      .then((result) => {
        if (cancelled) return;
        const engine = entry?.voiceId?.split(':')[0] || 'qwen3-tts';
        setEngineCapability((result?.engines || []).find((item) => item.id === engine) || null);
      })
      .catch(() => {
        if (!cancelled) setEngineCapability(null);
      });
    return () => { cancelled = true; };
  }, [universeId, entry?.voiceId]);

  const [promotePreset, promotingPreset] = useAsyncAction(async () => {
    loadGeneration.current += 1;
    const result = await promoteVoicePreset({
      universeId,
      characterId: entry.id,
      characterName: entry.name || '',
      voiceId: entry.voiceId,
    }, { silent: true });
    setProfile(result?.profile || null);
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Could not promote preset' });

  const [designVoice, designingVoice] = useAsyncAction(async () => {
    const result = await createVoiceDesignCandidate({
      universeId,
      characterId: entry.id,
      characterName: entry.name || '',
      instructions: designInstructions,
      seed: designSeed,
      rate: designRate,
    }, { silent: true });
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Voice design candidate generation failed' });

  const [cloneVoice, cloningVoice] = useAsyncAction(async () => {
    if (!cloneFile || !cloneConsentConfirmed) return null;
    const arrayBuffer = await cloneFile.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const audioBase64 = btoa(binary);

    const result = await createClonedVoiceCandidate({
      universeId,
      characterId: entry.id,
      characterName: entry.name || '',
      filename: cloneFileName || cloneFile.name || 'reference.wav',
      audioBase64,
      transcript: cloneTranscript,
      performerConsentConfirmed: cloneConsentConfirmed,
      licensePosture: cloneLicensePosture,
    }, { silent: true });
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Consented cloning candidate creation failed' });

  const [renderBenchmark, renderingBenchmark] = useAsyncAction(async () => {
    if (!profile?.id) return null;
    const result = await renderVoiceProfileBenchmark(profile.id, { silent: true });
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Could not render voice benchmark' });

  const [qualifyInteractive, qualifyingInteractive] = useAsyncAction(async () => {
    if (!profile?.id) return null;
    const result = await benchmarkProfileInteractive(profile.id, { maxFirstAudioMs: 900 }, { silent: true });
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Interactive benchmark qualification failed' });

  const [promoteSelected, promotingSelected] = useAsyncAction(async (targetProfileId) => {
    const result = await promoteVoiceProfile(targetProfileId, {}, { silent: true });
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Could not promote candidate profile' });

  const [startFineTune, startingFineTune] = useAsyncAction(async () => {
    if (!profile?.id) return null;
    const result = await startFineTuningJob(profile.id, { epochs: fineTuneEpochs }, { silent: true });
    setFineTuneJob(result);
    return result;
  }, { errorMessage: 'Failed to start fine-tuning' });

  if (!universeId) return null;
  const approved = profile?.approval?.status === 'approved';
  const _benchmarkCount = profile?.benchmark?.lines?.length || 0;
  const profileState = approved ? `approved v${profile.version} (${profile.kind})` : profile?.approval?.status || 'not promoted';

  return (
    <BoxedSection icon={Mic} label="Local voice profile & Voice Lab" summary={loading ? 'loading' : profileState}>
      <p className="text-[10px] leading-snug text-gray-500">
        Machine-local voice design, consented cloning, and optional fine-tuning. Candidate profiles never mutate approved character voice until explicitly promoted.
      </p>
      {loadError ? <p className="text-[10px] text-port-error">{loadError}</p> : null}

      {/* Sub-tab navigation */}
      <div className="flex gap-1 border-b border-port-border/40 pb-1 text-[11px]">
        {['overview', 'design', 'clone', 'finetune'].map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-2 py-0.5 rounded capitalize ${activeTab === tab ? 'bg-port-accent text-white font-medium' : 'text-gray-400 hover:text-white'}`}
          >
            {tab === 'finetune' ? 'Fine-Tuning' : tab}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-2">
          {approved ? (
            <div className="rounded border border-port-border/40 bg-port-bg/40 p-2 space-y-1">
              <p className="text-[11px] text-gray-300 font-medium">
                Active Approved Voice: <span className="text-port-accent">{profile.voiceId}</span> ({profile.kind})
              </p>
              <p className="text-[10px] text-gray-400">
                Model: {profile.modelRevision} · Rate: {profile.delivery?.rate ?? 1} · Studio: {profile.routes?.studio?.enabled ? 'Yes' : 'No'} · Interactive: {profile.routes?.interactive?.enabled ? 'Qualified' : 'Pending qualification'}
              </p>
              {profile.benchmark?.interactiveLatencyMs ? (
                <p className="text-[10px] text-port-success">
                  Interactive Latency Benchmark: {profile.benchmark.interactiveLatencyMs}ms (threshold: {profile.routes?.interactive?.maxFirstAudioMs || 900}ms)
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-[10px] text-gray-500">Promote the selected Kokoro or Piper preset to give this character a stable local voice.</p>
          )}

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button" onClick={promotePreset} disabled={disabled || promotingPreset || !entry.voiceId}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
            >
              <BadgeCheck size={10} /> {approved ? 'Re-promote selected preset' : 'Promote selected preset'}
            </button>
            <button
              type="button" onClick={renderBenchmark} disabled={disabled || renderingBenchmark || !approved}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
            >
              {renderingBenchmark ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />} Render fixed benchmark
            </button>
            <button
              type="button" onClick={qualifyInteractive} disabled={disabled || qualifyingInteractive || !approved}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
            >
              {qualifyingInteractive ? <Loader2 size={10} className="animate-spin" /> : <Activity size={10} />} Qualify interactive route
            </button>
          </div>

          {profile?.benchmark?.lines?.length ? (
            <div className="space-y-1.5">
              <p className="text-[10px] text-gray-500">Fixed benchmark renders</p>
              {profile.benchmark.lines.map((line, index) => (
                <div key={line.filename} className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-[10px] text-gray-600">{index + 1}</span>
                  <span className="w-20 shrink-0 text-[10px] text-gray-400 truncate">{line.key}</span>
                  <audio
                    controls
                    preload="none"
                    src={`/data/${line.filename.split('/').map(encodeURIComponent).join('/')}`}
                    aria-label={`Voice benchmark ${line.key || index + 1}`}
                    className="h-7 min-w-0 flex-1"
                  >
                    <track kind="captions" />
                  </audio>
                </div>
              ))}
            </div>
          ) : null}

          {/* Candidate & Historical Profiles */}
          {profiles.length > 1 && (
            <div className="space-y-1 pt-2 border-t border-port-border/40">
              <p className="text-[10px] text-gray-500 font-medium">Candidate & Previous Profiles</p>
              {profiles.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 p-1 text-[10px] border border-port-border/30 rounded">
                  <div className="min-w-0 truncate">
                    <span className="font-semibold text-gray-300">{p.voiceId}</span> ({p.kind}, v{p.version}, {p.approval?.status})
                  </div>
                  {p.approval?.status !== 'approved' ? (
                    <button
                      type="button"
                      onClick={() => promoteSelected(p.id)}
                      disabled={disabled || promotingSelected}
                      className="px-1.5 py-0.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent hover:text-white"
                    >
                      Promote
                    </button>
                  ) : (
                    <span className="text-port-success font-medium">Active</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'design' && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-400">Design an original character voice via natural language instructions and seed controls (Qwen3-TTS 1.7B Voice Design).</p>
          <div className="space-y-1.5">
            <label className="block text-[10px] text-gray-400">
              Voice Description & Delivery Instructions
              <input
                type="text"
                value={designInstructions}
                onChange={(e) => setDesignInstructions(e.target.value)}
                placeholder="e.g. warm low alto; dry texture; controlled breath; intimate"
                className="w-full mt-0.5 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
              />
            </label>
            <div className="flex gap-2">
              <label className="block text-[10px] text-gray-400 flex-1">
                Seed
                <input
                  type="number"
                  value={designSeed}
                  onChange={(e) => setDesignSeed(parseInt(e.target.value, 10) || 42)}
                  className="w-full mt-0.5 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
                />
              </label>
              <label className="block text-[10px] text-gray-400 flex-1">
                Rate Multiplier ({designRate}x)
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.05"
                  value={designRate}
                  onChange={(e) => setDesignRate(parseFloat(e.target.value))}
                  className="w-full mt-0.5"
                />
              </label>
            </div>
          </div>
          <button
            type="button"
            onClick={designVoice}
            disabled={disabled || designingVoice}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-40"
          >
            {designingVoice ? <Loader2 size={12} className="animate-spin" /> : <WandSparkles size={12} />}
            Design Candidate Voice
          </button>
        </div>
      )}

      {activeTab === 'clone' && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-400">Rapid single-speaker cloning with documented consent. Audio remains strictly machine-local.</p>
          <div className="space-y-1.5">
            <label className="block text-[10px] text-gray-400">
              Reference Audio File (WAV/MP3)
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  setCloneFile(f || null);
                  setCloneFileName(f?.name || '');
                }}
                className="w-full mt-0.5 text-xs text-gray-300"
              />
            </label>
            <label className="block text-[10px] text-gray-400">
              Audio Transcription
              <textarea
                value={cloneTranscript}
                onChange={(e) => setCloneTranscript(e.target.value)}
                placeholder="Exact spoken words in the recording for conditioning alignment..."
                rows={2}
                className="w-full mt-0.5 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-gray-300">
              <input
                type="checkbox"
                checked={cloneConsentConfirmed}
                onChange={(e) => setCloneConsentConfirmed(e.target.checked)}
              />
              <span>I confirm the performer consented to this voice clone and PortOS keeps this audio machine-local.</span>
            </label>
          </div>
          <button
            type="button"
            onClick={cloneVoice}
            disabled={disabled || cloningVoice || !cloneFile || !cloneConsentConfirmed}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-40"
          >
            {cloningVoice ? <Loader2 size={12} className="animate-spin" /> : <Mic size={12} />}
            Create Cloned Candidate
          </button>
        </div>
      )}

      {activeTab === 'finetune' && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-400">Optional character voice fine-tuning. Checkpointed and cancellable; never assumes the last checkpoint is best.</p>
          <div className="flex gap-2">
            <label className="block text-[10px] text-gray-400 flex-1">
              Epochs
              <input
                type="number"
                value={fineTuneEpochs}
                onChange={(e) => setFineTuneEpochs(parseInt(e.target.value, 10) || 5)}
                min="1"
                max="20"
                className="w-full mt-0.5 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={startFineTune}
            disabled={disabled || startingFineTune || !profile?.id}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-40"
          >
            {startingFineTune ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
            Start Fine-Tuning Job
          </button>
          {fineTuneJob ? (
            <div className="p-2 border border-port-border/40 rounded bg-port-bg/40 text-[10px] space-y-1">
              <p>Job ID: {fineTuneJob.jobId} · Status: {fineTuneJob.status}</p>
            </div>
          ) : null}
        </div>
      )}
    </BoxedSection>
  );
}

function IdentityPackSection({ entry, onPatch, disabled }) {
  const pack = entry.identityPack || {};
  const assets = Array.isArray(pack.assets) ? pack.assets : [];
  const approved = assets.filter((asset) => asset?.approved === true);
  const counts = new Map();
  for (const asset of approved) counts.set(asset.role, (counts.get(asset.role) || 0) + 1);
  const missing = REQUIRED_IDENTITY_ROLES.filter((role) => !counts.get(role));
  const ambiguous = REQUIRED_IDENTITY_ROLES.filter((role) => (counts.get(role) || 0) > 1);
  const status = ambiguous.length ? 'ambiguous' : missing.length ? 'missing' : 'ready';
  const commit = (patch) => onPatch?.({ identityPack: { ...pack, ...patch } });
  const add = () => {
    const imageRef = entry.imageRefs?.[0];
    if (!imageRef) return;
    commit({ assets: [...assets, { imageRef, role: 'neutral', approved: false }] });
  };
  return (
    <BoxedSection icon={Images} label="Identity pack" summary={status}>
      <p className="text-[10px] leading-snug text-gray-500">
        Curate existing character references. Canon-locked production requires one approved neutral, profile, and full-body reference; duplicate approved roles are ambiguous.
      </p>
      {assets.length ? (
        <div className="space-y-1.5">
          {assets.map((asset, idx) => (
            <div key={`${asset.role}-${asset.imageRef}-${idx}`} className="flex items-center gap-1.5">
              <select
                value={asset.imageRef} disabled={disabled} aria-label={`identity asset ${idx + 1} image`}
                onChange={(e) => commit({ assets: assets.map((item, i) => i === idx ? { ...item, imageRef: e.target.value, approved: false } : item) })}
                className={REL_SELECT_CLASS}
              >
                {(entry.imageRefs || []).map((ref) => <option key={ref} value={ref}>{ref}</option>)}
              </select>
              <select
                value={asset.role} disabled={disabled} aria-label={`identity asset ${idx + 1} role`}
                onChange={(e) => commit({ assets: assets.map((item, i) => i === idx ? { ...item, role: e.target.value, approved: false } : item) })}
                className="w-32 shrink-0 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
              >
                {IDENTITY_ASSET_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <label className="inline-flex items-center gap-1 text-[10px] text-gray-300 whitespace-nowrap">
                <input
                  type="checkbox" checked={asset.approved === true} disabled={disabled}
                  aria-label={`approve identity asset ${idx + 1} ${asset.role}`}
                  onChange={(e) => commit({ assets: assets.map((item, i) => i === idx ? { ...item, approved: e.target.checked } : item) })}
                /> Approve
              </label>
              <button
                type="button" disabled={disabled} onClick={() => commit({ assets: assets.filter((_, i) => i !== idx) })}
                title="Remove identity asset" aria-label={`remove identity asset ${idx + 1}`}
                className="shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : <p className="text-[11px] text-gray-500 italic">No identity assets curated yet.</p>}
      {entry.imageRefs?.length ? (
        <button
          type="button" onClick={add} disabled={disabled || assets.length >= L.IDENTITY_PACK_ASSETS_MAX}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
        >
          <Plus size={10} /> Add reference
        </button>
      ) : <p className="text-[11px] text-gray-500 italic">Generate or attach a character reference before curating this pack.</p>}
      {status !== 'ready' ? <p className="text-[10px] text-port-warning">{ambiguous.length ? `Ambiguous: ${ambiguous.join(', ')}` : `Missing: ${missing.join(', ')}`}</p> : null}
    </BoxedSection>
  );
}

export default function CharacterDetailEditor({ entry, universeId = null, onPatch, onExpand, expanding = false, disabled = false, characters = [] }) {
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
        <BoxedSection
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
        </BoxedSection>
      ))}

      <ArcFrameworkControls
        entry={entry}
        onPatch={onPatch}
        disabled={disabled}
        idPrefix={entry.id}
      />

      <VoiceCanonSection entry={entry} onPatch={onPatch} disabled={disabled} />

      <VoiceProfileSection universeId={universeId} entry={entry} disabled={disabled} />

      <IdentityPackSection entry={entry} onPatch={onPatch} disabled={disabled} />

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
