/**
 * Quota Burn — configure the ONE install-level loop that spends subscription
 * quota which would otherwise expire unused.
 *
 * The loop lives in PortOS, not on any managed app: one schedule, one set of
 * per-provider-family windows, and an ordered burn plan per family. Individual
 * jobs decide what the quota goes to — an agent in a named managed app, or a
 * programmatic PortOS job like rendering the universe bible entries that have
 * no image yet.
 *
 * The master switch is the consent gate for the whole feature (CLAUDE.md's AI
 * provider policy): with it off nothing here contacts a provider, and the page
 * names the family, provider, model, and work before it can be turned on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Flame, RefreshCw } from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import FamilyCard from '../components/quotaBurn/FamilyCard';
import * as api from '../services/api';
import { mergeQuotaBurnPatch } from '../lib/quotaBurnPatch';
import { coalesce } from '../utils/coalesce';
import { timeAgo } from '../utils/formatters';

// Trailing-edge window for the config PUT. A per-keystroke save would also
// re-read the status, and a `universe-bible-images` job's pending probe walks
// every universe bible — one full scan per character typed.
const SAVE_DEBOUNCE_MS = 500;

const EMPTY_CATALOG = { families: [], jobTypes: [], apps: [], universes: [], imageModes: [] };

export default function QuotaBurn() {
  // Which family is expanded lives in the URL, not local state, so a specific
  // family's plan is linkable and survives a reload.
  const { familyId: expanded } = useParams();
  const navigate = useNavigate();

  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  // `unsaved` covers BOTH the debounce window and the in-flight PUT. Every "run"
  // control reads server-side config, so it must stay disabled until the edit
  // has actually landed — otherwise the user changes a model, clicks Burn, and
  // the server burns with the previous value.
  const [unsaved, setUnsaved] = useState(false);
  const [running, setRunning] = useState(false);
  const pendingRef = useRef(null);

  const load = useCallback(async (refresh = false) => {
    const data = await api.getQuotaBurn(refresh, { silent: true }).catch(() => null);
    if (!data) return;
    setConfig(data.config);
    setStatus(data.status);
  }, []);

  useEffect(() => {
    Promise.all([
      load(),
      api.getQuotaBurnCatalog({ silent: true }).then(setCatalog).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [load]);

  // There is no Save button: an edit lands in local state immediately and is
  // persisted on a trailing edge. Successive edits fold into ONE patch body, so
  // the PUT carries every change rather than just the last field touched.
  const persist = useMemo(() => coalesce(async () => {
    const patch = pendingRef.current;
    pendingRef.current = null;
    if (!patch) return;
    const result = await api.saveQuotaBurn(patch, { silent: true })
      .catch((err) => { toast.error(`Could not save: ${err.message}`); return null; });
    // The server's normalization is authoritative — adopt what it stored, then
    // re-read status so pending counts and skip reasons match the saved plan.
    if (result) setConfig(result.config);
    await load();
    setUnsaved(false);
  }, SAVE_DEBOUNCE_MS), [load]);

  useEffect(() => () => persist.cancel(), [persist]);

  const save = (patch) => {
    setUnsaved(true);
    setConfig((prev) => mergeQuotaBurnPatch(prev, patch));
    pendingRef.current = mergeQuotaBurnPatch(pendingRef.current, patch);
    persist();
  };

  const patchFamily = (familyId, patch) => save({ families: { [familyId]: patch } });

  const run = async (body, label) => {
    setRunning(true);
    const response = await api.runQuotaBurn(body, { silent: true })
      .catch((err) => { toast.error(`${label} failed: ${err.message}`); return null; });
    if (response) {
      const result = response.result || {};
      if (result.dispatched) toast.success(result.summary || 'Dispatched');
      else toast(result.reason || result.skipped || 'Nothing to burn right now');
      await load();
    }
    setRunning(false);
  };

  if (loading) return <div className="p-6 text-gray-400"><BrailleSpinner /> Loading burn plan…</div>;
  if (!config) return <div className="p-6 text-gray-400">Quota burn is unavailable — the server did not return a plan.</div>;

  const lastRun = status?.runs?.[0];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2"><Flame size={20} className="text-orange-400" /> Quota Burn</h1>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white"
          onClick={() => { setLoading(true); load(true).finally(() => setLoading(false)); }}
        >
          <RefreshCw size={13} /> Refresh quota
        </button>
        <button
          type="button"
          className="ml-auto text-xs px-3 py-1.5 rounded border border-port-border text-gray-200 hover:text-white disabled:opacity-40"
          disabled={running || unsaved}
          onClick={() => run({}, 'Run')}
          title={unsaved ? 'Saving your changes…' : 'Run one evaluation now'}
        >
          {running ? 'Evaluating…' : 'Evaluate now'}
        </button>
      </header>

      <section className="rounded border border-port-border bg-port-card/40 p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <input
            id="quota-burn-enabled"
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => save({ enabled: event.target.checked })}
          />
          <label htmlFor="quota-burn-enabled" className="text-sm text-white">
            Run the quota-burn loop automatically
          </label>
          <label htmlFor="quota-burn-interval" className="text-xs text-gray-400 ml-auto flex items-center gap-2">
            Check every
            <input
              id="quota-burn-interval"
              type="number"
              min="5"
              max="720"
              className="w-20 bg-port-bg border border-port-border rounded p-1.5 text-white text-xs"
              value={config.checkIntervalMinutes}
              onChange={(event) => save({ checkIntervalMinutes: Number(event.target.value) })}
            />
            minutes
          </label>
        </div>
        <p className="text-xs text-gray-400">
          One loop for this install. Each provider family burns only inside its reset window, above its reserve, and within its
          dispatch cap — running the first job in its plan that has work waiting. Turning this on is explicit consent to spend
          those subscriptions on a schedule.
        </p>
        {lastRun && (
          <p className="text-[11px] text-gray-500">
            Last {lastRun.trigger} run {timeAgo(lastRun.at)} — {lastRun.dispatched ? lastRun.summary : lastRun.reason}
          </p>
        )}
      </section>

      <section className="space-y-3">
        {Object.entries(config.families).map(([familyId, family]) => (
          <FamilyCard
            key={familyId}
            familyId={familyId}
            config={family}
            status={(status?.families || []).find((row) => row.id === familyId)}
            catalog={catalog}
            expanded={expanded === familyId}
            actionsBusy={unsaved || running}
            running={running}
            onToggleExpand={(id) => navigate(expanded === id ? '/devtools/quota-burn' : `/devtools/quota-burn/${id}`)}
            onPatch={(patch) => patchFamily(familyId, patch)}
            onRunFamily={(id) => run({ familyId: id }, 'Burn')}
            onRunJob={(id, job) => run({ familyId: id, jobId: job.id, force: true }, 'Job run')}
          />
        ))}
      </section>

      {Boolean(status?.runs?.length) && (
        <section className="rounded border border-port-border bg-port-card/40 p-3">
          <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-2">Recent runs</h2>
          <ul className="space-y-1 text-xs">
            {status.runs.slice(0, 15).map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex flex-wrap gap-2 text-gray-400">
                <span className="text-gray-500 w-24 shrink-0">{timeAgo(entry.at)}</span>
                <span className={entry.dispatched ? 'text-emerald-400' : 'text-gray-500'}>
                  {entry.dispatched ? `${entry.familyId} · ${entry.summary}` : entry.reason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
