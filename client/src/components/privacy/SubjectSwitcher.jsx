import { Users, Settings2 } from 'lucide-react';
import { SELF_SUBJECT_ID, SUBJECT_RELATIONSHIPS, labelFor } from './constants';

// Whose PII is on screen (#3658). The API scopes each read to ONE subject, so
// this switcher IS the Privacy Center's subject filter, not a per-tab control.
//
// Scoping to someone other than `self` tints the control: this bar sits directly
// above the tab content, which is what keeps "whose address is this?" from ever
// being ambiguous.
export default function SubjectSwitcher({ subjects, subjectId, onChange, onManage }) {
  const active = subjects.find((s) => s.id === subjectId);
  // Derive "is this me?" from the id, NOT from the resolved row. The tabs fetch
  // on `subjectId` immediately, so deciding from `active` would leave the bar
  // styled as self — with no warning — for the whole window before the subject
  // list arrives, while someone else's PII is already on screen. An id we can't
  // resolve (stale `?subject=` deep link) is likewise not self.
  const isSelf = subjectId === SELF_SUBJECT_ID;

  return (
    <div className={`flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg border ${
      isSelf ? 'border-port-border bg-port-card' : 'border-port-warning/40 bg-port-warning/5'
    }`}
    >
      <Users size={15} className={isSelf ? 'text-gray-500' : 'text-port-warning'} />
      <label htmlFor="privacy-subject-select" className="text-[11px] uppercase tracking-wide text-gray-500">
        Subject
      </label>
      <select
        id="privacy-subject-select"
        value={subjectId}
        onChange={(e) => onChange(e.target.value)}
        className="px-2 py-1 text-sm rounded bg-port-bg border border-port-border text-gray-200"
      >
        {/* A stale ?subject= deep link (subject since deleted) keeps a labeled
            option so the select never renders blank. Gated on the list having
            loaded — before that, EVERY id looks unknown. */}
        {subjects.length > 0 && !active && <option value={subjectId}>Unknown subject</option>}
        {subjects.map((s) => (
          <option key={s.id} value={s.id}>
            {s.displayName}{s.isSelf ? '' : ` · ${labelFor(SUBJECT_RELATIONSHIPS, s.relationship)}`}
          </option>
        ))}
      </select>

      {!isSelf && (
        <span className="text-[11px] text-port-warning">
          Viewing {active ? `${active.displayName}’s` : 'another household member’s'} records — not your own
        </span>
      )}

      <button
        onClick={onManage}
        className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-border/40"
      >
        <Settings2 size={14} /> Household
      </button>
    </div>
  );
}
