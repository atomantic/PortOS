/**
 * Findings triage for the Editorial Checks page (#1285): the check-sourced
 * comments seeded into the manuscript review store, grouped by check with
 * severity counts. Each finding deep-links into the manuscript editor (which
 * opens its comment card via the `?comment=` param) where the existing
 * Accept / Dismiss / Generate-fix flow lives — this view is read + navigate
 * only, so triage logic stays in one place.
 */
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import { groupFindingsByCheck, findingManuscriptLink, openFindingsTotal } from '../../../lib/editorialChecks';

const SEVERITY_DOT = {
  high: 'bg-rose-400',
  medium: 'bg-amber-400',
  low: 'bg-gray-400',
};
const STATUS_TONE = {
  open: 'text-gray-200',
  accepted: 'text-emerald-400 line-through',
  dismissed: 'text-gray-600 line-through',
};

function CountPills({ counts }) {
  return (
    <span className="flex items-center gap-1.5">
      {['high', 'medium', 'low'].map((sev) => (counts[sev] ? (
        <span key={sev} className="flex items-center gap-1 text-[10px] text-gray-400">
          <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[sev]}`} />
          {counts[sev]}
        </span>
      ) : null))}
    </span>
  );
}

function CheckGroup({ seriesId, group }) {
  const [open, setOpen] = useState(group.open > 0);
  return (
    <div className="rounded-lg border border-port-border bg-port-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 p-2.5 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {open ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
          <span className="text-sm font-medium text-gray-100 truncate">{group.label}</span>
          <span className="text-[10px] text-gray-500 shrink-0">{group.open} open · {group.total} total</span>
        </span>
        <CountPills counts={group.counts} />
      </button>
      {open ? (
        <ul className="divide-y divide-port-border/60 border-t border-port-border/60">
          {group.comments.map((c) => (
            <li key={c.id} className="p-2.5">
              <Link
                to={findingManuscriptLink(seriesId, c)}
                className="group flex items-start justify-between gap-2"
              >
                <span className="min-w-0 space-y-0.5">
                  <span className={`block text-xs ${STATUS_TONE[c.status] || STATUS_TONE.open}`}>
                    <span className={`mr-1.5 inline-block h-2 w-2 rounded-full align-middle ${SEVERITY_DOT[c.severity] || SEVERITY_DOT.low}`} />
                    {c.problem}
                  </span>
                  {c.location ? <span className="block text-[11px] text-gray-500">{c.location}</span> : null}
                </span>
                <ExternalLink size={13} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-port-accent" />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function EditorialFindingsTriage({ seriesId, comments = [], checksById = {} }) {
  const groups = useMemo(() => groupFindingsByCheck(comments, checksById), [comments, checksById]);
  if (!groups.length) {
    return (
      <p className="rounded-lg border border-dashed border-port-border p-4 text-center text-xs text-gray-500">
        No editorial-check findings yet. Run the enabled checks to populate this list.
      </p>
    );
  }
  const totalOpen = openFindingsTotal(groups);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-500">{totalOpen} open finding{totalOpen === 1 ? '' : 's'} across {groups.length} check{groups.length === 1 ? '' : 's'}</p>
      {groups.map((g) => <CheckGroup key={g.checkId} seriesId={seriesId} group={g} />)}
    </div>
  );
}
