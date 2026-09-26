import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, Clock, GitBranch, Loader, Tag } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import { useSocketResource } from '../../../hooks/useSocketResource';
import { formatDateTime, timeAgo } from '../../../utils/formatters';

// Why the updater is standing by, in the user's words rather than the
// scheduler's reason codes. The server sends both; only the detail is rendered
// free-form, and it is generated prose (counts and nouns), never record content.
const SKIP_LABELS = {
  cooldown: 'Waiting out the minimum interval',
  busy: 'Waiting for the system to go idle',
  'repo-not-ready': 'Waiting on the checkout',
  'up-to-date': 'Nothing to update to',
  'update-in-progress': 'An update is already running',
  'status-unavailable': 'Could not read the update status',
  'activity-unknown': 'Could not read the activity snapshot',
  'launch-failed': 'The last launch was refused',
  'runtime-persistence-unavailable': 'Could not save the updater state',
};

const STATUS_EVENTS = ['portos:auto-update:changed', 'portos:update:checked', 'system:activity'];

const CHANNELS = [
  { id: 'release', label: 'Releases', icon: Tag, hint: 'Same as “Update Now” — updates when a newer GitHub release is published.' },
  { id: 'main', label: 'origin/main', icon: GitBranch, hint: 'Same as App Management’s “Update app” — updates whenever origin’s default branch moves ahead.' },
];

/**
 * Automatic updates — the configuration plus a live account of what the
 * scheduler is currently waiting for.
 *
 * The status half is deliberately verbose: an unattended updater that simply
 * never runs is indistinguishable from a broken one, so every gate it is
 * sitting behind says so here.
 */
export default function AutoUpdatePanel() {
  const { data: status, refetch, updateData } = useSocketResource(
    () => api.getAutoUpdateStatus({ silent: true }), { events: STATUS_EVENTS }
  );
  const config = status?.config;
  const runtime = status?.runtime;
  const repo = status?.repo;
  const activity = status?.activity;
  // Clamp bounds come from the server (`storableAutoUpdateConfig`'s schema
  // enforces the same pair), so the form can't drift into values the PUT 400s on.
  const bounds = status?.bounds?.minIntervalHours || { min: 1, max: 720 };
  const [draft, setDraft] = useState(config || null);
  const [saving, setSaving] = useState(false);

  // Re-seed when the SERVER's value changes — compared against the last config
  // it sent, not against the draft. Comparing against the draft would read the
  // user's half-typed interval as staleness and overwrite it on the next
  // invalidation, which is the opposite of what this effect is for.
  const lastServerConfig = useRef(null);
  useEffect(() => {
    if (!config) return;
    const serialized = JSON.stringify(config);
    if (serialized === lastServerConfig.current) return;
    lastServerConfig.current = serialized;
    setDraft(config);
  }, [config]);

  if (!draft) return null;

  const save = async (patch) => {
    // Clamp before sending, not just on blur: `onChange` writes whatever is in
    // the number input to the draft, so an empty or out-of-range field the user
    // never blurred rides along on the NEXT save (a channel click, a checkbox)
    // and the strict schema 400s the whole thing.
    const next = { ...draft, ...patch };
    next.minIntervalHours = Math.min(bounds.max, Math.max(bounds.min, Number(next.minIntervalHours) || bounds.min));
    setDraft(next);
    setSaving(true);
    const saved = await api.patchSettingsSlice('autoUpdate', next, { silent: true }).catch((err) => {
      toast.error(`Could not save automatic updates: ${err.message}`);
      return null;
    });
    setSaving(false);
    if (!saved) {
      setDraft(config);
      return;
    }
    updateData(previous => ({ ...previous, config: saved.autoUpdate || next }));
    refetch();
  };

  const blockers = activity?.blockers || [];
  const skip = runtime?.lastSkip;

  return (
    <div className="p-4 rounded-lg border border-port-border bg-port-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm text-white font-medium flex items-center gap-2">
            <Clock size={15} className="text-port-accent" /> Automatic updates
          </div>
          <div className="text-xs text-gray-400 mt-1">
            Runs the update for you — but only once the install is completely idle: no render running or queued,
            no LLM or pipeline run, no CoS agent, no Persistent Mind turn, no app operation, no backup in progress.
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-300 shrink-0" htmlFor="auto-update-enabled">
          <input
            id="auto-update-enabled"
            type="checkbox"
            checked={draft.enabled}
            disabled={saving}
            onChange={(e) => save({ enabled: e.target.checked })}
            className="h-4 w-4 accent-port-accent"
          />
          {draft.enabled ? 'On' : 'Off'}
          {saving ? <Loader size={12} className="animate-spin text-port-accent" /> : null}
        </label>
      </div>

      {draft.enabled && (
        <div className="mt-4 space-y-4">
          <fieldset>
            <legend className="text-xs text-gray-500 uppercase tracking-wide mb-2">Update from</legend>
            <div className="flex flex-col gap-2 sm:flex-row">
              {CHANNELS.map(({ id, label, icon: Icon, hint }) => (
                <label
                  key={id}
                  htmlFor={`auto-update-channel-${id}`}
                  className={`flex-1 cursor-pointer rounded-lg border p-3 ${draft.channel === id ? 'border-port-accent/60 bg-port-accent/5' : 'border-port-border bg-port-bg'}`}
                >
                  <span className="flex items-center gap-2 text-sm text-white">
                    <input
                      id={`auto-update-channel-${id}`}
                      type="radio"
                      name="auto-update-channel"
                      value={id}
                      checked={draft.channel === id}
                      disabled={saving}
                      onChange={() => save({ channel: id })}
                      className="accent-port-accent"
                    />
                    <Icon size={14} className="text-gray-400" /> {label}
                  </span>
                  <span className="mt-1 block text-xs text-gray-400">{hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor="auto-update-interval" className="text-sm text-gray-300">
              Wait at least
            </label>
            <input
              id="auto-update-interval"
              type="number"
              min={bounds.min}
              max={bounds.max}
              value={draft.minIntervalHours}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, minIntervalHours: Number(e.target.value) })}
              onBlur={(e) => {
                const hours = Math.min(bounds.max, Math.max(bounds.min, Number(e.target.value) || bounds.min));
                if (hours !== config.minIntervalHours) save({ minIntervalHours: hours });
              }}
              className="w-24 px-2 py-1 bg-port-bg border border-port-border rounded text-sm text-white"
            />
            <span className="text-sm text-gray-300">hours after the last update before looking for a window.</span>
          </div>

          <label className="flex items-start gap-2 text-xs text-gray-300" htmlFor="auto-update-agent">
            <input
              id="auto-update-agent"
              type="checkbox"
              checked={draft.resolveBlockersWithAgent}
              disabled={saving}
              onChange={(e) => save({ resolveBlockersWithAgent: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-port-accent"
            />
            <span>
              <span className="text-gray-200">Queue a CoS agent when the checkout needs judgement.</span>
              <span className="block text-gray-500">
                Switching to the default branch and restoring auto-generated lockfiles happens without one.
                Uncommitted work, an unpushed commit, or an interrupted rebase does not — that queues an agent to resolve it.
              </span>
            </span>
          </label>

          <div className="rounded-lg border border-port-border bg-port-bg p-3 space-y-2">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Right now</div>
            {repo && !repo.ready ? (
              <div className="flex items-start gap-2 text-xs text-port-warning">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  Checkout not ready — {repo.summary || `on ${repo.branch || 'an unknown branch'}, expected a clean ${repo.defaultBranch || 'default branch'}`}.
                  {repo.needsAgent && draft.resolveBlockersWithAgent ? ' A CoS agent will be queued to resolve it.' : ''}
                </span>
              </div>
            ) : null}
            {activity ? (
              <div className="flex items-start gap-2 text-xs">
                {activity.idle
                  ? <><Check size={13} className="mt-0.5 shrink-0 text-port-success" /><span className="text-gray-300">System is idle.</span></>
                  : <><Bot size={13} className="mt-0.5 shrink-0 text-port-accent" /><span className="text-gray-300">Busy: {blockers.map(b => b.label).join(', ')}.</span></>}
              </div>
            ) : null}
            {skip ? (
              <div className="text-xs text-gray-400">
                {SKIP_LABELS[skip.reason] || skip.reason}
                {skip.detail ? ` — ${skip.detail}` : ''}
                {skip.at ? ` (checked ${timeAgo(skip.at)})` : ''}
              </div>
            ) : null}
            {runtime?.lastRunAt ? (
              <div className="text-xs text-gray-500">Last automatic run started {formatDateTime(runtime.lastRunAt)}.</div>
            ) : (
              <div className="text-xs text-gray-500">No automatic update has run yet.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
