import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import KanbanBoard from '../../KanbanBoard';
import JiraConfigPanel from '../JiraConfigPanel';
import * as api from '../../../services/api';

/**
 * Everything JIRA for one app: the integration config and the sprint Kanban
 * board it drives. Both used to live elsewhere (the config inside the Edit App
 * drawer, the board buried in the Overview tab) — they belong together, and the
 * board needs the full page width the drawer never had.
 */
export default function JiraTab({ app, onRefresh }) {
  const [tickets, setTickets] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestRef = useRef(0);

  const configured = !!(app?.jira?.enabled && app.jira.instanceId && app.jira.projectKey);

  // Same sentinel contract as the /apps list (#3437): a failed fetch records a
  // message instead of collapsing into `[]`, which read as "you have no sprint
  // tickets" and offered no way to retry.
  const loadSprintTickets = useCallback(() => {
    if (!configured) return;
    // Generation guard: a Retry (or a JIRA-config change) while an earlier
    // request is still open must not let the older response land last.
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    const isCurrent = () => requestRef.current === generation;

    setLoading(true);
    setError(null);
    api.getMySprintTickets(app.jira.instanceId, app.jira.projectKey, { silent: true })
      .then(rows => { if (isCurrent()) setTickets(Array.isArray(rows) ? rows : []); })
      .catch(err => { if (isCurrent()) setError(err?.message || 'Request failed'); })
      .finally(() => { if (isCurrent()) setLoading(false); });
  }, [configured, app?.jira?.instanceId, app?.jira?.projectKey]);

  useEffect(() => { loadSprintTickets(); }, [loadSprintTickets]);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">JIRA Configuration</div>
        {/* Re-seed the form when the underlying record actually changes.
            AppDetailView refetches `app` on every `apps:changed` socket event
            (a peer sync, a second browser tab, the Edit App drawer saving), and
            the panel seeds its state from `app.jira` in a useState initializer —
            without this key it would keep its first-render snapshot and write
            those stale values back on the next Save, which is the exact clobber
            splitting the config out was meant to end. Keyed on `updatedAt`, not
            the object, so an identical refetch doesn't discard an in-progress edit. */}
        <JiraConfigPanel key={app.updatedAt || app.id} app={app} onSaved={onRefresh} />
      </div>

      {configured && (
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">My Sprint Tickets</div>
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400">
              <BrailleSpinner text="" />
              <span>Loading tickets...</span>
            </div>
          ) : error ? (
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-port-card border border-port-error/30 rounded-lg max-w-5xl">
              <AlertTriangle size={16} className="text-port-error shrink-0" />
              <span className="text-sm text-gray-300 min-w-0">Couldn&apos;t load sprint tickets — {error}</span>
              <button
                onClick={loadSprintTickets}
                className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                aria-label={`Retry loading sprint tickets for ${app.name}`}
              >
                <RefreshCw size={14} /> Retry
              </button>
            </div>
          ) : tickets?.length > 0 ? (
            <KanbanBoard
              tickets={tickets}
              instanceId={app.jira.instanceId}
              onTicketsChange={setTickets}
              appId={app.id}
              projectKey={app.jira.projectKey}
              boardId={app.jira.boardId}
            />
          ) : (
            <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg max-w-5xl">
              No tickets assigned to you in the current sprint
            </div>
          )}
        </div>
      )}
    </div>
  );
}
