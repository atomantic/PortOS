/**
 * Issue tab strip for the Manuscript editor — one deep-linkable tab per issue
 * (`/pipeline/series/:id/manuscript/:issueNumber`), so the editor focuses one
 * issue at a time instead of one page-length scroll of every issue. Each tab
 * carries a badge with its count of open editorial notes anchored in the current
 * format, so where the feedback lives is visible at a glance.
 */

import { Link } from 'react-router-dom';

export default function ManuscriptIssueTabs({ seriesId, sections, activeNumber, openCountByNumber }) {
  if (sections.length === 0) return null;
  return (
    <nav
      aria-label="Issues"
      className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto bg-port-bg/95 backdrop-blur py-1 px-1"
    >
      {sections.map((s) => {
        const active = s.number === activeNumber;
        const count = openCountByNumber.get(s.number) || 0;
        return (
          <Link
            key={s.issueId}
            to={`/pipeline/series/${seriesId}/manuscript/${s.number}`}
            aria-current={active ? 'page' : undefined}
            title={s.title ? `Issue ${s.number} — ${s.title}` : `Issue ${s.number}`}
            className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
              active
                ? 'bg-port-accent text-white border-port-accent'
                : 'bg-port-card text-gray-300 border-port-border hover:text-white hover:border-port-accent/40'
            }`}
          >
            <span>Issue {s.number}</span>
            {s.title ? <span className="max-w-[10rem] truncate opacity-70">{s.title}</span> : null}
            {count > 0 ? (
              <span className={`ml-0.5 px-1 rounded-full text-[10px] ${active ? 'bg-white/20' : 'bg-port-accent/20 text-port-accent'}`}>
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
