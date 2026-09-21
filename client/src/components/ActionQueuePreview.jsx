import { useId } from 'react';
import { Link } from 'react-router';
import { useActionQueue } from '../hooks/useActionQueue';
import { formatCount } from '../utils/formatters';

export const actionSelectionLink = (id) => `/review/${encodeURIComponent(id)}?view=today`;

/** The same canonical rows and failure contract in every compact surface. */
export default function ActionQueuePreview({ title = 'Actions', sources, queue, onSelect, compact = false }) {
  const live = useActionQueue();
  const { data, loading, error } = queue || live;
  const heading = useId();
  const items = (data?.items || []).filter((item) => !sources || sources.includes(item.source));
  const required = items.filter((item) => item.required === true);
  const optional = items.filter((item) => item.isRecommendation === true);
  const sourceStates = Object.entries(data?.sources || {})
    .filter(([source]) => !sources || sources.includes(source));
  const unavailable = sourceStates.filter(([, state]) => state.availability === 'unavailable' || state.available === false);
  const limited = sourceStates.filter(([, state]) => state.truncation);
  const morePages = sourceStates.some(([, state]) => state.lowerBound > state.shown)
    || (!sources && Boolean(data?.nextCursor));
  // Older servers may not identify the partial source. Keep that uncertainty,
  // but do not spread another source's preview cap into a filtered widget.
  const unknownPartial = data?.partial && sourceStates.length === 0;
  const lowerBound = unavailable.length > 0 || limited.length > 0 || morePages || unknownPartial || Boolean(error);
  const sourceNames = (entries) => entries.map(([source, state]) => state.label || source).join(', ');
  const groups = [{ label: 'Required', items: required }, { label: 'Optional recommendations', items: optional }];
  return (
    <section className={compact ? '@container p-4' : '@container bg-port-card border border-port-border rounded-xl p-4'} aria-labelledby={heading}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 id={heading} className="text-sm font-semibold text-port-text">{title}</h3>
        {data && <span className="text-xs text-port-warning">{lowerBound ? 'At least ' : ''}{formatCount(required.length)} required</span>}
      </div>
      {loading && !data && <p role="status" className="text-sm text-port-text-muted">Loading actions…</p>}
      {error && <p role="alert" className="text-sm text-port-warning">{data ? 'Actions could not refresh. Showing the last known actions.' : 'Actions unavailable.'} <button type="button" onClick={live.refetch} className="underline min-h-[44px]">Retry</button></p>}
      {unavailable.length > 0 && <p role="status" className="text-xs text-port-warning mb-2">Could not load {sourceNames(unavailable)}. <button type="button" onClick={live.refetch} className="underline min-h-[44px]">Retry</button> <Link to="/review?view=today" onClick={onSelect} className="underline">View source details</Link></p>}
      {limited.length > 0 && <p className="text-xs text-port-text-muted mb-2">Showing a limited preview of {sourceNames(limited)}. Open Actions for source details.</p>}
      {unknownPartial && <p role="status" className="text-xs text-port-text-muted mb-2">Action counts are incomplete. Open Actions for source details.</p>}
      {morePages && <p className="text-xs text-port-text-muted mb-2">More actions are available in Open Actions.</p>}
      {data && !lowerBound && items.length === 0 && <p className="text-sm text-port-text-muted">All caught up!</p>}
      {groups.map((group) => group.items.length > 0 && (
        <div key={group.label} className="mb-3">
          <h4 className="text-xs text-port-text-muted mb-1">{group.label}</h4>
          <ul aria-label={group.label} className="space-y-1">
            {group.items.slice(0, 5).map((item) => (
              <li key={item.id} data-action-id={item.id}>
                <Link to={actionSelectionLink(item.id)} onClick={onSelect} className="block min-h-[44px] p-2 rounded hover:bg-port-border/50 focus:outline-hidden focus:ring-2 focus:ring-port-accent">
                  <span className="block text-sm text-port-text break-words">{item.title}</span>
                  <span className="block text-xs text-port-text-muted line-clamp-2">{item.reason || item.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <Link to="/review?view=today" onClick={onSelect} className="inline-flex items-center min-h-[44px] text-sm text-port-accent">Open Actions</Link>
    </section>
  );
}
