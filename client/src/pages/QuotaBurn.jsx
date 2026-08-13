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
import { AlertTriangle, Flame, RefreshCw } from 'lucide-react';
import toast from '../components/ui/Toast';
import Banner from '../components/ui/Banner';
import BrailleSpinner from '../components/BrailleSpinner';
import FamilyCard from '../components/quotaBurn/FamilyCard';
import { NumberField } from '../components/quotaBurn/fields';
import * as api from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { mergeQuotaBurnPatch } from '../lib/quotaBurnPatch';
import { safeReadJsonSession, safeRemoveSession, safeWriteJsonSession } from '../lib/safeStorage';
import { coalesce } from '../utils/coalesce';
import { timeAgo } from '../utils/formatters';

// Trailing-edge window for the config PUT. A per-keystroke save would also
// re-read the status, and a `universe-bible-images` job's pending probe walks
// every universe bible — one full scan per character typed.
const SAVE_DEBOUNCE_MS = 500;

// How often to re-ask while a family's quota scrape is still running. A scrape
// is a 10-20s PTY spawn, so this is a handful of polls, not a busy loop.
const PENDING_POLL_MS = 4000;

const EMPTY_CATALOG = { jobTypes: [], apps: [], universes: [], imageModes: [] };

// Where a patch the server never accepted waits for the next visit. Session
// scope, not local: this is a crash buffer for the current tab, and a patch
// resurrected days later would be applied on top of a config it no longer
// describes.
const UNSAVED_PATCH_KEY = 'quotaBurn:unsavedPatch';

// A stash written by an older build (or hand-edited) must not be replayed as a
// patch — the PUT body is an object, and anything else would 400 the save the
// restore is supposed to rescue. An object with no keys is equally not a
// restore: replaying it would PUT nothing and still announce recovered edits.
const readStashedPatch = () => {
  const stored = safeReadJsonSession(UNSAVED_PATCH_KEY);
  const isPatch = stored && typeof stored === 'object' && !Array.isArray(stored) && Object.keys(stored).length > 0;
  return isPatch ? stored : null;
};

// Distinguishes a read that THREW from one that resolved with nothing — the
// two need opposite handling of the error state, and both are falsy.
const READ_FAILED = Symbol('quota-burn-read-failed');

// A catalog the server answered with, but which is missing the job types the
// form needs, is indistinguishable from a failed fetch as far as the page is
// concerned — both leave every dropdown empty — so normalize to the same shape
// and let the caller decide which message to show. Each list is validated
// rather than merely defaulted: a spread alone lets an explicit `null` through
// (a partial payload, an older peer), and every consumer of this object reads
// `.length` on it.
const normalizeCatalog = (data) => ({
  ...EMPTY_CATALOG,
  ...(data || {}),
  ...Object.fromEntries(Object.keys(EMPTY_CATALOG).map((key) => [
    key, Array.isArray(data?.[key]) ? data[key] : [],
  ])),
});

export default function QuotaBurn() {
  // Which family is expanded lives in the URL, not local state, so a specific
  // family's plan is linkable and survives a reload.
  const { familyId: expanded } = useParams();
  const navigate = useNavigate();

  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  // Distinct from `loading`: a manual re-read is reported ON the button that
  // asked for it, never by replacing the page with a spinner.
  const [refreshing, setRefreshing] = useState(false);
  // `null` = the read has never failed; a string = the message from the read
  // that did. Collapsing the two into a boolean (or into `!config`) is what
  // left a failed first load indistinguishable from "the server answered, and
  // it has no plan" — one is retryable and names a cause, the other doesn't.
  const [loadError, setLoadError] = useState(null);
  // Same `null` = never failed / string = the cause convention as `loadError`,
  // for the SECOND read this page makes. The catalog fetch used to be swallowed
  // outright, which is what left the preset picker missing, "Add job" disabled,
  // and every job row's dropdown empty with nothing on screen saying why — and
  // editing a step against an empty job-type list submits `jobType: ""`, which
  // the strict PUT schema 400s into a stalled save.
  const [catalogError, setCatalogError] = useState(null);
  // Reported ON the retry button, like `refreshing` — the plan stays rendered.
  const [catalogRetrying, setCatalogRetrying] = useState(false);
  // `unsaved` covers BOTH the debounce window and the in-flight PUT. Every "run"
  // control reads server-side config, so it must stay disabled until the edit
  // has actually landed — otherwise the user changes a model, clicks Burn, and
  // the server burns with the previous value.
  const [unsaved, setUnsaved] = useState(false);
  // Distinct from `unsaved`: the retry budget is spent and nothing is in flight
  // any more. Collapsing the two would leave the header's indicator saying
  // "Saving changes…" forever after a save gave up — a claim of progress that is
  // false, on the one control whose whole job is to tell the truth about
  // persistence.
  const [saveStalled, setSaveStalled] = useState(false);
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
  const savingRef = useRef(false);
  // `save` is re-created every render and the mount effect must not re-run when
  // it changes, so the restore path reaches it through a ref — same shape as
  // `persistRef` above.
  const saveRef = useRef(null);
  const hasConfigRef = useRef(false);

  // Resolves to `null` when the read landed, or to the failure message when it
  // didn't. The banner state alone can't tell a caller whether THIS read failed
  // (a poll may have set it earlier), and the manual refresh — which renders no
  // banner, because the page still has its plan on screen — needs the cause to
  // put in its toast.
  const load = useCallback(async (refresh = false) => {
    const seq = editSeqRef.current;
    let failure = null;
    // `silent: true` because the failure is rendered by this page's own banner
    // or its refresh toast rather than the request helper's — see
    // client/src/CLAUDE.md's silent-vs-toasting rule.
    const data = await api.getQuotaBurn(refresh, { silent: true })
      .catch((err) => {
        failure = err?.message || 'The request failed.';
        setLoadError(failure);
        return READ_FAILED;
      });
    // The sentinel — not a falsy check — is what separates the two: a read that
    // FAILED must keep its message, while a read that merely answered with
    // nothing has to clear the previous failure, or the banner goes on blaming
    // a network error for what is now the server returning no plan.
    if (data === READ_FAILED) return failure;
    // Cleared on ANY successful read, including the polls: the last error no
    // longer describes the page once the server has answered.
    setLoadError(null);
    if (!data) return null;
    // `status` is derived server-side and never edited here, so it is always
    // safe to adopt; `config` is the form's own state and must not be rewound.
    setStatus(data.status);
    // Whether the page ever got a plan to merge onto. A stashed patch replayed
    // onto `null` would render a config with no `families` and crash the plan
    // section, so the restore waits for a read that actually answered.
    if (data.config) hasConfigRef.current = true;
    // The counter alone only catches an edit that landed WHILE this GET was in
    // flight. An edit made just BEFORE it was issued leaves the counter
    // unmoved, so the response — which predates the still-debounced PUT —
    // would roll the textarea back to the last saved text, and the next
    // keystroke would rebuild the patch from that rewound value and persist
    // it. Anything unsaved or in flight means the server's copy is stale by
    // definition; don't adopt it.
    if (editSeqRef.current === seq && !pendingRef.current && !savingRef.current) setConfig(data.config);
    return null;
  }, []);

  // The catalog is the page's second read and fails independently of the plan:
  // the plan can render perfectly while every choice the form offers is empty.
  // `silent: true` for the same reason as `load` — the failure is rendered by
  // the family card's own banner, not the request helper's toast.
  const loadCatalog = useCallback(async () => {
    let failure = null;
    const data = await api.getQuotaBurnCatalog({ silent: true })
      .catch((err) => {
        failure = err?.message || 'The request failed.';
        return READ_FAILED;
      });
    if (data === READ_FAILED) {
      setCatalogError(failure);
      return;
    }
    const next = normalizeCatalog(data);
    setCatalog(next);
    // A 200 carrying no job types is a different failure with the same symptom
    // — say so rather than reporting success into an empty form.
    setCatalogError(next.jobTypes.length ? null : 'The server returned no job types.');
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([load(), loadCatalog()]).finally(() => {
      setLoading(false);
      // Navigating away while the first read was still open must not consume
      // the stash: the unmount flush has already run, so a patch restored now
      // would be cleared from storage with no page left to persist it from.
      if (!mounted) return;
      // Edits the last visit could not persist. Replaying them through `save`
      // — rather than only re-rendering them — puts them back on screen AND
      // re-arms the debounce, so the recovery ends in the server holding them
      // instead of the user having to retype the field to trigger a PUT.
      // A failed read leaves the stash alone rather than dropping it — the next
      // visit that does get a plan is where the recovery belongs.
      const stashed = hasConfigRef.current ? readStashedPatch() : null;
      if (!stashed) return;
      safeRemoveSession(UNSAVED_PATCH_KEY);
      saveRef.current?.(stashed);
      toast('Restored Quota Burn edits that could not be saved last time.');
    });
    return () => { mounted = false; };
  }, [load, loadCatalog]);

  const retryCatalog = async () => {
    setCatalogRetrying(true);
    await loadCatalog();
    setCatalogRetrying(false);
  };

  // A cold quota cache comes back as `pending` families rather than holding the
  // response open for a 20s-per-family PTY scrape, so the page renders its plan
  // immediately and fills the numbers in when the scrape lands. Enabled ONLY
  // while something is actually pending — this is not a background refresh loop
  // — and `useAutoRefetch` (rather than a hand-rolled timer) so it pauses on a
  // hidden tab: re-requesting a multi-second scrape behind a backgrounded tab is
  // the one thing this poll must not do.
  const anyPending = (status?.families || []).some((row) => row.pending);
  useAutoRefetch(load, PENDING_POLL_MS, { enabled: anyPending, immediate: false, pollOnly: true });

  // There is no Save button: an edit lands in local state immediately and is
  // persisted on a trailing edge. Successive edits fold into ONE patch body, so
  // the PUT carries every change rather than just the last field touched.
  const persist = useMemo(() => coalesce(async () => {
    const patch = pendingRef.current;
    pendingRef.current = null;
    if (!patch) return;
    const seq = editSeqRef.current;
    savingRef.current = true;
    const result = await api.saveQuotaBurn(patch, { silent: true })
      .catch((err) => { toast.error(`Could not save: ${err.message}`); return null; });
    // Cleared before the `load()` below so that read can still adopt the
    // server's normalization — the flag exists to fence concurrent POLL reads,
    // not this function's own follow-up read.
    savingRef.current = false;

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
        setSaveStalled(true);
        toast.error('Changes are still unsaved — edit a field to retry.');
      }
      return;
    }
    retriedRef.current = false;
    setSaveStalled(false);
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
    const patch = pendingRef.current;
    if (!patch) return;
    pendingRef.current = null;
    api.saveQuotaBurn(patch, { silent: true })
      // The page is gone, so there is no header indicator left to tell the
      // truth about persistence: swallowing this failure is what turned
      // "Saving changes…" into permanently-lost edits. Say so, and keep the
      // patch for the next visit — the toast is transient, the work isn't.
      // If the user is already back on the page when this rejects, the stash
      // waits for the visit AFTER this one rather than being applied live; the
      // toast still names the failure, and holding the edits is strictly better
      // than the drop this replaces.
      .catch(() => {
        safeWriteJsonSession(UNSAVED_PATCH_KEY, mergeQuotaBurnPatch(readStashedPatch(), patch));
        toast.error('Quota Burn changes could not be saved — they will be restored next time you open the page.');
      });
  }, [persist]);

  const save = (patch) => {
    editSeqRef.current += 1;
    setUnsaved(true);
    // A new edit re-arms the debounce, so the previous give-up no longer
    // describes the current state.
    setSaveStalled(false);
    setConfig((prev) => mergeQuotaBurnPatch(prev, patch));
    pendingRef.current = mergeQuotaBurnPatch(pendingRef.current, patch);
    persist();
  };

  saveRef.current = save;

  const patchFamily = (familyId, patch) => save({ families: { [familyId]: patch } });

  // Re-arm spends nothing — it only makes a spent `run once` step eligible again
  // — so it needs no confirm, and the response carries the fresh status so the
  // badges clear without a second round trip. `config` is deliberately NOT
  // touched: completions live in their own ledger, and adopting a config here
  // would fight the debounced save.
  const rearm = async (familyId, jobId = null) => {
    setRunning(true);
    const next = await api.rearmQuotaBurn(familyId, jobId, { silent: true })
      .catch((err) => { toast.error(`Could not re-arm: ${err.message}`); return null; });
    if (next?.status) setStatus(next.status);
    setRunning(false);
  };

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

  // A re-read must NOT go back through `loading`: that unmounts every family
  // card, control, and status number behind a full-page spinner for the length
  // of a 10-20s PTY quota scrape, and then — if the scrape fails — puts the
  // stale numbers back with nothing having said so. The button carries its own
  // spinner and the page keeps rendering what it has.
  const refreshQuota = async (hard = false) => {
    setRefreshing(true);
    const failure = await load(hard);
    setRefreshing(false);
    // With a plan on screen there is no banner, so the toast is the only thing
    // that can report the failure; when there ISN'T one the banner already
    // names it, and toasting too would say it twice.
    if (failure && config) toast.error(`Failed to refresh quota stats: ${failure}`);
  };

  if (loading) return <div className="p-6 text-gray-400"><BrailleSpinner /> Loading burn plan…</div>;
  // A failed first read used to land here with no cause and no way out but a
  // browser reload — the header (and its "Refresh quota") returns above.
  if (!config) {
    return (
      <div className="p-6">
        <Banner
          tone="error"
          icon={AlertTriangle}
          size="md"
          title="Quota burn is unavailable"
          actions={(
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded border border-port-error/40 hover:bg-port-error/10 disabled:opacity-40"
              disabled={refreshing}
              onClick={() => refreshQuota()}
            >
              {refreshing ? 'Retrying…' : 'Retry'}
            </button>
          )}
        >
          <p className="mt-0.5 break-words">{loadError || 'The server did not return a plan.'}</p>
        </Banner>
      </div>
    );
  }

  const lastRun = status?.runs?.[0];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2"><Flame size={20} className="text-orange-400" /> Quota Burn</h1>
        {/* There is no Save button on this page, and nothing else said so — the
            silence is what makes people reach for the nearest button-shaped
            thing (the per-job ▶, which spends quota) to "commit" an edit. */}
        <span
          className={`text-[11px] ${saveStalled ? 'text-port-error' : unsaved ? 'text-amber-300' : 'text-gray-500'}`}
          aria-live="polite"
        >
          {saveStalled
            ? 'Not saved — edit a field to retry'
            : unsaved ? 'Saving changes…' : 'Changes save automatically'}
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white disabled:opacity-40"
          disabled={refreshing}
          onClick={() => refreshQuota(true)}
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
          {refreshing ? 'Refreshing…' : 'Refresh quota'}
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
          One loop for this install, but each provider family burns independently: every family whose window is inside its reset
          horizon, above its reserve, and under its dispatch cap (unlimited by default) runs the first job in its plan that has work waiting — one job
          per family per cycle. A plan is a rotation: steps repeat lap after lap until a gate closes, unless you mark one
          “Run once” — one-shot work then drops out after its dispatch until you re-arm it. Turning this on is explicit
          consent to spend those subscriptions on a schedule.
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
            catalogError={catalogError}
            catalogRetrying={catalogRetrying}
            onRetryCatalog={retryCatalog}
            expanded={expanded === familyId}
            actionsBusy={unsaved || running}
            onToggleExpand={(id) => navigate(expanded === id ? '/devtools/quota-burn' : `/devtools/quota-burn/${id}`)}
            onPatch={(patch) => patchFamily(familyId, patch)}
            onRunFamily={(id) => run({ familyId: id }, 'Burn')}
            onRunJob={(id, job) => run({ familyId: id, jobId: job.id, force: true }, 'Job run')}
            onRearm={rearm}
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
