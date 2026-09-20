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
  const lowerBound = data?.partial || Boolean(error);
  const groups = [{ label: 'Required', items: required }, { label: 'Optional recommendations', items: optional }];
  return (
    <section className={compact ? '@container p-4' : '@container bg-port-card border border-port-border rounded-xl p-4'} aria-labelledby={heading}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 id={heading} className="text-sm font-semibold text-port-text">{title}</h3>
        {data && <span className="text-xs text-port-warning">{lowerBound ? 'At least ' : ''}{formatCount(required.length)} required</span>}
      </div>
      {loading && !data && <p role="status" className="text-sm text-port-text-muted">Loading actions…</p>}
      {error && <p role="alert" className="text-sm text-port-warning">{data ? 'Actions could not refresh. Showing the last known actions.' : 'Actions unavailable.'} <button type="button" onClick={live.refetch} className="underline min-h-[44px]">Retry</button></p>}
      {data?.partial && <p role="status" className="text-xs text-port-warning mb-2">Some sources are unavailable or truncated. Counts are lower bounds.</p>}
      {data && !error && !data.partial && items.length === 0 && <p className="text-sm text-port-text-muted">All caught up!</p>}
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
