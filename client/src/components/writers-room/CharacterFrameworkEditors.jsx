/**
 * Structured character-framework editors for the Writers Room cast bible
 * (#6417) — the psychology profile (#6414), the Three Sliders (#2175), and the
 * relationship-link rows (#1287), plus the five-stage evolution lens (#6445).
 *
 * These are `kind: 'custom'` fields on BibleSection's field config: BibleSection
 * seeds each from the stored record, hands the component a value + `onChange`,
 * and marshals the result back into the PATCH body. They own their own labels,
 * so BibleSection skips its shared `<label>` wrapper.
 *
 * Every label/placeholder comes from `lib/characterFramework` — the same
 * descriptors the Universe cast editor renders — so the two surfaces cannot
 * drift. What stays behind in the Universe editor is the media/voice half
 * (identity packs, wardrobes, voice design) and the opposing-force tagging on a
 * link; an existing `opposition` block rides through here untouched.
 *
 * Absent vs. intentionally empty: the psychology editor emits the whole object
 * and lets the server sanitizer collapse an all-blank one to null (a real
 * clear), rather than re-implementing that rule with a `.length` test.
 */
import { Plus, Trash2 } from 'lucide-react';
import {
  CHARACTER_PSYCHOLOGY_DRIVE_HINTS,
  CHARACTER_PSYCHOLOGY_DRIVE_LEAVES,
  CHARACTER_PSYCHOLOGY_EDITOR_FIELDS,
  CHARACTER_PSYCHOLOGY_NOTE_FIELD,
  CHARACTER_SLIDER_AXES,
  CHARACTER_SLIDER_MAX,
  CHARACTER_SLIDER_MIN,
  PSYCHOLOGY_ASSESSMENTS,
  PSYCHOLOGY_DRIVE_AXES,
  RELATIONSHIP_LINK_TYPES,
} from '../../lib/characterFramework';
import { BIBLE_LIMITS } from '../../lib/bibleLimits';
import CharacterEvolutionLens from '../character/CharacterEvolutionLens';

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const subLabelCls = 'block text-[9px] uppercase tracking-wider text-gray-500';
const hintCls = 'text-[10px] leading-snug text-gray-500';
// 44px minimum tap target, per the client mobile convention.
const addButtonCls = 'inline-flex items-center gap-1 px-1.5 min-h-[44px] text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40';
const clearButtonCls = 'inline-flex items-center gap-1 px-1.5 min-h-[44px] text-[10px] rounded border border-port-border text-gray-400 hover:text-port-error hover:border-port-error disabled:opacity-40';

// ---------------------------------------------------------------------------
// Psychology profile (#6414)
// ---------------------------------------------------------------------------

// The stored profile, verbatim. `null` on a character nobody has assessed —
// which is the shape the server persists, so an untouched record round-trips.
export const seedPsychology = (item) => item?.psychology ?? null;
// The sanitizer already collapses an all-blank profile to null (its "clear"
// path), so the editor sends what it has and never second-guesses it here.
export const marshalPsychology = (value) => (value && typeof value === 'object' ? value : null);

export function PsychologyFields({ value, onChange, idPrefix, inputCls }) {
  const psychology = asObject(value);
  const drives = asObject(psychology.drives);
  const commit = (patch) => onChange({ ...psychology, ...patch });
  const commitDrive = (axis, patch) => commit({
    drives: { ...drives, [axis]: { ...asObject(drives[axis]), ...patch } },
  });
  const explained = psychology.assessment === 'unknown' || psychology.assessment === 'not-applicable';
  const assessmentId = `${idPrefix}-assessment`;
  const textareaCls = `${inputCls} font-sans resize-y`;
  return (
    <div className="space-y-1.5">
      <p className={hintCls}>
        Optional. The Ghost and Wound above stay the origin history; the Want and Need stay the conscious
        pursuit and the internal alternative. This adds the rule the character operates by and the three
        drives it manages. Leave it empty and the character stays valid and simply unassessed.
      </p>
      <div>
        <label htmlFor={assessmentId} className={subLabelCls}>Assessment</label>
        <select
          id={assessmentId}
          value={psychology.assessment || ''}
          onChange={(e) => commit({ assessment: e.target.value || null })}
          className={inputCls}
        >
          <option value="">— unset —</option>
          {PSYCHOLOGY_ASSESSMENTS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      {explained && (
        <div>
          <label htmlFor={`${idPrefix}-assessmentNote`} className={subLabelCls}>
            {CHARACTER_PSYCHOLOGY_NOTE_FIELD.label}
          </label>
          <textarea
            id={`${idPrefix}-assessmentNote`}
            value={psychology.assessmentNote || ''}
            onChange={(e) => commit({ assessmentNote: e.target.value })}
            placeholder={CHARACTER_PSYCHOLOGY_NOTE_FIELD.placeholder}
            maxLength={CHARACTER_PSYCHOLOGY_NOTE_FIELD.max}
            rows={2}
            className={textareaCls}
          />
        </div>
      )}
      {CHARACTER_PSYCHOLOGY_EDITOR_FIELDS.map((field) => (
        <div key={field.name}>
          <label htmlFor={`${idPrefix}-${field.name}`} className={subLabelCls}>{field.label}</label>
          <textarea
            id={`${idPrefix}-${field.name}`}
            value={psychology[field.name] || ''}
            onChange={(e) => commit({ [field.name]: e.target.value })}
            placeholder={field.placeholder}
            maxLength={field.max}
            rows={2}
            className={textareaCls}
          />
        </div>
      ))}
      <p className={hintCls}>
        Testing pressure and candidate change are what this sheet EXPECTS. What the story actually delivers
        belongs to the authored character arc, not here.
      </p>
      {PSYCHOLOGY_DRIVE_AXES.map((axis) => (
        <div key={axis} className="space-y-1 border border-port-border/40 rounded p-1.5">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 capitalize">{axis}</p>
          <p className={hintCls}>{CHARACTER_PSYCHOLOGY_DRIVE_HINTS[axis]}</p>
          {CHARACTER_PSYCHOLOGY_DRIVE_LEAVES.map((leaf) => (
            <div key={leaf.name}>
              <label htmlFor={`${idPrefix}-${axis}-${leaf.name}`} className={subLabelCls}>{`${axis} ${leaf.name}`}</label>
              <input
                id={`${idPrefix}-${axis}-${leaf.name}`}
                value={asObject(drives[axis])[leaf.name] || ''}
                onChange={(e) => commitDrive(axis, { [leaf.name]: e.target.value })}
                placeholder={leaf.placeholder}
                maxLength={leaf.max}
                className={inputCls}
              />
            </div>
          ))}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange(null)}
        disabled={!value}
        className={clearButtonCls}
      >
        <Trash2 size={10} /> Clear psychology profile
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Three Sliders (#2175)
// ---------------------------------------------------------------------------

// Always an object (the sanitizer keeps all three axes present, null when
// unrated), so `{}` on a legacy record is the honest seed.
export const seedSliders = (item) => asObject(item?.sliders);
export const marshalSliders = (value) => asObject(value);

const SLIDER_VALUES = Array.from(
  { length: CHARACTER_SLIDER_MAX - CHARACTER_SLIDER_MIN + 1 },
  (_, i) => CHARACTER_SLIDER_MIN + i,
);

// A <select> rather than the Universe editor's range input: "unrated" is a real
// state here and a range slider cannot show it without a second control, which
// this compact row-level editor has no room for.
export function SliderFields({ value, onChange, idPrefix, inputCls }) {
  const sliders = asObject(value);
  return (
    <div className="space-y-1.5">
      <p className={hintCls}>
        Rule: HIGH (≥7) on at least two, or high on one with room to grow. All-low = boring; all-high = Mary Sue.
      </p>
      {CHARACTER_SLIDER_AXES.map((axis) => (
        <div key={axis}>
          <label htmlFor={`${idPrefix}-${axis}`} className={`${subLabelCls} capitalize`}>{axis}</label>
          <select
            id={`${idPrefix}-${axis}`}
            value={sliders[axis] == null ? '' : String(sliders[axis])}
            onChange={(e) => onChange({ ...sliders, [axis]: e.target.value === '' ? null : Number(e.target.value) })}
            className={inputCls}
          >
            <option value="">— unrated —</option>
            {SLIDER_VALUES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relationship links (#1287)
// ---------------------------------------------------------------------------

export const seedRelationshipLinks = (item) => (Array.isArray(item?.relationshipLinks) ? item.relationshipLinks : []);
export const marshalRelationshipLinks = (value) => (Array.isArray(value) ? value : []);

export function RelationshipLinkRows({ value, onChange, siblings, idPrefix, inputCls }) {
  const links = Array.isArray(value) ? value : [];
  const others = Array.isArray(siblings) ? siblings : [];
  // Rows are patched, never rebuilt, so an `opposition` block or a `locked`
  // flag authored in the Universe editor survives a Writers Room edit.
  const update = (idx, patch) => onChange(links.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-1.5">
      {links.map((link, idx) => {
        // A link whose target was deleted points at an id no longer in the
        // cast. Surface it as an explicit "(missing)" option so the dangling
        // state is visible and the select still reflects what is stored,
        // instead of silently snapping to the first cast member.
        const targetMissing = !!link.targetCharacterId && !others.some((c) => c.id === link.targetCharacterId);
        return (
          <div key={link.id || `rel-${idx}`} className="border border-port-border/60 rounded p-1.5 space-y-1">
            <div className="flex items-end gap-1.5">
              <div className="flex-1 min-w-0">
                <label htmlFor={`${idPrefix}-${idx}-target`} className={subLabelCls}>Linked to</label>
                <select
                  id={`${idPrefix}-${idx}-target`}
                  value={link.targetCharacterId || ''}
                  onChange={(e) => update(idx, { targetCharacterId: e.target.value })}
                  className={inputCls}
                >
                  {targetMissing && (
                    <option value={link.targetCharacterId}>(missing: {link.targetCharacterId})</option>
                  )}
                  {others.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
                </select>
              </div>
              <div className="w-28 shrink-0">
                <label htmlFor={`${idPrefix}-${idx}-type`} className={subLabelCls}>Type</label>
                <select
                  id={`${idPrefix}-${idx}-type`}
                  value={RELATIONSHIP_LINK_TYPES.includes(link.type) ? link.type : 'custom'}
                  onChange={(e) => update(idx, { type: e.target.value })}
                  className={inputCls}
                >
                  {RELATIONSHIP_LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <button
                type="button"
                onClick={() => onChange(links.filter((_, i) => i !== idx))}
                aria-label={`Remove relationship ${idx + 1}`}
                title="Remove relationship"
                className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 hover:text-port-error"
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div>
              <label htmlFor={`${idPrefix}-${idx}-description`} className={subLabelCls}>Description</label>
              <input
                id={`${idPrefix}-${idx}-description`}
                value={link.description || ''}
                onChange={(e) => update(idx, { description: e.target.value })}
                placeholder="how they're connected and the tenor of the connection"
                maxLength={BIBLE_LIMITS.RELATIONSHIP_DESCRIPTION_MAX}
                className={inputCls}
              />
            </div>
            {link.opposition && (
              <p className={hintCls}>
                Tagged as an opposing force on the <span className="text-port-warning">{link.opposition.axis || 'custom'}</span> axis
                — edit that in the Universe cast editor.
              </p>
            )}
          </div>
        );
      })}
      {others.length === 0 ? (
        <p className="text-[10px] text-gray-500 italic">
          Add another character to this work to {links.length ? 're-point these links' : 'link relationships'}.
        </p>
      ) : (
        <button
          type="button"
          onClick={() => onChange([...links, { targetCharacterId: others[0].id, type: 'custom', description: '' }])}
          className={addButtonCls}
        >
          <Plus size={10} /> Add relationship
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Five-stage evolution lens (#6445)
// ---------------------------------------------------------------------------

// Stored verbatim; `null` on a character nobody has authored a lens for, which
// is the shape the server persists, so an untouched record round-trips.
export const seedEvolution = (item) => item?.evolution ?? null;
// `patchEvolution` already returns `null` once nothing is authored (its "clear"
// path), so the editor sends what it has rather than re-deriving that rule.
export const marshalEvolution = (value) => (value && typeof value === 'object' ? value : null);

/**
 * The shared `CharacterEvolutionLens`, hosted in the Writers Room cast bible.
 *
 * Reused rather than re-implemented: the outcome picker, the five stage cards,
 * the stale-anchor badge and its one-click re-pick are identical to the Pipeline
 * series and FableLoom plan surfaces — only the anchor row differs, and the
 * `host` prop already owns that. `segments` is the work's live segment index
 * (`{ id, kind, heading }`), mapped to the `{ id, label }` option shape the
 * anchor picker takes; a mount without it (a standalone bible render) still
 * edits the prose half and keeps an existing anchor visible as "(missing)".
 */
export function EvolutionFields({ value, onChange, idPrefix, segments }) {
  const options = (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment?.id)
    .map((segment) => ({ id: segment.id, label: `${segment.id} · ${segment.heading || segment.kind || ''}`.trim() }));
  return (
    <CharacterEvolutionLens
      idPrefix={idPrefix}
      evolution={value}
      onChange={onChange}
      host="writersRoom"
      anchors={{ segments: options }}
      psychology={null}
    />
  );
}
