/**
 * Editorial Checks (#1285) — the catalog / config / run / triage surface for the
 * registry-driven editorial-review system (epic #1283, backbone #1284).
 *
 * The check CATALOG (enable + per-check config) is global (settings-backed), so
 * it loads independent of any series. RUNS and FINDINGS are per-series: pick a
 * series, run the enabled checks (or a selected subset) with SSE progress, then
 * triage the findings — which are seeded into the manuscript review store and
 * deep-link into the manuscript editor's existing Accept/Dismiss/fix flow.
 *
 * Deep-linkable at /pipeline/editorial-checks (optionally ?series=<id> to
 * preselect a series, e.g. from a series page).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ListChecks, Loader2, Play, Plus, Square, Undo2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import EditorialCheckCard from '../components/pipeline/editorial/EditorialCheckCard';
import EditorialCustomCheckForm from '../components/pipeline/editorial/EditorialCustomCheckForm';
import EditorialFindingsTriage from '../components/pipeline/editorial/EditorialFindingsTriage';
import EditorialHealthPanel from '../components/pipeline/editorial/EditorialHealthPanel';
import SeriesSeverityConfig from '../components/pipeline/editorial/SeriesSeverityConfig';
import ProviderModelSelector from '../components/ProviderModelSelector';
import TabPills from '../components/ui/TabPills';
import { groupChecksByScope, groupFindingsByCheck, normCategory, canonEntitiesFromUniverse } from '../lib/editorialChecks';
import { usePipelineProgress } from '../hooks/usePipelineProgress';
import useProviderModels from '../hooks/useProviderModels';
import {
  listPipelineSeries,
  updatePipelineSeries,
  getEditorialChecks,
  patchEditorialCheck,
  createEditorialCustomCheck,
  updateEditorialCustomCheck,
  deleteEditorialCustomCheck,
  previewEditorialCustomCheck,
  startEditorialChecksRun,
  cancelEditorialChecksRun,
  getEditorialChecksRunStatus,
  editorialChecksRunSseUrl,
  getPipelineManuscriptReview,
  getUniverse,
} from '../services/api';

export default function PipelineEditorialChecks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [checks, setChecks] = useState([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [savingIds, setSavingIds] = useState(() => new Set());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Checks the user muted from the triage this session (#1602, lifted here for
  // #1697). Disabling a check doesn't delete its persisted findings, so its triage
  // group is hidden locally (keyed by checkId) until an undo, a fresh findings
  // load, or a catalog re-enable brings it back. Owned here — not in the triage —
  // so the health panel's filterable sets can subtract muted checks (the mute
  // state and the filterable-set derivation must share one source of truth).
  const [hiddenCheckIds, setHiddenCheckIds] = useState(() => new Set());
  // Below `lg` the catalog + findings columns stack into one; this segmented
  // switch picks which one is visible. Default to triage since that's the
  // page's primary mobile task (#1611). No URL param — it's a breakpoint-only
  // presentation toggle that doesn't exist on desktop.
  const [mobileTab, setMobileTab] = useState('findings');

  const [series, setSeries] = useState([]);
  // Per-series editorial-check config overrides (#1591) are saved through the
  // series PATCH; track in-flight saves per checkId so the run buttons gate on the
  // override landing (the runner reads the persisted series record).
  const [savingSeriesIds, setSavingSeriesIds] = useState(() => new Set());
  // Per-check nonce bumped on a FAILED series-override save so the check card can
  // revert its draft inputs to the persisted value (#1591).
  const [seriesResetNonces, setSeriesResetNonces] = useState(() => ({}));
  // Bumped on a FAILED severity-config save (#1616) so the severity-tuning panel
  // re-seeds its number-input drafts from the persisted (untouched) values.
  const [severityResetNonce, setSeverityResetNonce] = useState(0);
  // In-flight COUNT of severity-config saves (#1616), not set membership: two
  // quick same-field edits (high then medium weight) queue two saves under the
  // same field name, so a Set key would be deleted by the first save's `finally`
  // while the second is still pending — re-enabling the run buttons mid-save and
  // letting a run read stale config. A counter only reaches 0 when ALL queued
  // severity saves have drained.
  const [severitySaveCount, setSeveritySaveCount] = useState(0);
  const seriesId = searchParams.get('series') || '';
  const [comments, setComments] = useState([]);
  // Canon entities (#1631) for the selected series' linked universe, flattened to
  // a name→entity lookup so the triage can linkify entity references in findings.
  // Empty until a series with a universe is selected; load failures degrade to no
  // links (the findings still render).
  const [canonEntities, setCanonEntities] = useState([]);
  const [loadingFindings, setLoadingFindings] = useState(false);
  // Bumped whenever the findings are (re)loaded so the health panel refetches
  // its score/trend in lockstep — a run that seeds new findings also moves the
  // health score + records a trend snapshot server-side.
  const [healthRefresh, setHealthRefresh] = useState(0);

  const [runActive, setRunActive] = useState(false);
  const [runStarting, setRunStarting] = useState(false);

  // Optional AI provider/model override for the editorial pass. `allowDefault`
  // keeps both ids empty until the user explicitly picks one — an empty choice
  // means "use the active/stage provider" (the route's providerId/model are
  // optional). `silent` so a provider-list fetch failure doesn't toast over
  // this secondary control.
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
  } = useProviderModels({ allowDefault: true, silent: true });

  const checksById = useMemo(
    () => Object.fromEntries(checks.map((c) => [c.id, c])),
    [checks],
  );
  const enabledCount = useMemo(() => checks.filter((c) => c.enabled).length, [checks]);
  const scopeGroups = useMemo(() => groupChecksByScope(checks), [checks]);
  // Per-check maturity / quality stats (#1629): group the loaded findings by
  // check so each catalog card can show its findings count, dismissal rate, and
  // false-positive rate. Keyed by checkId; a check with no findings is simply
  // absent (the card renders its "untested" state). Findings are per-series, so
  // this empties out — and the cards hide the strip — when no series is selected.
  const statsByCheck = useMemo(() => {
    const groups = groupFindingsByCheck(comments, checksById);
    return Object.fromEntries(groups.map((g) => [g.checkId, g]));
  }, [comments, checksById]);
  // The check/category values the health panel can deep-link to (#1606). The
  // panel's "Open by check/category" rows count OPEN findings, and the triage only
  // lists check-sourced findings (it drops null-checkId completeness/legacy ones).
  // So a row is navigable iff there's an OPEN check-sourced finding for it — match
  // that exactly (open + checkId), or a row whose open count is all completeness
  // findings (or only resolved check-sourced ones) would deep-link to a list with
  // none of the open findings it summarizes.
  const openCheckSourced = useMemo(
    () => comments.filter((c) => c?.checkId && c.status === 'open'),
    [comments],
  );
  // Subtract checks the user muted this session (#1697): the triage hides their
  // groups, so the health panel must not advertise a check/category whose only
  // open findings are hidden — clicking such a row would deep-link to a triage
  // view with nothing in it. A category stays filterable as long as ANY non-muted
  // check still contributes an open finding to it.
  const visibleOpenCheckSourced = useMemo(
    () => (hiddenCheckIds.size ? openCheckSourced.filter((c) => !hiddenCheckIds.has(c.checkId)) : openCheckSourced),
    [openCheckSourced, hiddenCheckIds],
  );
  const triageFilterableCheckIds = useMemo(
    () => new Set(visibleOpenCheckSourced.map((c) => c.checkId)),
    [visibleOpenCheckSourced],
  );
  const triageFilterableCategories = useMemo(
    () => new Set(visibleOpenCheckSourced.map((c) => normCategory(c))),
    [visibleOpenCheckSourced],
  );
  // Config saves read server settings, so a run that fires before a save lands
  // would use stale config — gate the run buttons while any save is in flight.
  const anySaving = savingIds.size > 0;

  // ---- Load the global catalog + series list once. ----
  useEffect(() => {
    let canceled = false;
    Promise.all([
      getEditorialChecks().catch(() => ({ checks: [] })),
      listPipelineSeries().catch(() => []),
    ]).then(([catalog, list]) => {
      if (canceled) return;
      setChecks(Array.isArray(catalog?.checks) ? catalog.checks : []);
      setSeries(Array.isArray(list) ? list : []);
      setLoadingCatalog(false);
    });
    return () => { canceled = true; };
  }, []);

  // ---- Load findings + re-attach to an in-flight run when the series changes. ----
  // Tracks the currently-selected series so a slow findings fetch for a series
  // the user has since navigated away from can't overwrite the new series'
  // comments (which would also point the deep-links at the wrong series).
  const activeSeriesRef = useRef(seriesId);
  useEffect(() => { activeSeriesRef.current = seriesId; }, [seriesId]);

  const loadFindings = useCallback((id) => {
    // The session mute is local to the currently-shown findings: a series switch,
    // a fresh load, or a run-completion reload resets it. This happened for free
    // while the set lived in the triage (it unmounted during the loading state and
    // remounted with empty local state); now that the parent owns it (#1697), reset
    // it explicitly so a mute can't bleed across series or outlive a reload.
    setHiddenCheckIds((s) => (s.size ? new Set() : s));
    if (!id) { setComments([]); return; }
    setLoadingFindings(true);
    // Deliberately NOT silent: this caller owns no error UI of its own, so we
    // let request()'s default toast be the single layer and just clear +
    // swallow here. Guard every state write on the series still being current
    // (stale-response race).
    getPipelineManuscriptReview(id)
      .then((review) => { if (activeSeriesRef.current === id) setComments(Array.isArray(review?.comments) ? review.comments : []); })
      .catch(() => { if (activeSeriesRef.current === id) setComments([]); })
      .finally(() => {
        if (activeSeriesRef.current === id) {
          setLoadingFindings(false);
          setHealthRefresh((n) => n + 1); // re-pull the health score/trend in lockstep
        }
      });
  }, []);

  // Inline accept/dismiss from the triage list (#1598) — replace the changed
  // comment in place (reactive update) and re-pull the health score/trend so the
  // panel reflects the resolved finding without a full refetch.
  const handleCommentChange = useCallback((updated) => {
    if (!updated?.id) return;
    setComments((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setHealthRefresh((n) => n + 1);
  }, []);

  useEffect(() => {
    setRunActive(false);
    if (!seriesId) { setComments([]); return; }
    loadFindings(seriesId);
    let canceled = false;
    getEditorialChecksRunStatus(seriesId, { silent: true })
      .then((s) => { if (!canceled && s?.active) setRunActive(true); })
      .catch(() => {});
    return () => { canceled = true; };
  }, [seriesId, loadFindings]);

  // ---- SSE progress for the active run (mirrors the manuscript editor). ----
  const { latest: runLatest, closed: runClosed } = usePipelineProgress(
    editorialChecksRunSseUrl, [seriesId], { enabled: runActive && !!seriesId },
  );

  // The run's stage label, derived from the latest `check:start` frame — no
  // state to keep in sync (the banner only renders while runActive).
  const runStageLabel = runActive && runLatest?.type === 'check:start' && runLatest.label
    ? `Running: ${runLatest.label}` : '';

  // Terminal frame: refresh findings + tear down. Gate on `runClosed` so a stale
  // terminal frame from a prior run can't kill a freshly-started one.
  useEffect(() => {
    if (!runActive || !runClosed || !runLatest) return;
    const type = runLatest.type;
    if (type !== 'complete' && type !== 'canceled' && type !== 'error') return;
    setRunActive(false);
    if (type === 'complete') {
      loadFindings(seriesId);
      // #1573 — a check whose run() threw produced no findings; warn instead of a
      // silent "complete" so an always-erroring check isn't mistaken for clean.
      if (runLatest.errored > 0) {
        toast.warning(`Editorial checks complete — ${runLatest.errored} check${runLatest.errored === 1 ? '' : 's'} errored: ${(runLatest.erroredCheckIds || []).join(', ')}`);
      } else toast.success('Editorial checks complete');
    }
    else if (type === 'canceled') toast.success('Editorial checks canceled');
    else toast.error(runLatest.error || 'Editorial checks failed');
  }, [runActive, runClosed, runLatest, seriesId]);

  // Recovery: the stream died WITHOUT a terminal frame — don't strand the UI;
  // drop the active flag and re-fetch (the runner may have seeded server-side).
  useEffect(() => {
    if (!runActive || !runClosed) return;
    const t = runLatest?.type;
    if (t === 'complete' || t === 'canceled' || t === 'error') return; // handled above
    setRunActive(false);
    loadFindings(seriesId);
  }, [runActive, runClosed, runLatest, seriesId]);

  // ---- Catalog mutations (reactive local updates; the API owns the toast).
  // Stable identities (useCallback) so React.memo'd cards only re-render when
  // their own row changes — not on every unrelated run/selection state tick.
  // Rollback flips only the one check (functional update) so a concurrent
  // toggle of a different check can't be clobbered. ----
  // Per-check tail promise so rapid toggles of the SAME check apply in click
  // order (last-click-wins) — see the serialization note in handleToggle (#1602).
  const toggleTailsRef = useRef(new Map());
  // Per-check count of in-flight toggle PATCHes so the saving flag (which gates
  // the run buttons) only clears once the LAST queued PATCH settles, not the first.
  const toggleInflightRef = useRef(new Map());
  const handleToggle = useCallback((checkId, nextEnabled) => {
    const apply = (val) => setChecks((rows) => rows.map((r) => (r.id === checkId ? { ...r, enabled: val } : r)));
    apply(nextEnabled);
    // Drop a now-disabled check from the targeted-run selection so "Run selected"
    // can't carry an id the server will silently filter out.
    if (!nextEnabled) setSelectedIds((s) => { if (!s.has(checkId)) return s; const n = new Set(s); n.delete(checkId); return n; });
    // Track in savingIds like config saves — the run endpoint reads persisted
    // settings, so the run buttons must gate on this PATCH landing (and the card
    // shows its saving spinner for the toggle too).
    setSavingIds((s) => new Set(s).add(checkId));
    toggleInflightRef.current.set(checkId, (toggleInflightRef.current.get(checkId) || 0) + 1);
    // Serialize the PATCHes for a SINGLE check onto a per-check tail so the LAST
    // click wins regardless of response timing (#1602): a quick disable-then-undo
    // (or rapid double-toggle) could otherwise have the stale disable response
    // land after the re-enable response and leave the check persisted disabled,
    // since each response applies its own row. The tail makes the second PATCH run
    // (and apply) only after the first settles. Returns a success boolean so the
    // triage view can reconcile its optimistic group-hide when the PATCH fails —
    // the catch has already reverted the optimistic enabled flip here.
    const prev = toggleTailsRef.current.get(checkId) || Promise.resolve();
    const result = prev.then(() => patchEditorialCheck(checkId, { enabled: nextEnabled }, { silent: true })
      .then((row) => { if (row) setChecks((rows) => rows.map((r) => (r.id === checkId ? row : r))); return true; })
      .catch((err) => { apply(!nextEnabled); toast.error(err.message || 'Failed to update check'); return false; }))
      // Clear the saving flag only when the LAST queued PATCH for this check
      // settles, so the run buttons stay gated until the final write lands.
      .finally(() => {
        const remaining = (toggleInflightRef.current.get(checkId) || 1) - 1;
        if (remaining > 0) { toggleInflightRef.current.set(checkId, remaining); return; }
        toggleInflightRef.current.delete(checkId);
        setSavingIds((s) => { const n = new Set(s); n.delete(checkId); return n; });
      });
    toggleTailsRef.current.set(checkId, result.catch(() => {}));
    return result;
  }, []);

  // ---- Session-local check mute (#1602), lifted from the triage (#1697). Hiding
  // a check's triage group AND keeping the health panel's filterable sets honest
  // both read `hiddenCheckIds`, so the state lives here and the action does too. ----
  const unhideCheck = useCallback((checkId) => setHiddenCheckIds((s) => {
    if (!s.has(checkId)) return s;
    const next = new Set(s);
    next.delete(checkId);
    return next;
  }), []);
  const disableCheck = useCallback((checkId, label) => {
    setHiddenCheckIds((s) => new Set(s).add(checkId));
    const toastId = toast((t) => (
      <span className="flex items-center gap-3 text-xs">
        <span className="text-gray-200">Disabled <span className="font-medium text-white">{label}</span> — findings hidden</span>
        <button
          type="button"
          onClick={() => { unhideCheck(checkId); handleToggle(checkId, true); toast.dismiss(t.id); }}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-port-border px-2 py-0.5 text-[11px] text-port-accent hover:border-port-accent/40 hover:text-white"
        >
          <Undo2 size={12} /> Undo
        </button>
      </span>
    ), { duration: 8000 });
    // Optimistic hide above; reconcile if the persist fails (handleToggle resolves
    // false on error and has already reverted + toasted) so a failed disable doesn't
    // leave the group stuck hidden behind a dead undo toast.
    Promise.resolve(handleToggle(checkId, false)).then((ok) => {
      if (ok === false) { unhideCheck(checkId); toast.dismiss(toastId); }
    });
  }, [unhideCheck, handleToggle]);
  // Keep the muted set honest against the live enabled-state: if a muted check is
  // re-enabled elsewhere (the catalog toggle on this page, or a findings reload
  // carrying fresh catalog rows), un-hide its group so visibility always follows
  // the check's actual enabled state — never stranding a group the triage's empty
  // state tells the user to restore from the catalog.
  useEffect(() => {
    setHiddenCheckIds((s) => {
      if (!s.size) return s;
      let changed = false;
      const next = new Set();
      s.forEach((id) => { if (checksById[id]?.enabled === false) next.add(id); else changed = true; });
      return changed ? next : s;
    });
  }, [checksById]);

  const handleConfigSave = useCallback((checkId, nextConfig) => {
    setSavingIds((s) => new Set(s).add(checkId));
    patchEditorialCheck(checkId, { config: nextConfig }, { silent: true })
      .then((row) => { if (row) setChecks((rows) => rows.map((r) => (r.id === checkId ? row : r))); })
      .catch((err) => toast.error(err.message || 'Failed to save config'))
      .finally(() => setSavingIds((s) => { const n = new Set(s); n.delete(checkId); return n; }));
  }, []);

  // Per-check severity override (#1596). Like config saves it reads server
  // settings, so it joins savingIds to gate the run buttons; `severity === null`
  // clears the override back to the registry default.
  const handleSeveritySave = useCallback((checkId, severity) => {
    setSavingIds((s) => new Set(s).add(checkId));
    patchEditorialCheck(checkId, { severity }, { silent: true })
      .then((row) => { if (row) setChecks((rows) => rows.map((r) => (r.id === checkId ? row : r))); })
      .catch((err) => toast.error(err.message || 'Failed to save severity'))
      .finally(() => setSavingIds((s) => { const n = new Set(s); n.delete(checkId); return n; }));
  }, []);

  // ---- Per-series config override (#1591). The override map lives on the SERIES
  // record (`editorialCheckConfig`); a save PATCHes the series and the runner
  // overlays it on the global config. Saves are NON-optimistic (mirrors
  // handleConfigSave) and SERIALIZED on a tail promise so two quick edits can't
  // reorder responses and clobber each other — each PATCH applies its edit onto
  // the freshest server-confirmed map at execution time. `overrideMapsRef` holds
  // that authoritative map KEYED BY seriesId, so a save queued for series A reads
  // and writes A's map even after the user has switched to series B (the keying is
  // what stops a B-reseed from poisoning A's queued PATCH). `patch === null`
  // clears the whole check. ----
  const selectedSeries = useMemo(() => series.find((s) => s.id === seriesId) || null, [series, seriesId]);
  // Load the linked universe's canon once the series resolves (#1631). Guarded by a
  // mounted flag keyed on universeId so a slow fetch for a series the user has since
  // switched away from can't linkify the new series' findings with stale canon.
  const universeId = selectedSeries?.universeId || '';
  useEffect(() => {
    if (!universeId) { setCanonEntities([]); return undefined; }
    let active = true;
    // Drop the previous universe's canon immediately so a series switch (A→B)
    // whose findings fetch lands before this one can't linkify B's findings with
    // A's entities — a brief no-chips window is correct, stale chips are not.
    setCanonEntities([]);
    getUniverse(universeId, { silent: true })
      .then((universe) => { if (active) setCanonEntities(canonEntitiesFromUniverse(universe)); })
      .catch(() => { if (active) setCanonEntities([]); });
    return () => { active = false; };
  }, [universeId]);
  const seriesOverrides = selectedSeries?.editorialCheckConfig && typeof selectedSeries.editorialCheckConfig === 'object'
    ? selectedSeries.editorialCheckConfig
    : null;

  // Per-series severity-config overrides (#1616) — the STORED (not effective)
  // severityWeights/blockingSeverities, keyed by seriesId, so a queued save
  // composes its edit onto THIS series' freshest server-confirmed values at
  // execution time (mirrors overrideMapsRef). Without this, two quick edits each
  // build a full wholesale-replacement from props captured at event time and the
  // second clobbers the first.
  const seriesSeverityWeights = selectedSeries?.severityWeights && typeof selectedSeries.severityWeights === 'object'
    ? selectedSeries.severityWeights : null;
  const seriesBlockingSeverities = selectedSeries?.blockingSeverities && typeof selectedSeries.blockingSeverities === 'object'
    ? selectedSeries.blockingSeverities : null;

  const overrideMapsRef = useRef({});
  const severityFieldsRef = useRef({});
  const seriesSaveTailRef = useRef(Promise.resolve());
  // Seed/refresh ONLY the selected series' entry from its loaded record (covers
  // the async series-list load AND a server-confirmed save echo). Keying by id
  // means it never overwrites another series' in-flight map.
  useEffect(() => {
    if (seriesId) overrideMapsRef.current[seriesId] = seriesOverrides ? { ...seriesOverrides } : {};
  }, [seriesId, seriesOverrides]);
  useEffect(() => {
    if (seriesId) severityFieldsRef.current[seriesId] = {
      severityWeights: seriesSeverityWeights ? { ...seriesSeverityWeights } : {},
      blockingSeverities: seriesBlockingSeverities ? { ...seriesBlockingSeverities } : {},
    };
  }, [seriesId, seriesSeverityWeights, seriesBlockingSeverities]);

  // `patch` is a PARTIAL per-check override ({ [key]: value }) to merge, or `null`
  // to clear the whole check. Merging (rather than replacing the per-check entry)
  // means a second field edit for the same check — built in the card before the
  // first save lands — composes onto the first instead of dropping it.
  const handleSeriesConfigSave = useCallback((checkId, patch) => {
    const sid = activeSeriesRef.current;
    if (!sid) return;
    setSavingSeriesIds((s) => new Set(s).add(checkId));
    seriesSaveTailRef.current = seriesSaveTailRef.current
      .then(async () => {
        // Build at execution time from THIS series' freshest server-confirmed map.
        const map = { ...(overrideMapsRef.current[sid] || {}) };
        if (patch === null) delete map[checkId];
        else map[checkId] = { ...(map[checkId] || {}), ...patch };
        const saved = await updatePipelineSeries(sid, { editorialCheckConfig: map }, { silent: true })
          .catch((err) => {
            toast.error(err.message || 'Failed to save series override');
            // Revert the card's draft inputs to the persisted value (the override
            // wasn't saved, so the field must not keep showing the typed threshold).
            setSeriesResetNonces((m) => ({ ...m, [checkId]: (m[checkId] || 0) + 1 }));
            return null;
          });
        // On failure the keyed map is untouched, so the UI keeps showing the last
        // persisted overrides (no phantom). On success, sync THIS series' map
        // synchronously by id — keyed, so it never clobbers another series.
        if (saved) {
          overrideMapsRef.current[saved.id] = (saved.editorialCheckConfig && typeof saved.editorialCheckConfig === 'object')
            ? { ...saved.editorialCheckConfig } : {};
          setSeries((rows) => rows.map((r) => (r.id === saved.id ? saved : r)));
        }
      })
      .finally(() => setSavingSeriesIds((s) => { const n = new Set(s); n.delete(checkId); return n; }));
  }, []);

  // Per-series severity config (#1616): the health-score weights + per-gate
  // blocking-severity sets live as top-level series fields (`severityWeights` /
  // `blockingSeverities`). Saved through the SAME serialized silent tail as the
  // per-check override so two quick edits can't reorder/clobber, NON-optimistic
  // (the panel reverts to the persisted value on failure since the series record
  // is left untouched). Counted in severitySaveCount so the run buttons stay
  // gated until EVERY queued save lands (the autopilot reads the persisted
  // series record, so starting a run mid-save would read stale config).
  // `updater(currentStored)` composes the next STORED override from this series'
  // freshest server-confirmed value at execution time (not from props captured
  // when the user clicked), so two quick edits can't wholesale-clobber each other.
  const handleSeriesFieldSave = useCallback((field, updater) => {
    const sid = activeSeriesRef.current;
    if (!sid) return;
    setSeveritySaveCount((n) => n + 1);
    seriesSaveTailRef.current = seriesSaveTailRef.current
      .then(async () => {
        const store = severityFieldsRef.current[sid] || {};
        const current = (store[field] && typeof store[field] === 'object') ? store[field] : {};
        const nextValue = updater({ ...current });
        const saved = await updatePipelineSeries(sid, { [field]: nextValue }, { silent: true })
          .catch((err) => {
            toast.error(err.message || 'Failed to save severity config');
            // Failure: the series record is untouched, but the WEIGHT number
            // inputs may hold typed-but-unsaved drafts — bump the reset nonce so
            // the panel re-seeds them. Only weights have free-text drafts (the
            // blocking checkboxes are prop-driven), so only a weights failure
            // needs it.
            if (field === 'severityWeights') setSeverityResetNonce((n) => n + 1);
            return null;
          });
        // On success sync THIS series' record + stored-override ref by id (keyed,
        // never clobbers another series); on failure leave both untouched.
        if (saved) {
          severityFieldsRef.current[saved.id] = {
            severityWeights: (saved.severityWeights && typeof saved.severityWeights === 'object') ? { ...saved.severityWeights } : {},
            blockingSeverities: (saved.blockingSeverities && typeof saved.blockingSeverities === 'object') ? { ...saved.blockingSeverities } : {},
          };
          setSeries((rows) => rows.map((r) => (r.id === saved.id ? saved : r)));
          // Weights change the health SCORE, so re-pull the panel's score/trend in
          // lockstep (it only refetches on seriesId/refreshKey change). Blocking
          // sets only gate the autopilot, not the score — no refresh needed.
          if (field === 'severityWeights') setHealthRefresh((n) => n + 1);
        }
      })
      .finally(() => setSeveritySaveCount((n) => Math.max(0, n - 1)));
  }, []);
  const severitySaving = severitySaveCount > 0;

  // ---- Custom-check authoring (#1346). The form is URL-driven (?custom=new |
  // ?custom=<checkId>) so it's deep-linkable, not a stateful modal. ----
  const customParam = searchParams.get('custom') || '';
  const editingCheck = customParam && customParam !== 'new'
    ? checks.find((c) => c.id === customParam && c.isCustom) || null
    : null;
  // Form is open for 'new', or for a custom id that resolves to a check.
  const formOpen = customParam === 'new' || !!editingCheck;
  const [formSaving, setFormSaving] = useState(false);

  // useCallback so the memo'd custom cards (which take onEdit) only re-render on
  // an actual param change, not every parent run/selection state tick.
  const openCustomForm = useCallback((id) => {
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set('custom', id); return next; }, { replace: true });
  }, [setSearchParams]);
  const closeCustomForm = useCallback(() => {
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('custom'); return next; }, { replace: true });
  }, [setSearchParams]);

  const handleSaveCustom = (values) => {
    setFormSaving(true);
    const editingId = editingCheck?.id;
    const req = editingId
      ? updateEditorialCustomCheck(editingId, values, { silent: true })
      : createEditorialCustomCheck(values, { silent: true });
    req
      .then((row) => {
        if (!row) return;
        setChecks((rows) => (editingId
          ? rows.map((r) => (r.id === editingId ? row : r))
          : [...rows, row]));
        toast.success(editingId ? 'Custom check saved' : 'Custom check created');
        closeCustomForm();
      })
      .catch((err) => toast.error(err.message || 'Failed to save custom check'))
      .finally(() => setFormSaving(false));
  };

  // Dry-run a draft against the selected series WITHOUT saving (#1607). Returns
  // the preview result (or throws, so the form's own error UI fires). Gated on a
  // selected series by the form via `canPreview`. `{ silent: true }` — the form
  // renders the error inline rather than toasting. Forwards the same AI-pass
  // provider/model override a real run uses (empty = default), so the preview's
  // context sizing + model behavior match the run the user would commit to.
  const handlePreviewCustom = useCallback(
    (values) => previewEditorialCustomCheck(seriesId, {
      ...values,
      ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
    }, { silent: true }),
    [seriesId, selectedProviderId, selectedModel],
  );

  const handleDeleteCustom = useCallback((checkId) => {
    setSavingIds((s) => new Set(s).add(checkId));
    // Drop from the targeted-run selection so a deleted id can't ride a run.
    setSelectedIds((s) => { if (!s.has(checkId)) return s; const n = new Set(s); n.delete(checkId); return n; });
    deleteEditorialCustomCheck(checkId, { silent: true })
      .then(() => { setChecks((rows) => rows.filter((r) => r.id !== checkId)); toast.success('Custom check deleted'); })
      .catch((err) => toast.error(err.message || 'Failed to delete custom check'))
      .finally(() => setSavingIds((s) => { const n = new Set(s); n.delete(checkId); return n; }));
  }, []);

  const toggleSelected = (checkId) => setSelectedIds((s) => {
    const n = new Set(s);
    if (n.has(checkId)) n.delete(checkId); else n.add(checkId);
    return n;
  });

  // ---- Run / cancel. ----
  const runChecks = (subsetIds = null) => {
    if (!seriesId) { toast.error('Pick a series to run checks against'); return; }
    // The server runs only ENABLED checks even from a named subset, so drop any
    // disabled ids up front — otherwise a selection of disabled checks completes
    // as a silent no-op the user reads as "0 findings".
    let ids = subsetIds;
    if (ids) {
      const enabledIds = ids.filter((id) => checksById[id]?.enabled);
      if (!enabledIds.length) { toast.error('Those checks are disabled — enable them or pick others'); return; }
      if (enabledIds.length < ids.length) toast('Skipped disabled checks from your selection');
      ids = enabledIds;
    }
    setRunStarting(true);
    const runOpts = {};
    if (ids) runOpts.checkIds = ids;
    // Empty selections fall through to the active/stage provider server-side.
    if (selectedProviderId) runOpts.providerId = selectedProviderId;
    if (selectedModel) runOpts.model = selectedModel;
    startEditorialChecksRun(seriesId, runOpts, { silent: true })
      .then((res) => {
        if (res?.alreadyRunning) toast('A run is already in progress for this series');
        setRunActive(true);
      })
      .catch((err) => toast.error(err.message || 'Failed to start checks'))
      .finally(() => setRunStarting(false));
  };

  const cancelRun = () => {
    cancelEditorialChecksRun(seriesId, { silent: true })
      .catch((err) => toast.error(err.message || 'Failed to cancel'));
  };

  const onSeriesChange = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('series', id); else next.delete('series');
    setSearchParams(next, { replace: true });
  };

  // Gate runs on formSaving too: a run reads server-side settings, so starting
  // one while a custom-check create/edit PATCH is in flight would run the stale
  // (pre-save) definition. Mirrors the savingIds gate for per-check config saves.
  const runDisabled = !seriesId || runActive || runStarting || anySaving || formSaving || savingSeriesIds.size > 0 || severitySaving;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {/* Header */}
      <div className="space-y-2">
        <Link to="/pipeline" className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
          <ArrowLeft size={13} /> Series Pipeline
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-100">
            <ListChecks size={20} className="text-port-accent" /> Editorial Checks
          </h1>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <label htmlFor="ec-series" className="sr-only">Series</label>
            <select
              id="ec-series"
              value={seriesId}
              onChange={(e) => onSeriesChange(e.target.value)}
              className="w-full rounded border border-port-border bg-port-card px-2 py-1.5 text-sm text-gray-100 focus:border-port-accent focus:outline-none sm:w-auto"
            >
              <option value="">Select a series…</option>
              {series.map((s) => (
                <option key={s.id} value={s.id}>{s.title || s.name || s.id}</option>
              ))}
            </select>
            {runActive ? (
              <button
                type="button"
                onClick={cancelRun}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded bg-port-error/20 px-3 py-1.5 text-sm text-rose-300 hover:bg-port-error/30 sm:flex-none"
              >
                <Square size={14} /> Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={() => runChecks(null)}
                disabled={runDisabled || enabledCount === 0}
                title={enabledCount === 0 ? 'No checks enabled' : undefined}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded bg-port-accent px-3 py-1.5 text-sm text-white hover:bg-port-accent/90 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
              >
                {runStarting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Run all enabled ({enabledCount})
              </button>
            )}
            {!runActive && selectedIds.size > 0 ? (
              <button
                type="button"
                onClick={() => runChecks([...selectedIds])}
                disabled={runDisabled}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border border-port-accent px-3 py-1.5 text-sm text-port-accent hover:bg-port-accent/10 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
              >
                <Play size={14} /> Run selected ({selectedIds.size})
              </button>
            ) : null}
          </div>
        </div>
        {/* AI provider/model override for the editorial pass. Empty = use the
            active/stage provider; disabled while a run is in flight or starting. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">AI pass:</span>
          <div className="w-full sm:w-auto sm:min-w-[280px]">
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={setSelectedProviderId}
              onModelChange={setSelectedModel}
              compact
              label="AI Provider"
              disabled={runActive || runStarting}
              emptyProviderOption="Default provider"
              emptyModelOption="Default model"
              alwaysShowModel
            />
          </div>
        </div>
        {runActive ? (
          <p className="flex items-center gap-2 text-xs text-port-accent">
            <Loader2 size={13} className="animate-spin" /> {runStageLabel || 'Running editorial checks…'}
          </p>
        ) : null}
        {!seriesId ? (
          <p className="text-xs text-gray-500">Pick a series to run checks and triage findings. The catalog below applies to every series.</p>
        ) : null}
      </div>

      {selectedSeries ? (
        <SeriesSeverityConfig
          series={selectedSeries}
          onSaveField={handleSeriesFieldSave}
          saving={severitySaving}
          resetNonce={severityResetNonce}
        />
      ) : null}

      {loadingCatalog ? (
        <p className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" /> Loading checks…</p>
      ) : (
        <div className="space-y-4">
          {/* Below `lg` the two columns stack — this switch picks which one
              shows. Hidden on `lg+`, where both render side-by-side. */}
          <div className="lg:hidden">
            <TabPills
              variant="pills"
              size="sm"
              ariaLabel="Editorial sections"
              tabs={[{ id: 'catalog', label: 'Catalog' }, { id: 'findings', label: 'Findings' }]}
              activeTab={mobileTab}
              onChange={setMobileTab}
            />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
          {/* Catalog */}
          <section className={`space-y-3 ${mobileTab !== 'catalog' ? 'hidden' : ''} lg:block`}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Catalog</h2>
              {!formOpen ? (
                <button
                  type="button"
                  onClick={() => openCustomForm('new')}
                  className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300 hover:bg-port-border/40"
                >
                  <Plus size={13} /> New custom check
                </button>
              ) : null}
            </div>
            {formOpen ? (
              // Key on the target so switching new↔edit (or check A→B) while the
              // form stays mounted remounts it with a fresh draft — otherwise the
              // mount-only useState initializer would save the previous draft.
              <EditorialCustomCheckForm
                key={editingCheck?.id || 'new'}
                check={editingCheck}
                saving={formSaving}
                onSave={handleSaveCustom}
                onCancel={closeCustomForm}
                onPreview={handlePreviewCustom}
                canPreview={!!seriesId}
                previewTarget={seriesId}
              />
            ) : null}
            {checks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-port-border p-4 text-center text-xs text-gray-500">No editorial checks are registered.</p>
            ) : scopeGroups.map((group) => (
              <div key={group.scope} className="space-y-2">
                <h3 className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{group.label}</h3>
                {group.checks.map((check) => (
                  // A dual-scope check (#1628) is fanned into multiple sections, so
                  // scope the per-row DOM ids (selection checkbox + the card's ids,
                  // via `idScope`) by the section to keep them unique. The React key
                  // and all state/selection keys stay `check.id` (the check identity).
                  <div key={`${group.scope}-${check.id}`} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      id={`sel-${group.scope}-${check.id}`}
                      checked={selectedIds.has(check.id)}
                      disabled={!check.enabled}
                      onChange={() => toggleSelected(check.id)}
                      title={check.enabled ? 'Select for a targeted run' : 'Enable this check to include it in a run'}
                      aria-label={`Select ${check.label} for a targeted run`}
                      className="mt-3.5 shrink-0 accent-port-accent disabled:opacity-40"
                    />
                    <div className="min-w-0 flex-1">
                      <EditorialCheckCard
                        check={check}
                        idScope={group.scope}
                        stats={statsByCheck[check.id] || null}
                        statsPending={loadingFindings}
                        saving={savingIds.has(check.id)}
                        onToggle={handleToggle}
                        onConfigSave={handleConfigSave}
                        onSeveritySave={handleSeveritySave}
                        seriesId={seriesId}
                        seriesConfig={seriesOverrides?.[check.id] || null}
                        seriesSaving={savingSeriesIds.has(check.id)}
                        seriesResetNonce={seriesResetNonces[check.id] || 0}
                        onSeriesConfigSave={handleSeriesConfigSave}
                        onEdit={check.isCustom ? openCustomForm : undefined}
                        onDelete={check.isCustom ? handleDeleteCustom : undefined}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>

          {/* Findings */}
          <section className={`space-y-3 ${mobileTab !== 'findings' ? 'hidden' : ''} lg:block`}>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Findings</h2>
            {!seriesId ? (
              <p className="rounded-lg border border-dashed border-port-border p-4 text-center text-xs text-gray-500">Select a series to view its findings.</p>
            ) : (
              <>
                <EditorialHealthPanel seriesId={seriesId} refreshKey={healthRefresh} checksById={checksById} filterableCheckIds={triageFilterableCheckIds} filterableCategories={triageFilterableCategories} />
                {loadingFindings ? (
                  <p className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" /> Loading findings…</p>
                ) : (
                  <EditorialFindingsTriage seriesId={seriesId} comments={comments} checksById={checksById} onCommentChange={handleCommentChange} hiddenCheckIds={hiddenCheckIds} onDisableCheck={disableCheck} onRunChecks={() => runChecks(null)} runDisabled={runDisabled || enabledCount === 0} universeId={universeId} canonEntities={canonEntities} />
                )}
              </>
            )}
          </section>
          </div>
        </div>
      )}
    </div>
  );
}
