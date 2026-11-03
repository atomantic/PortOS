import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowUpCircle, ChevronRight, Package, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import BrailleSpinner from '../BrailleSpinner';
import LoadFailedState from '../ui/LoadFailedState';
import * as api from '../../services/api';
import socket from '../../services/socket';
import { useSocketResource } from '../../hooks/useSocketResource';
import { usePortosRestartWatch } from '../../hooks/usePortosRestartWatch';
import { formatDateTime } from '../../utils/formatters';

const EVENTS = ['portos:node-runtime:changed', 'review:queue:changed'];
const readInventory = () => api.getSoftwareInventory({ silent: true });

const STATE_ORDER = ['security', 'attention', 'update', 'unknown', 'current', 'missing', 'unsupported'];
const STATES = {
  security: { label: 'Security update', tone: 'error' },
  attention: { label: 'Needs attention', tone: 'warning' },
  update: { label: 'Update available', tone: 'accent' },
  unknown: { label: 'Unknown', tone: 'muted' },
  current: { label: 'Current', tone: 'success' },
  missing: { label: 'Not installed', tone: 'note' },
  unsupported: { label: 'Not on this platform', tone: 'note' },
};
const HIDDEN_BY_DEFAULT = new Set(['missing', 'unsupported']);

// Each action is the component home's own endpoint, so guards (busy install,
// pinned formula, unsupported platform) behave exactly as they do there.
const ACTIONS = {
  'node-update': (action) => api.updateNodeRuntime(action.version),
  'pm2-sync': () => api.updatePm2Runtime(),
  'ytdlp-update': () => api.updateYtDlp(),
  'ollama-upgrade': () => api.upgradeLocalLlmBackend('ollama'),
};

// Actions whose request returns `started` while the work continues on the server.
const BACKGROUND_JOBS = new Set(['pm2-sync']);

const rank = (row) => STATE_ORDER.indexOf(row.state);

function Versions({ row }) {
  if (!row.version && !row.latest) return null;
  const differs = row.latest && row.version && row.latest !== row.version;
  return (
    <span className="font-mono text-xs text-gray-300">
      {row.version || '—'}
      {differs && <span className="text-gray-500"> → <span className="text-port-accent">{row.latest}</span></span>}
    </span>
  );
}

function SoftwareRow({ row, pending, onAction }) {
  const state = STATES[row.state] || STATES.unknown;
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-white">{row.name}</span>
          <Pill tone={state.tone} size="xs">{state.label}</Pill>
          <Versions row={row} />
          {row.busy && <Pill tone="warning" size="xs">{row.busy}</Pill>}
        </div>
        {row.summary && <p className="text-xs text-gray-400 break-words">{row.summary}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {row.action && (
          <button
            type="button"
            onClick={() => onAction(row)}
            disabled={pending !== null}
            title={row.action.restarts ? 'PortOS restarts to finish this update.' : undefined}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded border border-port-accent/40 bg-port-accent/10 px-3 text-xs text-port-accent hover:bg-port-accent/20 disabled:opacity-50"
          >
            {pending === row.id ? <BrailleSpinner /> : <ArrowUpCircle size={13} />}
            {row.action.label}
          </button>
        )}
        {row.home && (
          <Link
            to={row.home.path}
            className="inline-flex min-h-[36px] items-center gap-1 rounded border border-port-border px-3 text-xs text-gray-300 hover:border-port-accent hover:text-white"
          >
            {row.home.label} <ChevronRight size={13} />
          </Link>
        )}
      </div>
    </li>
  );
}

/**
 * Settings › Software: one inventory of the additional software PortOS manages
 * (runtimes, browser, harness CLIs, local AI, media tools, environments). The
 * per-area homes stay the full controls; this page shows state and offers the
 * updates those homes already run.
 */
export default function SoftwareTab() {
  const { data, error, loading, refetch, updateData } = useSocketResource(readInventory, { events: EVENTS });
  const [searchParams, setSearchParams] = useSearchParams();
  const showAll = searchParams.get('all') === '1';
  const [pending, setPending] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // A Node/pm2 job that answered `started` without a restart keeps running on
  // the server; it ends with `portos:node-runtime:changed` reason job-finished,
  // preceded by `portos:update:error` when it failed.
  // Events can arrive before the start response, so the job is tracked before
  // the request and its outcome recorded until the response says it started.
  const [backgroundJob, setBackgroundJob] = useState(null);
  const jobRef = useRef(null);
  const settleJob = (job) => {
    if (jobRef.current !== job) return;
    jobRef.current = null;
    setBackgroundJob(null);
    if (job.error !== undefined) toast.error(`${job.name} update failed${job.error ? `: ${job.error}` : ''}`);
    else toast.success(`${job.name} updated`);
  };
  const settleRef = useRef(settleJob);
  settleRef.current = settleJob;
  useEffect(() => {
    const onError = ({ message } = {}) => {
      const job = jobRef.current;
      if (!job || job.error !== undefined) return;
      job.error = message || '';
      if (job.started) settleRef.current(job);
    };
    const onChanged = ({ reason } = {}) => {
      const job = jobRef.current;
      if (reason !== 'job-finished' || !job) return;
      job.finished = true;
      if (job.started) settleRef.current(job);
    };
    socket.on('portos:update:error', onError);
    socket.on('portos:node-runtime:changed', onChanged);
    return () => {
      socket.off('portos:update:error', onError);
      socket.off('portos:node-runtime:changed', onChanged);
    };
  }, []);
  const { captureBaseline } = usePortosRestartWatch({
    active: restarting,
    onRestart: () => setRestarting(false),
    onFailure: ({ message }) => { setRestarting(false); if (message) toast.error(message); },
  });

  const refresh = async () => {
    setRefreshing(true);
    const fresh = await api.getSoftwareInventory({ fresh: true }).catch(() => null);
    if (fresh) updateData(fresh);
    setRefreshing(false);
  };

  const runAction = async (row) => {
    const launch = ACTIONS[row.action.kind];
    if (!launch) return;
    setPending(row.id);
    if (row.action.restarts) {
      await captureBaseline();
      setRestarting(true);
    }
    const job = BACKGROUND_JOBS.has(row.action.kind) && !row.action.restarts ? { id: row.id, name: row.name } : null;
    jobRef.current = job;
    const result = await launch(row.action).catch(() => null);
    if (!result || result.restart === false) setRestarting(false);
    if (job && result?.started && result.restart === false) {
      job.started = true;
      if (job.finished || job.error !== undefined) settleJob(job);
      else setBackgroundJob(job);
    } else {
      if (job && jobRef.current === job) jobRef.current = null;
      if (result && !row.action.restarts) toast.success(`${row.name} updated`);
    }
    setPending(null);
    refetch();
  };

  if (loading && !data) {
    return <div className="flex items-center gap-2 p-4 text-sm text-gray-400"><BrailleSpinner /> Reading installed software…</div>;
  }
  if (error && !data) {
    return <LoadFailedState title="Could not read installed software" onRetry={refetch} />;
  }

  const components = data?.components || [];
  const visible = components.filter((row) => showAll || !HIDDEN_BY_DEFAULT.has(row.state));
  const hiddenCount = components.length - visible.length;
  const counts = STATE_ORDER
    .map((state) => [state, components.filter((row) => row.state === state).length])
    .filter(([state, count]) => count > 0 && !HIDDEN_BY_DEFAULT.has(state));
  const groups = (data?.groups || [])
    .map((group) => ({ group, rows: visible.filter((row) => row.group === group).sort((a, b) => rank(a) - rank(b)) }))
    .filter(({ rows }) => rows.length > 0);
  const toggleAll = () => setSearchParams((params) => {
    const next = new URLSearchParams(params);
    if (showAll) next.delete('all'); else next.set('all', '1');
    return next;
  }, { replace: true });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Package size={18} className="text-port-accent" />
        <h2 className="text-base font-semibold text-white">Software</h2>
        <div className="flex flex-wrap gap-1.5">
          {counts.map(([state, count]) => <Pill key={state} tone={STATES[state].tone} size="xs">{count} {STATES[state].label.toLowerCase()}</Pill>)}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="ml-auto inline-flex min-h-[36px] items-center gap-1.5 rounded border border-port-border px-3 text-xs text-gray-300 hover:border-port-accent hover:text-white disabled:opacity-50"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} /> Check now
        </button>
      </div>
      {restarting && <p className="rounded border border-port-warning/30 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">Updating. PortOS restarts to finish and this page reloads when it is back.</p>}

      {groups.map(({ group, rows }) => (
        <section key={group} className="overflow-hidden rounded-lg border border-port-border bg-port-card">
          <h3 className="border-b border-port-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-gray-400">{group}</h3>
          <ul className="divide-y divide-port-border/60">
            {rows.map((row) => <SoftwareRow key={row.id} row={row} pending={pending ?? backgroundJob?.id ?? null} onAction={runAction} />)}
          </ul>
        </section>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
        {hiddenCount > 0 || showAll
          ? <button type="button" onClick={toggleAll} className="min-h-[36px] text-port-accent hover:text-white">{showAll ? 'Hide not installed' : `Show ${hiddenCount} not installed`}</button>
          : <span />}
        {data?.checkedAt && <span>Checked {formatDateTime(data.checkedAt)}</span>}
      </div>
    </div>
  );
}
