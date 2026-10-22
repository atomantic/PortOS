import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Play } from 'lucide-react';
import Pill from '../ui/Pill';
import LoadFailedState from '../ui/LoadFailedState';
import PageSkeleton from '../ui/PageSkeleton';
import { timeAgo } from '../../utils/formatters';
import socket from '../../services/socket';
import {
  getGitHubAutomations,
  setGitHubNotificationCadence,
  syncGitHubNotifications,
} from '../../services/api';

const MODE_VIEW = {
  observe: { label: 'Observe', hint: 'Records a decision for each notification; changes nothing on GitHub.' },
  assist: { label: 'Assist', hint: 'Coming next: runs only safe actions after screening.' },
  autopilot: { label: 'Autopilot', hint: 'Coming later: hands work to agents in your own repos.' },
};

const CADENCE_TEXT = {
  'weekdays-15m': 'Every 15 minutes on weekdays',
  custom: 'On a custom schedule (CoS › Schedule)',
  off: 'Only when you tap Run now',
};

function AccountCard({ account, running, onRun }) {
  const mode = MODE_VIEW[account.mode] || MODE_VIEW.observe;
  return (
    <li className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-card p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-white">{account.label}</h3>
          <p className="truncate font-mono text-xs text-gray-400">{account.host}</p>
        </div>
        <Pill tone="muted">{mode.label}</Pill>
        {!account.enabled && <Pill tone="warning">Off</Pill>}
      </div>
      <p className="text-xs text-gray-400">{mode.hint}</p>
      <p className="text-xs text-gray-300">
        {account.lastSyncAt ? `Checked ${timeAgo(account.lastSyncAt)}` : 'Not checked yet'}
        {' · '}{account.needsYou} open{account.suspect ? ` · ${account.suspect} suspect` : ''}{account.pending ? ` · ${account.pending} waiting for triage` : ''}
      </p>
      {account.lastError && <p role="alert" className="break-words text-xs text-port-error">{account.lastError}</p>}
      <button
        type="button"
        onClick={() => onRun(account.id)}
        disabled={running || !account.enabled}
        className="inline-flex items-center gap-1.5 rounded border border-port-border px-3 py-1.5 text-xs text-gray-300 disabled:opacity-50"
      >
        <Play size={12} aria-hidden="true" /> {running ? 'Checking…' : 'Run now'}
      </button>
    </li>
  );
}

export default function GitHubAutomationsTab() {
  const [overview, setOverview] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [runningId, setRunningId] = useState(null);
  const [savingCadence, setSavingCadence] = useState(false);

  const load = useCallback(async () => {
    const result = await getGitHubAutomations({ silent: true }).catch(() => null);
    if (!result) {
      setLoadFailed(true);
      return;
    }
    setLoadFailed(false);
    setOverview(result);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    socket.on('github:notifications:changed', load);
    socket.on('connect', load);
    return () => {
      socket.off('github:notifications:changed', load);
      socket.off('connect', load);
    };
  }, [load]);

  const runNow = async (accountId) => {
    setRunningId(accountId);
    // A failed check is recorded on the account and shown on its card.
    await syncGitHubNotifications(accountId, { silent: true }).catch(() => null);
    setRunningId(null);
    await load();
  };

  const toggleCadence = async () => {
    setSavingCadence(true);
    const next = overview.cadence === 'weekdays-15m' ? 'off' : 'weekdays-15m';
    const updated = await setGitHubNotificationCadence(next).catch(() => null);
    setSavingCadence(false);
    if (updated) setOverview(updated);
  };

  if (loadFailed && !overview) return <LoadFailedState title="Could not load GitHub automations." hint="Retry the local read." onRetry={load} />;
  if (!overview) return <PageSkeleton label="Loading GitHub automations" titleWidthClass="w-40" showAction={false} cards={2} />;

  return (
    <div className="min-w-0 space-y-4">
      <section className="space-y-2 rounded-lg border border-port-border bg-port-card p-4" aria-label="Notification check schedule">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-semibold text-white">Notification check</h2>
            <p className="text-xs text-gray-400">{CADENCE_TEXT[overview.cadence] || CADENCE_TEXT.off}</p>
          </div>
          <button
            type="button"
            onClick={toggleCadence}
            disabled={savingCadence || overview.cadence === 'custom'}
            aria-pressed={overview.cadence === 'weekdays-15m'}
            className="shrink-0 rounded bg-port-accent px-3 py-2 text-xs text-white disabled:opacity-50"
          >
            {overview.cadence === 'weekdays-15m' ? 'Turn off schedule' : 'Check every 15 min on weekdays'}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Each check reads notification details only and applies fixed rules; no AI is used.
          {overview.lastSummary ? ` Last run: ${overview.lastSummary}.` : ''}
        </p>
      </section>

      {overview.accounts.length === 0 ? (
        <p className="rounded-lg border border-port-border bg-port-card p-4 text-sm text-gray-400">
          No GitHub accounts yet. <Link to="/devtools/github/accounts" className="text-port-accent">Add one</Link>
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 @3xl/page:grid-cols-2">
          {overview.accounts.map((account) => (
            <AccountCard key={account.id} account={account} running={runningId === account.id} onRun={runNow} />
          ))}
        </ul>
      )}
    </div>
  );
}
