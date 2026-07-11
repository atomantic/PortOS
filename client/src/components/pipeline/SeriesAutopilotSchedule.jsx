import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, AlertTriangle, Trash2 } from 'lucide-react';
import { getSettings, patchSettingsSlice } from '../../services/apiSystem';
import { getProviders } from '../../services/apiProviders';
import { getCosConfig } from '../../services/apiAgents';
import { describeCron } from '../../utils/cronHelpers';
import { providerDisplayName, assignmentModelOptions } from '../../utils/providers';
import CronInput from '../CronInput';
import ProviderModelSelector from '../ProviderModelSelector';
import toast from '../ui/Toast';

/**
 * Scheduled Series Autopilot setup (#2174).
 *
 * Lets the user register a cron schedule so this series runs its autopilot
 * unattended (overnight, autonovel-style). This is the AI Provider Usage
 * Policy's sanctioned "scheduled automation" exception, so the UI is an
 * explicit, consent-gated setup that:
 *  - names the provider/model the scheduled run will use (with a picker to
 *    change it — falls back to the series' own configured provider),
 *  - names the CoS autonomy mode + daily action-budget cap the run is gated by,
 *  - keeps the enable toggle OFF by default (no schedule until the user opts in).
 *
 * Schedules are stored MACHINE-LOCALLY in `settings.seriesAutopilot.schedules`
 * (settings.json doesn't federate) — a schedule on the federated series record
 * would double-run the same series across sync peers.
 */
export default function SeriesAutopilotSchedule({ series }) {
  const seriesId = series?.id;
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingCron, setEditingCron] = useState(false);

  // The persisted schedule entry for THIS series (null when none configured).
  const [entry, setEntry] = useState(null);
  // Context for the consent copy.
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [cosMode, setCosMode] = useState(null);
  const [cosBudget, setCosBudget] = useState(null); // maxActionsPerDay or null (unlimited)

  // Global, series-independent context (providers + CoS autonomy/budget) — fetch
  // once, not on every series switch.
  useEffect(() => {
    let canceled = false;
    Promise.all([
      getProviders({ silent: true }).catch(() => null),
      getCosConfig({ silent: true }).catch(() => null),
    ]).then(([provData, cos]) => {
      if (canceled) return;
      setProviders(provData?.providers || []);
      setActiveProviderId(provData?.activeProvider || null);
      setCosMode(cos?.domainAutonomy?.cos ?? 'execute');
      const cap = cos?.domainBudgets?.cos?.maxActionsPerDay;
      setCosBudget(Number.isFinite(cap) && cap > 0 ? cap : null);
    });
    return () => { canceled = true; };
  }, []);

  // This series' persisted schedule entry — reloads when the series changes.
  // Reset first so a switch can't briefly show (and let the user save) the
  // previous series' schedule under the new seriesId before the fetch resolves.
  useEffect(() => {
    let canceled = false;
    setLoaded(false);
    setEntry(null);
    getSettings({ silent: true }).catch(() => null).then((settings) => {
      if (canceled) return;
      const schedules = settings?.seriesAutopilot?.schedules;
      setEntry(Array.isArray(schedules) ? schedules.find((s) => s?.seriesId === seriesId) || null : null);
      setLoaded(true);
    });
    return () => { canceled = true; };
  }, [seriesId]);

  // Effective provider/model the scheduled run will use: schedule override →
  // series' own llm → the active provider. Mirrors startSeriesAutopilot's
  // provider resolution so the consent copy names what will actually run. Only
  // inherit the series' MODEL when the effective provider IS the series provider
  // — an override to a different provider uses that provider's default model, so
  // showing the series' model would misname what runs.
  const effProviderId = entry?.provider || series?.llm?.provider || activeProviderId || '';
  const inheritsSeriesLlm = !entry?.provider || entry.provider === series?.llm?.provider;
  const effModel = entry?.model || (inheritsSeriesLlm ? series?.llm?.model || '' : '');
  const providerLabel = (id) => providerDisplayName(providers, id, '—');
  const providerModels = useMemo(
    () => assignmentModelOptions(null, providers, effProviderId),
    [providers, effProviderId],
  );

  // Persist a mutated entry for this series, preserving every OTHER series'
  // schedule. Re-reads the freshest schedules array so a sibling series edited
  // elsewhere isn't clobbered, then replaces/removes just this series' element.
  const persist = useCallback(async (nextEntry) => {
    setSaving(true);
    const stamped = nextEntry ? { ...nextEntry, seriesId } : null;
    const settings = await getSettings({ silent: true }).catch(() => null);
    const others = Array.isArray(settings?.seriesAutopilot?.schedules)
      ? settings.seriesAutopilot.schedules.filter((s) => s?.seriesId !== seriesId)
      : [];
    const next = stamped ? [...others, stamped] : others;
    const ok = await patchSettingsSlice('seriesAutopilot', { schedules: next }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err.message || 'Failed to save schedule'); return false; });
    if (ok) setEntry(stamped);
    setSaving(false);
    return ok;
  }, [seriesId]);

  // patch-merge helpers — the provider/model/enable controls render only inside
  // the `hasCron` block, so `entry` is a full object there; `saveCron`'s spread
  // of a possibly-null entry is a spec-safe no-op.
  const saveCron = async (cron) => {
    setEditingCron(false);
    // Setting a cron never auto-enables — the user still flips the toggle (consent).
    await persist({ ...entry, cron });
  };
  const toggleEnabled = async (enabled) => {
    if (enabled && !entry?.cron) {
      toast.error('Set a schedule time first');
      return;
    }
    await persist({ ...entry, enabled });
  };
  const setProvider = async (provider) => persist({ ...entry, provider: provider || undefined, model: undefined });
  const setModel = async (model) => persist({ ...entry, model: model || undefined });

  const removeSchedule = async () => {
    await persist(null);
    setEditingCron(false);
  };

  if (!seriesId) return null;

  const enabled = !!entry?.enabled;
  const hasCron = !!entry?.cron;

  return (
    <div className="border-t border-port-border px-3 py-3 flex flex-col gap-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <CalendarClock size={14} className="text-port-accent" />
        <span className="text-sm font-medium text-white">Scheduled runs</span>
        <span className="text-xs text-gray-500">progress this series unattended on a timer</span>
        {saving ? <Loader2 size={12} className="animate-spin text-gray-500 ml-auto" /> : null}
      </div>

      {!loaded ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : (
        <>
          {/* Schedule time */}
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-gray-400">When:</span>
            {editingCron ? (
              <CronInput
                value={entry?.cron || '0 3 * * *'}
                onSave={saveCron}
                onCancel={() => setEditingCron(false)}
              />
            ) : (
              <>
                <span className="text-gray-200">{hasCron ? describeCron(entry.cron) : 'not set'}</span>
                <button
                  type="button"
                  onClick={() => setEditingCron(true)}
                  className="px-2 py-0.5 rounded border border-port-border bg-port-bg text-gray-300 hover:border-port-accent/40 hover:text-white"
                >
                  {hasCron ? 'Change' : 'Set schedule'}
                </button>
                {hasCron ? (
                  <button
                    type="button"
                    onClick={removeSchedule}
                    disabled={saving}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-port-border bg-port-bg text-gray-400 hover:text-port-error hover:border-port-error/40 disabled:opacity-40"
                    title="Remove schedule"
                  >
                    <Trash2 size={11} /> Remove
                  </button>
                ) : null}
              </>
            )}
          </div>

          {/* Consent context: names the provider/model + the budget/autonomy gate. */}
          {hasCron ? (
            <div className="rounded-lg border border-port-border bg-port-bg/60 p-2.5 flex flex-col gap-2">
              <p className="text-[11px] text-gray-400 leading-relaxed">
                Each scheduled run calls your AI provider automatically. It runs as{' '}
                <span className="text-gray-200 font-medium">{providerLabel(effProviderId)}</span>
                {effModel ? <> / <span className="text-gray-200 font-medium">{effModel}</span></> : <> (provider default model)</>}
                , and is gated by the CoS autonomy mode{' '}
                <span className={`font-medium ${cosMode === 'off' ? 'text-port-error' : 'text-gray-200'}`}>{cosMode || 'execute'}</span>
                {' '}and the CoS daily action budget{' '}
                <span className="text-gray-200 font-medium">{cosBudget ? `(${cosBudget} actions/day)` : '(no cap set)'}</span>.
                {' '}Runs pause and notify you instead of retrying forever.
              </p>

              <div className="max-w-md">
                <ProviderModelSelector
                  providers={providers}
                  selectedProviderId={entry?.provider ?? ''}
                  selectedModel={entry?.model || ''}
                  availableModels={providerModels}
                  onProviderChange={setProvider}
                  onModelChange={setModel}
                  label="Override provider for scheduled runs"
                  compact
                  alwaysShowModel
                  emptyProviderOption={`Use series default (${providerLabel(series?.llm?.provider || activeProviderId)})`}
                  emptyModelOption="Default model"
                />
              </div>

              {cosMode === 'off' ? (
                <p className="text-[11px] text-port-warning flex items-start gap-1">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  CoS autonomy is off — scheduled runs will be skipped until you set it to dry-run or execute in CoS settings.
                </p>
              ) : null}

              {/* Enable toggle — OFF by default; turning it ON is the consent. */}
              <label className="flex items-center gap-2 text-xs text-gray-200 pt-0.5">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={saving || !hasCron}
                  onChange={(e) => toggleEnabled(e.target.checked)}
                />
                <span className="font-medium">Enable scheduled autopilot for this series</span>
              </label>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
