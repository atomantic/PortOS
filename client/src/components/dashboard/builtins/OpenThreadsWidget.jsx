import { Link } from 'react-router';
import { ListTodo, Pin } from 'lucide-react';
import * as api from '../../../services/api';
import { useAutoRefetch } from '../../../hooks/useAutoRefetch';
import { isThreadOverdue, threadNextLine } from '../../../lib/brainThreads.js';
import { formatCount, formatDateShort } from '../../../utils/formatters';

// The Brain bullet journal's open loops (#7664) with the next action on each,
// so what you are on the hook for is one glance away. A *thread* here is a
// tracked topic, never a message thread. Rows deep-link to `?thread=<id>`,
// which opens the record's drawer on the Threads tab.
//
// Deliberately narrower than the tab's working set: `someday` is parked by
// definition, so the widget asks the server for open + waiting only, and only
// the first page — `total` carries the count without shipping the rest.
// Self-fetched (like UpcomingTasksWidget) rather than read off dashboardState:
// nothing else on the dashboard needs the list.
const ROWS = 6;
const WIDGET_STATUSES = 'open,waiting';

export default function OpenThreadsWidget() {
  const { data, loading } = useAutoRefetch(
    () => api.listThreads({ status: WIDGET_STATUSES, limit: ROWS, offset: 0 }, { silent: true }),
    60_000,
  );

  if (loading && !data) return null;

  const rows = Array.isArray(data?.threads) ? data.threads : [];
  const total = Number.isFinite(data?.total) ? data.total : rows.length;

  return (
    <div className="@container bg-port-card border border-port-border rounded-xl p-4 h-full">
      <div className="flex items-center justify-between gap-2 mb-3">
        <Link to="/brain/threads" className="flex items-center gap-2 hover:text-port-accent">
          <ListTodo size={16} className="text-gray-500" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-white">Open Threads</h3>
        </Link>
        {total > 0 && <span className="text-xs text-gray-500">{formatCount(total)} open</span>}
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-gray-500">
          No open loops. <Link to="/brain/threads" className="text-port-accent hover:underline">Track one</Link>
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((t) => {
            const nextLine = threadNextLine(t);
            return (
              <li key={t.id}>
                <Link to={`/brain/threads?thread=${encodeURIComponent(t.id)}`} className="group flex items-start gap-2 text-xs">
                  {t.pinned
                    ? <Pin size={12} className="shrink-0 mt-0.5 text-port-accent" aria-label="Pinned" />
                    : <span className="shrink-0 mt-1 w-2 h-2 rounded-full border border-port-border" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-gray-300 group-hover:text-white" title={t.title}>{t.title}</span>
                    {nextLine && <span className="block truncate text-gray-500">{nextLine}</span>}
                  </span>
                  {t.dueAt && (
                    <span className={`shrink-0 ${isThreadOverdue(t) ? 'text-port-error' : 'text-gray-500'}`}>{formatDateShort(t.dueAt)}</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {total > rows.length && (
        <Link to="/brain/threads" className="block text-xs text-gray-500 hover:text-port-accent mt-2">
          +{formatCount(total - rows.length)} more
        </Link>
      )}
    </div>
  );
}
