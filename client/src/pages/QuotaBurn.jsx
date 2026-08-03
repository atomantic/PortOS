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
import { NumberField } from '../components/quotaBurn/fields';
import * as api from '../services/api';
import { mergeQuotaBurnPatch } from '../lib/quotaBurnPatch';
import { coalesce } from '../utils/coalesce';
import { timeAgo } from '../utils/formatters';

// Trailing-edge window for the config PUT. A per-keystroke save would also
// re-read the status, and a `universe-bible-images` job's pending probe walks
// every universe bible — one full scan per character typed.
const SAVE_DEBOUNCE_MS = 500;

const EMPTY_CATALOG = { jobTypes: [], apps: [], universes: [], imageModes: [] };

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
  // Monotonic counter over local edits. Every server response records the value
  // it was sent at; a response is only allowed to overwrite `config` when the
  // counter hasn't moved since. Without it, a slow round-trip (the status read
  // walks every universe bible) reverts keystrokes typed while it was in
  // flight, and two overlapping saves can land out of order and leave the page
  // showing a value the server does not hold.
  const editSeqRef = useRef(0);
  // One retry per failed patch, and a self-reference so the failure branch can
  // re-arm the debounce it lives inside.
  const retriedRef = useRef(false);
  const persistRef = useRef(null);

  const load = useCallback(async (refresh = false) => {
    const seq = editSeqRef.current;
    const data = await api.getQuotaBurn(refresh, { silent: true }).catch(() => null);
    if (!data) return;
    // `status` is derived server-side and never edited here, so it is always
    // safe to adopt; `config` is the form's own state and must not be rewound.
    setStatus(data.status);
    if (editSeqRef.current === seq) setConfig(data.config);
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
    const seq = editSeqRef.current;
    const result = await api.saveQuotaBurn(patch, { silent: true })
      .catch((err) => { toast.error(`Could not save: ${err.message}`); return null; });

    if (!result) {
      // Put the patch BACK rather than dropping it. One rejected field (a 400
      // from an out-of-range value) would otherwise take every other edit
      // coalesced into the same body down with it, unrecoverably — and
      // `unsaved` must stay true so the run buttons keep reflecting that the
      // server does not have these values.
      pendingRef.current = mergeQuotaBurnPatch(patch, pendingRef.current);
      // Retry ONCE. Without it a single transient blip latches every run
      // control off for the life of the page (nothing else re-arms the
      // debounce, and the only hint is a title tooltip that touch never shows).
      // Bounded at one because a rejected patch will just be rejected again —
      // past that, tell the user plainly and let their next edit re-arm it.
      if (!retriedRef.current) {
        retriedRef.current = true;
        persistRef.current?.();
      } else {
        retriedRef.current = false;
        toast.error('Changes are still unsaved — edit a field to retry.');
      }
      return;
    }
    retriedRef.current = false;
    // The server's normalization is authoritative — adopt what it stored, but
    // only while no newer keystroke has landed. Then re-read status so pending
    // counts and skip reasons match the saved plan.
    if (editSeqRef.current === seq) setConfig(result.config);
    await load();
    // A newer edit armed during the round-trip is still unsaved — clearing the
    // flag here would re-open "Burn now" against config the server doesn't have
    // yet, which is the exact failure the flag exists to prevent.
    if (!pendingRef.current) setUnsaved(false);
  }, SAVE_DEBOUNCE_MS), [load]);

  persistRef.current = persist;

  useEffect(() => () => {
    persist.cancel();
    // Flush, don't drop. `cancel()` alone discards everything typed in the last
    // debounce window — navigating away 200ms after pasting a work prompt would
    // lose it silently, with nothing on screen having said it was unsaved.
    if (pendingRef.current) api.saveQuotaBurn(pendingRef.current, { silent: true }).catch(() => {});
  }, [persist]);

  const save = (patch) => {
    editSeqRef.current += 1;
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
          {/* NumberField, not a bare input — an emptied box must not commit
              `Number('') === 0`, which is below this field's server minimum of
              5 and 400s the whole coalesced save. */}
          <div className="ml-auto flex items-end gap-2 text-xs text-gray-400">
            <NumberField
              id="quota-burn-interval"
              label="Check every (minutes)"
              value={config.checkIntervalMinutes}
              min={5}
              max={720}
              onChange={(next) => save({ checkIntervalMinutes: next })}
            />
          </div>
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
