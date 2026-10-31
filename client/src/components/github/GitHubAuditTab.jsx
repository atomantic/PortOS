import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ExternalLink, Search, Undo2 } from 'lucide-react';
import Pill from '../ui/Pill';
import ListLoadError from '../ui/ListLoadError';
import useListResource from '../../hooks/useListResource';
import { timeAgo } from '../../utils/formatters';
import {
  applyGitHubAuditSuggestion,
  getGitHubAccounts,
  getGitHubAudit,
  getGitHubAuditChanges,
  runGitHubAudit,
  undoGitHubAuditChange,
  updateGitHubAccount,
} from '../../services/api';

const fetchAccounts = () => getGitHubAccounts({ silent: true });

function suggestionTitle(suggestion) {
  if (suggestion.kind === 'unwatch') return `Unwatch ${suggestion.repo}`;
  if (suggestion.kind === 'mute-handled') return `Mute ${suggestion.threadIds.length} handled thread${suggestion.threadIds.length === 1 ? '' : 's'} in ${suggestion.repo}`;
  if (suggestion.kind === 'custom-watch') return `Watch only releases and security in ${suggestion.repo}`;
  return 'Only get notified about failed workflows';
}

const SUGGESTION_HINTS = {
  unwatch: 'You never acted on these; they come from watching the repo.',
  'mute-handled': 'The PR workflow already handles these CI threads.',
  'custom-watch': 'GitHub only offers this on the repo page: Watch › Custom.',
  'actions-failed-only': 'Set Actions to "Only notify for failed workflows" in your GitHub notification settings.',
};

const CHANGE_LABELS = { unwatch: 'Unwatched', 'mute-handled': 'Muted handled threads in' };

function SuggestionCard({ suggestion, onApply, onSkip, applying }) {
  const { total, acted, handled } = suggestion.stats;
  return (
    <li className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-card p-4">
      <div className="flex flex-wrap items-start gap-2">
        <h3 className="min-w-0 flex-1 break-words font-semibold text-white">{suggestionTitle(suggestion)}</h3>
        {suggestion.applied && <Pill tone="success">Applied</Pill>}
      </div>
      <p className="text-xs text-gray-300">{total} notifications · {acted} you acted on · {handled} handled by PortOS</p>
      <p className="text-xs text-gray-400">{SUGGESTION_HINTS[suggestion.kind]}</p>
      {!suggestion.applied && (
        <div className="flex flex-wrap gap-2">
          {suggestion.apply ? (
            <button type="button" onClick={() => onApply(suggestion.id)} disabled={applying} className="rounded bg-port-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">
              {applying ? 'Applying…' : 'Apply'}
            </button>
          ) : (
            <a href={suggestion.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded bg-port-accent px-3 py-1.5 text-xs text-white">
              <ExternalLink size={12} aria-hidden="true" /> Open on GitHub
            </a>
          )}
          <button type="button" onClick={() => onSkip(suggestion.id)} className="rounded border border-port-border px-3 py-1.5 text-xs text-gray-300">Skip</button>
        </div>
      )}
    </li>
  );
}

export default function GitHubAuditTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { items: accounts, state: accountsState, error: accountsError, retry, setItems: setAccounts } = useListResource(fetchAccounts);
  const accountId = searchParams.get('account') || accounts[0]?.id || null;
  const [audit, setAudit] = useState(null);
  const [running, setRunning] = useState(false);
  const [skipped, setSkipped] = useState(() => new Set());
  const [applyingId, setApplyingId] = useState(null);
  const [changes, setChanges] = useState([]);
  // A failed read must not read as "no audit yet" / "None yet": the first
  // invites a slow re-audit, the second hides Undo for repos it unwatched.
  const [changesFailed, setChangesFailed] = useState(false);
  // 'loading' | 'ready' | 'error' for the stored-audit read of the selected account.
  const [auditState, setAuditState] = useState('loading');
  const [auditAttempt, setAuditAttempt] = useState(0);
  const changesRequestRef = useRef(0);
  const [undoingId, setUndoingId] = useState(null);
  const [savingReport, setSavingReport] = useState(false);

  const loadChanges = useCallback(async () => {
    const request = ++changesRequestRef.current;
    const result = await getGitHubAuditChanges({ silent: true }).catch(() => null);
    if (request !== changesRequestRef.current) return;
    const ok = Array.isArray(result?.changes);
    setChangesFailed(!ok);
    if (ok) setChanges(result.changes);
  }, []);

  useEffect(() => { loadChanges(); }, [loadChanges]);
  useEffect(() => {
    if (!accountId) return undefined;
    let active = true;
    setAudit(null);
    setAuditState('loading');
    getGitHubAudit(accountId, { silent: true })
      .then((result) => {
        if (!active) return;
        setAudit(result?.audit ?? null);
        setAuditState('ready');
      })
      .catch(() => { if (active) setAuditState('error'); });
    return () => { active = false; };
  }, [accountId, auditAttempt]);

  const run = async () => {
    setRunning(true);
    const result = await runGitHubAudit(accountId).catch(() => null);
    setRunning(false);
    if (result) {
      setAudit(result.audit);
      setAuditState('ready');
      setSkipped(new Set());
    }
  };

  const apply = async (suggestionId) => {
    setApplyingId(suggestionId);
    const applied = await applyGitHubAuditSuggestion(accountId, suggestionId).catch(() => null);
    setApplyingId(null);
    if (!applied) return;
    setAudit((prev) => ({ ...prev, suggestions: prev.suggestions.map((entry) => (entry.id === suggestionId ? { ...entry, applied: true } : entry)) }));
    await loadChanges();
  };

  const setMonthlyReport = async (auditReport) => {
    setSavingReport(true);
    const saved = await updateGitHubAccount(accountId, { auditReport }).catch(() => null);
    setSavingReport(false);
    if (saved) setAccounts((prev) => prev.map((account) => (account.id === saved.id ? saved : account)));
  };

  const undo = async (id) => {
    setUndoingId(id);
    const undone = await undoGitHubAuditChange(id).catch(() => null);
    setUndoingId(null);
    if (undone) setChanges((prev) => prev.map((change) => (change.id === id ? { ...change, undone: true } : change)));
  };

  if (accountsState === 'error') return <ListLoadError what="GitHub accounts" error={accountsError} onRetry={retry} />;
  if (accountsState === 'loading') return <p className="text-sm text-gray-400">Loading accounts…</p>;
  if (!accounts.length) {
    return (
      <p className="rounded-lg border border-port-border bg-port-card p-4 text-sm text-gray-400">
        No GitHub accounts yet. <Link to="/devtools/github/accounts" className="text-port-accent">Add one</Link>
      </p>
    );
  }

  const visible = audit?.suggestions.filter((suggestion) => !skipped.has(suggestion.id)) || [];
  const selected = accounts.find((account) => account.id === accountId);

  return (
    <div className="min-w-0 space-y-4">
      <section className="space-y-3 rounded-lg border border-port-border bg-port-card p-4" aria-label="Run notification audit">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor="github-audit-account" className="block text-xs text-gray-400">Account</label>
            <select
              id="github-audit-account"
              value={accountId || ''}
              onChange={(event) => setSearchParams({ account: event.target.value }, { replace: true })}
              className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white"
            >
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
            </select>
          </div>
          <button type="button" onClick={run} disabled={running || !accountId} className="inline-flex items-center gap-1.5 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50">
            <Search size={14} aria-hidden="true" /> {running ? 'Auditing…' : 'Run audit'}
          </button>
        </div>
        {running && (
          <div role="status" className="space-y-1">
            <div className="h-1.5 overflow-hidden rounded bg-port-border"><div className="h-full w-1/3 animate-pulse rounded bg-port-accent" /></div>
            <p className="text-xs text-gray-400">Reading watched repos and the last 30 days of notifications…</p>
          </div>
        )}
        {audit && !running && (
          <p className="text-xs text-gray-300">
            Last {audit.windowDays} days: {audit.summary.total} notifications in {audit.summary.repos} repos · {audit.summary.acted} you acted on · {audit.summary.handled} handled by PortOS · audited {timeAgo(audit.ranAt)}
          </p>
        )}
        {audit && !audit.watchedListed && <p className="text-xs text-port-warning">GitHub did not list your watched repos, so there are no unwatch suggestions this time.</p>}
        {!audit && !running && auditState === 'loading' && accountId && <p className="text-xs text-gray-500">Loading the last audit…</p>}
        {!audit && !running && auditState === 'error' && <ListLoadError what="the last audit" onRetry={() => setAuditAttempt((n) => n + 1)} />}
        {!audit && !running && auditState === 'ready' && <p className="text-xs text-gray-500">Nothing changes until you tap Apply on a suggestion.</p>}
        <div className="flex items-center gap-2">
          <input
            id="github-audit-monthly"
            type="checkbox"
            checked={selected?.auditReport === true}
            disabled={savingReport || !selected}
            onChange={(event) => setMonthlyReport(event.target.checked)}
            className="h-4 w-4 accent-port-accent"
          />
          <label htmlFor="github-audit-monthly" className="text-xs text-gray-300">Send me this audit monthly as a notification (needs the scheduled check on)</label>
        </div>
      </section>

      {audit && (visible.length ? (
        <ul className="grid grid-cols-1 gap-3 @3xl/page:grid-cols-2">
          {visible.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              applying={applyingId === suggestion.id}
              onApply={apply}
              onSkip={(id) => setSkipped((prev) => new Set(prev).add(id))}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-port-border bg-port-card p-4 text-sm text-gray-400">No suggestions: your notifications look useful.</p>
      ))}

      <section className="space-y-2 rounded-lg border border-port-border bg-port-card p-4" aria-label="Applied audit changes">
        <h2 className="font-semibold text-white">Applied changes</h2>
        {changesFailed && <ListLoadError what="applied changes" onRetry={loadChanges} />}
        {changes.length === 0 ? (
          !changesFailed && <p className="text-xs text-gray-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-port-border">
            {changes.map((change) => (
              <li key={change.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <p className="min-w-0 flex-1 break-words text-xs text-gray-300">
                  {CHANGE_LABELS[change.kind] || change.kind} <span className="font-mono">{change.repo}</span>
                  {change.threadCount !== null ? ` (${change.threadCount})` : ''} · {change.accountLabel} · {timeAgo(change.appliedAt)}
                </p>
                {change.undone ? (
                  <Pill tone="muted">Undone</Pill>
                ) : (
                  <button
                    type="button"
                    onClick={() => undo(change.id)}
                    disabled={undoingId === change.id}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300 disabled:opacity-50"
                  >
                    <Undo2 size={12} aria-hidden="true" /> Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
