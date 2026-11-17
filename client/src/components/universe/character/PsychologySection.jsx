import { Trash2, Compass } from 'lucide-react';
import { CHARACTER_PSYCHOLOGY_DRIVE_HINTS, CHARACTER_PSYCHOLOGY_DRIVE_LEAVES, CHARACTER_PSYCHOLOGY_EDITOR_FIELDS, CHARACTER_PSYCHOLOGY_NOTE_FIELD, PSYCHOLOGY_ASSESSMENTS, PSYCHOLOGY_DRIVE_AXES } from '../../../lib/characterFramework';
import useFieldDraft from '../../../hooks/useFieldDraft';
import { REL_INPUT_CLASS } from './editorClasses';
import BoxedSection from './BoxedSection';

// One draft-buffered textarea inside the psychology profile. A sub-component
// because `useFieldDraft` is a hook and cannot be called inside a `.map`.
function PsychologyField({ id, label, hint, placeholder, max, value, onCommit, disabled, rows = 2 }) {
  const draft = useFieldDraft(value || '', onCommit);
  return (
    <div className="space-y-0.5">
      <label htmlFor={id} className="block text-[10px] uppercase tracking-wider text-gray-500">{label}</label>
      {hint ? <p className="text-[10px] leading-snug text-gray-500">{hint}</p> : null}
      <textarea
        id={id} value={draft.value} onChange={draft.onChange} onBlur={draft.onBlur}
        placeholder={placeholder} maxLength={max} disabled={disabled} rows={rows}
        className={REL_INPUT_CLASS}
      />
    </div>
  );
}

/**
 * Optional structured psychology (#6414) — the character's operating rule and
 * the survival / connection / status drives it serves.
 *
 * Deliberately NOT auto-derived from the Lie. The Lie is an optional judgment
 * ABOUT a belief; the theory of control is the belief stated as the rule the
 * character actually runs on. They are usually related and are never the same
 * statement, so an existing Lie is offered as read-only legacy context and a
 * suggested starting point — never copied in, never asserted equivalent.
 * Absent on every character nobody has assessed, which is why the summary says
 * "unassessed" rather than showing an empty form as if it were filled in.
 */
export default function PsychologySection({ entry, onPatch, disabled }) {
  const psychology = (entry.psychology && typeof entry.psychology === 'object') ? entry.psychology : {};
  const drives = (psychology.drives && typeof psychology.drives === 'object') ? psychology.drives : {};
  const commit = (patch) => onPatch?.({ psychology: { ...psychology, ...patch } });
  const commitDrive = (axis, patch) => commit({
    drives: { ...drives, [axis]: { ...(drives[axis] || {}), ...patch } },
  });
  const filled = CHARACTER_PSYCHOLOGY_EDITOR_FIELDS.filter((f) => String(psychology[f.name] || '').trim()).length
    + PSYCHOLOGY_DRIVE_AXES.filter((axis) => String(drives[axis]?.desire || '').trim() || String(drives[axis]?.fear || '').trim()).length;
  // "unassessed" is keyed on the PERSISTED object, not on the filled count: an
  // author who ruled the profile out wrote a real assessment even though every
  // prose leaf is blank, and the clear action has to stay reachable for them.
  const hasProfile = Boolean(entry.psychology);
  const summary = !hasProfile
    ? 'unassessed'
    : psychology.assessment && psychology.assessment !== 'assessed'
      ? psychology.assessment
      : `${filled}/${CHARACTER_PSYCHOLOGY_EDITOR_FIELDS.length + PSYCHOLOGY_DRIVE_AXES.length} filled`;
  const assessmentId = `chr-psych-assessment-${entry.id}`;
  return (
    <BoxedSection icon={Compass} label="Psychology (theory of control & drives)" summary={summary}>
      <p className="text-[10px] leading-snug text-gray-500">
        Optional. The Ghost and Wound above stay the origin history; the Want and Need stay the conscious
        pursuit and the internal alternative. This section adds the rule the character operates by and the
        three drives it manages. Leave it empty and the character stays valid and simply unassessed.
      </p>
      {entry.lie ? (
        <p className="text-[10px] leading-snug text-gray-400 border-l-2 border-port-border pl-2">
          <span className="uppercase tracking-wider text-gray-500">Legacy context — the Lie you already wrote:</span>{' '}
          <span className="italic">{entry.lie}</span>{' '}
          A suggested starting point only. The Lie is a judgment about a belief; the theory of control states
          the belief as the character&apos;s operating rule. They are not the same sentence, and the Need may
          qualify the belief rather than be its literal opposite.
        </p>
      ) : null}
      <div className="space-y-0.5">
        <label htmlFor={assessmentId} className="block text-[10px] uppercase tracking-wider text-gray-500">
          Assessment
        </label>
        <select
          id={assessmentId} value={psychology.assessment || ''} disabled={disabled}
          onChange={(e) => commit({ assessment: e.target.value || null })}
          className={REL_INPUT_CLASS}
        >
          <option value="">— unset —</option>
          {PSYCHOLOGY_ASSESSMENTS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      {psychology.assessment === 'unknown' || psychology.assessment === 'not-applicable' ? (
        <PsychologyField
          id={`chr-psych-note-${entry.id}`}
          label={CHARACTER_PSYCHOLOGY_NOTE_FIELD.label}
          hint={CHARACTER_PSYCHOLOGY_NOTE_FIELD.hint}
          placeholder={CHARACTER_PSYCHOLOGY_NOTE_FIELD.placeholder}
          max={CHARACTER_PSYCHOLOGY_NOTE_FIELD.max}
          value={psychology.assessmentNote}
          onCommit={(v) => commit({ assessmentNote: v })}
          disabled={disabled}
        />
      ) : null}
      {CHARACTER_PSYCHOLOGY_EDITOR_FIELDS.map((field) => (
        <PsychologyField
          key={field.name}
          id={`chr-psych-${entry.id}-${field.name}`}
          label={field.label}
          placeholder={field.placeholder}
          max={field.max}
          value={psychology[field.name]}
          onCommit={(v) => commit({ [field.name]: v })}
          disabled={disabled}
        />
      ))}
      <p className="text-[10px] leading-snug text-gray-500">
        Testing pressure and candidate change are what this character sheet EXPECTS. What the story actually
        delivers belongs to the authored character arc on the series, not here.
      </p>
      <div className="space-y-2">
        <span className="block text-[10px] uppercase tracking-wider text-gray-500">Drives</span>
        {PSYCHOLOGY_DRIVE_AXES.map((axis) => (
          <div key={axis} className="space-y-1 border border-port-border/40 rounded p-1.5">
            <p className="text-[10px] uppercase tracking-wider text-gray-400 capitalize">{axis}</p>
            <p className="text-[10px] leading-snug text-gray-500">{CHARACTER_PSYCHOLOGY_DRIVE_HINTS[axis]}</p>
            {CHARACTER_PSYCHOLOGY_DRIVE_LEAVES.map((leaf) => (
              <PsychologyField
                key={leaf.name}
                id={`chr-psych-${entry.id}-${axis}-${leaf.name}`}
                label={`${axis} ${leaf.name}`}
                placeholder={leaf.placeholder}
                max={leaf.max}
                value={drives[axis]?.[leaf.name]}
                onCommit={(v) => commitDrive(axis, { [leaf.name]: v })}
                disabled={disabled}
                rows={1}
              />
            ))}
          </div>
        ))}
      </div>
      <button
        type="button" onClick={() => onPatch?.({ psychology: null })}
        disabled={disabled || !hasProfile}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-400 hover:text-port-error hover:border-port-error disabled:opacity-40"
      >
        <Trash2 size={10} /> Clear psychology profile
      </button>
    </BoxedSection>
  );
}
