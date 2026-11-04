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

const EVENTS = ['portos:node-runtime:changed', 'review:queue:changed', 'software:changed'];
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
// `opts` carries `silent` and the owner's `acknowledgeBusy` override.
const ACTIONS = {
  'node-update': (action, opts) => api.updateNodeRuntime(action.version, opts),
  'pm2-sync': (_action, opts) => api.updatePm2Runtime(opts),
  'ytdlp-update': (_action, { silent }) => api.updateYtDlp({ silent }),
  'ollama-upgrade': (_action, { silent }) => api.upgradeLocalLlmBackend('ollama', { silent }),
  'blender-install': (_action, opts) => api.installManagedBlender(opts),
};

// Actions whose request answers `started` while the work continues on the server,
// and the socket events that end it (`error` before `finish` when it failed).
const BACKGROUND_JOBS = {
  'pm2-sync': {
    error: ['portos:update:error', (frame) => frame.step === 'pm2-update'],
    finish: ['portos:node-runtime:changed', (frame) => frame.reason === 'job-finished' && frame.kind === 'pm2-update'],
  },
  'blender-install': {
    error: ['software:blender', (frame) => frame.step === 'error'],
    finish: ['software:changed', (frame) => frame.reason === 'blender'],
    progress: 'software:blender',
  },
};
const JOB_EVENTS = [...new Set(Object.values(BACKGROUND_JOBS).flatMap((spec) => [spec.error[0], spec.finish[0], spec.progress].filter(Boolean)))];

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

function SoftwareRow({ row, pending, progress, busyPrompt, onAction, onDismissBusy }) {
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
        {progress && <p className="text-xs text-port-accent break-words">{progress}</p>}
        {busyPrompt && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-port-warning/30 bg-port-warning/10 px-2 py-1.5 text-xs text-port-warning">
            <span className="min-w-0 flex-1 break-words">{busyPrompt}</span>
            <button type="button" onClick={() => onAction(row, { acknowledgeBusy: true })}
              className="min-h-[32px] rounded border border-port-warning/50 px-2 hover:bg-port-warning/20">Update anyway</button>
            <button type="button" onClick={onDismissBusy} className="min-h-[32px] px-2 text-gray-400 hover:text-white">Cancel</button>
          </div>
        )}
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
  // A job that answered `started` keeps running on the server and ends with the
  // socket events its BACKGROUND_JOBS spec names. Events can arrive before the
  // start response, so the job is tracked before the request and its outcome
  // recorded until the response says it started.
  const [backgroundJob, setBackgroundJob] = useState(null);
  const [progress, setProgress] = useState(null);
  const [busyPrompt, setBusyPrompt] = useState(null);
  const jobRef = useRef(null);
  const settleJob = (job, { quiet = false } = {}) => {
    if (jobRef.current !== job) return;
    jobRef.current = null;
    setBackgroundJob(null);
    setProgress(null);
    if (quiet) return;
    if (job.error !== undefined) toast.error(`${job.name} update failed${job.error ? `: ${job.error}` : ''}`);
    else toast.success(`${job.name} updated`);
  };
  const settleRef = useRef(settleJob);
  settleRef.current = settleJob;
  useEffect(() => {
    const handlers = JOB_EVENTS.map((event) => [event, (frame = {}) => {
      const job = jobRef.current;
      if (!job) return;
      const { error, finish, progress: progressEvent } = job.spec;
      if (event === error[0] && error[1](frame) && job.error === undefined) {
        job.error = frame.message || '';
        if (job.started) settleRef.current(job);
      } else if (event === finish[0] && finish[1](frame)) {
        job.finished = true;
        if (job.started) settleRef.current(job);
      } else if (event === progressEvent && frame.message) {
        setProgress({ id: job.id, message: frame.message });
      }
    }]);
    for (const [event, handler] of handlers) socket.on(event, handler);
    return () => { for (const [event, handler] of handlers) socket.off(event, handler); };
  }, []);
  // A refetch (including the one on reconnect) is authoritative: a started job
  // whose row no longer reports a running job has ended, even if its events were
  // lost. Without them the outcome is unknown, so the row's state speaks for it.
  useEffect(() => {
    const job = jobRef.current;
    if (!job?.started) return;
    const row = data?.components?.find((component) => component.id === job.id);
    if (row && !row.busy) settleRef.current(job, { quiet: !job.finished && job.error === undefined });
  }, [data]);
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

  const runAction = async (row, { acknowledgeBusy = false } = {}) => {
    const launch = ACTIONS[row.action.kind];
    if (!launch) return;
    setBusyPrompt(null);
    setPending(row.id);
    if (row.action.restarts) {
      await captureBaseline();
      setRestarting(true);
    }
    const spec = BACKGROUND_JOBS[row.action.kind];
    const job = spec && !row.action.restarts ? { id: row.id, name: row.name, spec } : null;
    jobRef.current = job;
    const result = await launch(row.action, { silent: true, acknowledgeBusy }).catch((err) => {
      // The busy guard warns; the owner decides whether to go ahead anyway.
      if (err?.code === 'SYSTEM_BUSY') setBusyPrompt({ id: row.id, message: err.message });
      else toast.error(err?.message || `${row.name} update failed`);
      return null;
    });
    if (!result || result.restart === false) setRestarting(false);
    if (job && result?.started && result.restart !== true) {
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
            {rows.map((row) => (
              <SoftwareRow
                key={row.id}
                row={row}
                pending={pending ?? backgroundJob?.id ?? null}
                progress={progress?.id === row.id ? progress.message : null}
                busyPrompt={busyPrompt?.id === row.id ? busyPrompt.message : null}
                onAction={runAction}
                onDismissBusy={() => setBusyPrompt(null)}
              />
            ))}
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
