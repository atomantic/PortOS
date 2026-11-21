import { sortByLabel } from '../../../lib/sortByLabel.js';
import { Plus, Trash2, Users, Swords } from 'lucide-react';
import { BIBLE_LIMITS as L } from '../../../lib/bibleLimits';
import { RELATIONSHIP_LINK_TYPES } from '../../../lib/characterFramework';
import useFieldDraft from '../../../hooks/useFieldDraft';
import { REL_INPUT_CLASS, REL_SELECT_CLASS } from './editorClasses';
import BoxedSection from './BoxedSection';

// Opposing-force axes (#1287) stay local: tagging a link as an opposing force
// is Universe-editor-only, so the Writers Room row editor has no use for them.
// The link TYPES are shared via `characterFramework`.
const RELATIONSHIP_OPPOSITION_AXES = Object.freeze([
  'winner/loser', 'smart/dumb', 'hunter/prey', 'predator/prey', 'custom',
]);

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
          {sortByLabel(others, (c) => c.name || c.id).map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
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
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
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
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 rounded border disabled:opacity-40 ${
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
export default function RelationshipsSection({ entry, characters, onPatch, disabled }) {
  const links = (Array.isArray(entry.relationshipLinks) ? entry.relationshipLinks : []).filter(link => link && typeof link === 'object' && typeof link.targetCharacterId === 'string');
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
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
        >
          <Plus size={10} /> Add relationship
        </button>
      )}
    </BoxedSection>
  );
}
