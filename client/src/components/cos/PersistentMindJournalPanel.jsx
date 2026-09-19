import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ListChecks, RefreshCw, Undo2 } from 'lucide-react';
import * as api from '../../services/api';
import BrailleSpinner from '../BrailleSpinner';
import Banner from '../ui/Banner';
import { formatCount, timeAgo } from '../../utils/formatters';

// Mirrors PERSISTENT_MIND_JOURNAL_KINDS. The server ships the authoritative
// list in the response; this map only supplies the human labels and the order
// the panel reads best in, so an unknown kind still renders under its own id.
const KIND_LABELS = {
  commitment: 'Commitments',
  open_question: 'Open questions',
  decision: 'Decisions',
  risk: 'Risks',
  goal: 'Goals',
  preference: 'Preferences',
};
const KIND_ORDER = ['commitment', 'open_question', 'decision', 'risk', 'goal', 'preference'];

const kindLabel = (kind) => KIND_LABELS[kind] || kind;

const orderedKinds = (kinds) => [
  ...KIND_ORDER.filter((kind) => kinds.includes(kind)),
  ...kinds.filter((kind) => !KIND_ORDER.includes(kind)),
];

export default function PersistentMindJournalPanel({ refreshKey = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showRetired, setShowRetired] = useState(false);
  const [pendingId, setPendingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    return api.getPersistentMindJournal({ silent: true })
      .then(setData)
      .catch((nextError) => setError(nextError?.message || 'Could not load the decision journal'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const events = useMemo(() => data?.events || [], [data]);
  const active = useMemo(() => events.filter((event) => event.status === 'active'), [events]);
  const resolved = useMemo(() => events.filter((event) => event.status === 'resolved'), [events]);
  const retired = useMemo(() => events.filter((event) => event.status === 'superseded'), [events]);
  const byId = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);

  // Reactive swap rather than a refetch: the server returns the one record it
  // changed, and re-reading the whole journal would scroll a long list back.
  const correct = async (event, action) => {
    setPendingId(event.id);
    setError(null);
    await api.correctPersistentMindJournalEvent(event.id, { action }, { silent: true })
      .then((result) => setData((current) => (current ? {
        ...current,
        events: current.events.map((candidate) => (candidate.id === result.event.id ? result.event : candidate)),
      } : current)))
      .catch((nextError) => setError(nextError?.message || 'Could not update the entry'))
      .finally(() => setPendingId(null));
  };

  if (loading && !data) return <div className="flex justify-center p-10"><BrailleSpinner text="Loading decision journal" /></div>;

  return (
    <section className="space-y-4" aria-labelledby="mind-journal-heading">
      {error && <Banner tone="error" title="Journal unavailable">{error}</Banner>}

      <div className="flex flex-wrap items-start justify-between gap-3 rounded border border-port-border bg-port-card p-4">
        <div>
          <h3 id="mind-journal-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text">
            <ListChecks size={17} aria-hidden="true" /> Decision journal
          </h3>
          <p className="mt-1 text-xs text-port-text-muted">
            What the mind decided, owes, is still asking and is watching — each entry drawn from specific messages. Retiring an entry never deletes it: it stops being quoted as current and stays readable below. {formatCount(active.length, { fallback: '0' })} active · {formatCount(resolved.length, { fallback: '0' })} settled · {formatCount(retired.length, { fallback: '0' })} retired.
          </p>
        </div>
        <button type="button" onClick={() => load()} disabled={loading} className="flex items-center gap-2 rounded border border-port-border px-3 py-1.5 text-xs text-port-text disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
        </button>
      </div>

      {active.length === 0 && resolved.length === 0 && retired.length === 0 && (
        <p className="rounded border border-dashed border-port-border p-6 text-center text-xs text-port-text-muted">
          Nothing recorded yet. Entries appear when the mind seals an older stretch of conversation — greetings and tool chatter produce none.
        </p>
      )}

      {orderedKinds([...new Set(active.map((event) => event.kind))]).map((kind) => (
        <div key={kind} className="rounded border border-port-border bg-port-card p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">{kindLabel(kind)}</h4>
          <ul className="mt-2 space-y-2">
            {active.filter((event) => event.kind === kind).map((event) => (
              <li key={event.id} className="rounded border border-port-border bg-port-bg/40 p-3">
                <p className="text-sm text-port-text">{event.statement}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-port-text-muted">
                  <span>from message{event.sourceSequences.length === 1 ? '' : 's'} {event.sourceSequences.join(', ')}</span>
                  <span>· {timeAgo(event.updatedAt)}</span>
                  <button type="button" disabled={pendingId === event.id} onClick={() => correct(event, 'resolve')} className="flex items-center gap-1 text-port-accent hover:underline disabled:opacity-50">
                    <CheckCircle2 size={13} aria-hidden="true" /> Mark settled
                  </button>
                  <button type="button" disabled={pendingId === event.id} onClick={() => correct(event, 'retire')} className="flex items-center gap-1 text-port-warning hover:underline disabled:opacity-50">
                    <Undo2 size={13} aria-hidden="true" /> Retire
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {resolved.length > 0 && (
        <details className="rounded border border-port-border bg-port-card p-4">
          <summary className="cursor-pointer text-xs font-semibold text-port-text">Settled ({formatCount(resolved.length, { fallback: '0' })})</summary>
          <ul className="mt-2 space-y-2">
            {resolved.map((event) => (
              <li key={event.id} className="rounded bg-port-bg/40 p-3 text-xs">
                <p className="text-port-text">{event.statement}</p>
                <p className="mt-1 text-port-text-muted">
                  {kindLabel(event.kind)} · settled {timeAgo(event.updatedAt)} by the {event.retiredBy === 'user' ? 'user' : 'mind'}{event.resolution ? ` — ${event.resolution}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {retired.length > 0 && (
        <div className="rounded border border-port-border bg-port-card p-4">
          <button type="button" onClick={() => setShowRetired((current) => !current)} aria-expanded={showRetired} className="text-xs font-semibold text-port-text">
            {showRetired ? 'Hide' : 'Show'} retired entries ({formatCount(retired.length, { fallback: '0' })})
          </button>
          {showRetired && (
            <ul className="mt-2 space-y-2">
              {retired.map((event) => {
                const replacement = event.supersededBy ? byId.get(event.supersededBy) : null;
                return (
                  <li key={event.id} className="rounded bg-port-bg/40 p-3 text-xs">
                    <p className="text-port-text-muted line-through">{event.statement}</p>
                    <p className="mt-1 text-port-text-muted">
                      {kindLabel(event.kind)} · retired {timeAgo(event.updatedAt)} by the {event.retiredBy === 'user' ? 'user' : 'mind'}
                    </p>
                    <p className="mt-1 text-port-text">
                      {replacement
                        ? <>Replaced by: {replacement.statement}</>
                        : event.supersededBy
                          ? 'Replaced by an entry that has since left retention.'
                          : 'Retired with no replacement.'}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
