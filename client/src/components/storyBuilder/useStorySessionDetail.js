import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import toast from '../ui/Toast';
import useListResource from '../../hooks/useListResource';
import { useLockToggle } from '../../hooks/useLockToggle';
import { useArcCanvasSync } from '../../hooks/useArcCanvasSync';
import { capImageRefs } from '../../lib/bibleLimits';
import {
  getStoryBuilderSteps, getStorySession, updateStorySession,
  setStoryCurrentStep, lockStoryStep, unlockStoryStep,
  setStorySessionSync, reconcileStorySession,
  getUniverse, getPipelineSeries, listPipelineIssues,
} from '../../services/api';
import { useStoryRunMonitor } from './useStoryStepRuns.jsx';

// Bible fields the embedded arc step flushes before an ArcCanvas generate/verify.
// The Story Builder edits these on their own steps (not inside the arc step), so
// the flush is usually a no-op — kept for API-shape parity with ArcCanvas's
// contract. Module-level so the `useArcCanvasSync` callbacks keep a stable identity.
const ARC_FLUSH_FIELDS = ['name', 'logline', 'premise', 'styleNotes', 'issueCountTarget', 'universeId'];

// Wording for a run's operation, shared by the active-run banner and the
// completion toast of a run this view only adopted.
export const RUN_OP_LABEL = {
  generate: { active: 'Generating', done: 'Generation' },
  refine: { active: 'Refining', done: 'Refinement' },
  backfill: { active: 'Backfilling', done: 'Backfill' },
};

// Why the footer "Next >" button is (or isn't) actionable. The rail is un-gated
// — this button is the *conventional* path, so a disabled state with no stated
// reason reads as a bug rather than as guidance (#3908).
function nextButtonReason({ locked, stale }) {
  if (stale) return 'An upstream step changed — re-lock this step to advance.';
  if (!locked) return 'Lock this step to advance to the next step.';
  return 'Go to the next step.';
}

export default function useStorySessionDetail({ storyId, stepParam }) {
  const navigate = useNavigate();
  const [steps, setSteps] = useState(null);
  const [manifestError, setManifestError] = useState(null);
  const [sessionError, setSessionError] = useState(null);
  const [sessionMissing, setSessionMissing] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [session, setSession] = useState(null);
  const [staleSteps, setStaleSteps] = useState([]);
  const [syncDrift, setSyncDrift] = useState(false);
  const [universe, setUniverse] = useState(null);
  const [series, setSeries] = useState(null);
  const fetchIssues = useCallback(
    async () => {
      if (!session?.seriesId) return [];
      const list = await listPipelineIssues(session.seriesId, { silent: true });
      return Array.isArray(list) ? list : (list?.items || []);
    },
    [session?.seriesId],
  );
  const issuesResource = useListResource(fetchIssues, { enabled: !!session?.seriesId });
  const { items: issues, setItems: setIssues } = issuesResource;
  const [loading, setLoading] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);

  // Runs on different steps can now finish while the user is elsewhere in the
  // wizard (#3905), so two `reload()`s can be in flight at once — and this one
  // awaits three round trips before it writes. Without a generation stamp the
  // SLOWER reload wins every setter it reaches last, painting the view with
  // records fetched before the newer completion landed.
  const reloadGenRef = useRef(0);
  const manifestGenRef = useRef(0);
  const loadedSeriesIdRef = useRef(null);

  // Runs this view did not start itself (a reload, a second tab, or the holder of
  // a refused kickoff) are discovered on the session read and adopted by the
  // provider (#10065). The callbacks go through a ref so they can call `reload`
  // (defined just below) without re-registering on every render.
  const reloadRef = useRef(null);
  const handleAdoptedEnd = useCallback(({ ok, op, error }) => {
    if (ok) toast.success(`${RUN_OP_LABEL[op]?.done || 'Run'} finished`);
    else toast.error(error?.message || 'Run failed');
    reloadRef.current?.();
  }, []);
  const handleKickoffUncertain = useCallback(() => { reloadRef.current?.(); }, []);
  const { runs: activeRuns, adoptActive } = useStoryRunMonitor({
    onAdoptedEnd: handleAdoptedEnd,
    onKickoffUncertain: handleKickoffUncertain,
  });

  const reload = useCallback(async () => {
    const gen = ++reloadGenRef.current;
    const isCurrent = () => reloadGenRef.current === gen;
    setReadBusy(true);
    const result = await getStorySession(storyId, { silent: true }).then((record) => ({ record })).catch((error) => {
      if (!isCurrent()) return;
      if (error.status === 404 || error.code === 'NOT_FOUND') {
        setSessionMissing(true);
        setSession(null);
        setSessionError(null);
      } else {
        setSessionError(error.message || 'The story session is unavailable.');
      }
      return null;
    });
    if (!isCurrent()) return;
    const s = result?.record;
    if (!s || typeof s !== 'object' || !s.id) {
      if (result) setSessionError('The story session could not be loaded.');
      setReadBusy(false);
      setLoading(false);
      return;
    }
    setSessionError(null);
    setSessionMissing(false);
    // `activeSteps` is a live-run snapshot, not session state — hand it to the
    // provider (which drops it if the story changed meanwhile) and keep it out of
    // the record we hold.
    const { activeSteps, ...record } = s;
    adoptActive(storyId, activeSteps);
    setSession(record);
    const previousSeriesId = loadedSeriesIdRef.current;
    loadedSeriesIdRef.current = s.seriesId || null;
    // A same-series session refresh must also refresh the independently owned
    // issue list. A changed series id triggers the hook's fetcher effect instead.
    if (s.seriesId && previousSeriesId === s.seriesId) issuesResource.retry();
    setStaleSteps(s.staleSteps || []);
    setSyncDrift(s.syncDrift === true);
    // These GETs own their fallback (.catch → null/[]), so silence the helper's
    // default error toast — otherwise a transient failure double-toasts.
    const [u, ser] = await Promise.all([
      s.universeId ? getUniverse(s.universeId, { silent: true }).catch(() => null) : Promise.resolve(null),
      s.seriesId ? getPipelineSeries(s.seriesId, { silent: true }).catch(() => null) : Promise.resolve(null),
    ]);
    if (!isCurrent()) return;
    setUniverse(u);
    setSeries(ser);
    if (!s.seriesId) setIssues([]);
    setReadBusy(false);
    setLoading(false);
  }, [storyId, adoptActive, issuesResource.retry]);
  reloadRef.current = reload;

  // Optimistically mirror a completed character render onto the loaded
  // universe's `imageRefs[]`. The Story Builder characters step now tags its
  // render with a durable `universeRun.entryRef` (#1362), so the server-side
  // `appendEntryImageRef` hook persists the ref — this stamp just drives an
  // instant thumbnail without a refetch (which could race the durable write).
  // Dedup-guarded + last-N capped to mirror the server append.
  const applyUniverseCharRef = useCallback((charId, filename) => {
    if (!charId || !filename) return;
    setUniverse((cur) => {
      if (!cur) return cur;
      const chars = Array.isArray(cur.characters) ? cur.characters : [];
      const nextChars = chars.map((c) => {
        if (c?.id !== charId) return c;
        const refs = Array.isArray(c.imageRefs) ? c.imageRefs : [];
        if (refs.includes(filename)) return c;
        return { ...c, imageRefs: capImageRefs([...refs, filename]) };
      });
      return { ...cur, characters: nextChars };
    });
  }, []);

  // Inline Step 1 edits (title / seedIdea) merge just the patched fields; the
  // response is the raw record, not the recomputed view the rest of `session` is.
  const applySessionFields = useCallback((fields) => {
    setSession((prev) => (prev ? { ...prev, ...fields } : prev));
  }, []);

  // ── Embedded ArcCanvas wiring (plotArc step) ──────────────────────────────
  // The Arc Canvas edits series.arc + the issue roadmap in place, so it needs
  // server-confirmed setters. The flush is usually a no-op here (the bible
  // fields are edited on their own steps, not inside the arc step), so a
  // pre-flush save failure is swallowed (silent) rather than toasted.
  const { updateSeriesFromServer, handleIssuesUpdate, flushPending, registerDraftFlush } = useArcCanvasSync({
    series,
    setSeries,
    setIssues,
    flushFields: ARC_FLUSH_FIELDS,
    silent: true,
  });

  // A manifest failure is distinct from an empty rail. Retry bootstrap without
  // unmounting an already loaded workspace or its draft editors.
  const loadDetail = useCallback(async () => {
    const gen = ++manifestGenRef.current;
    setLoading(true);
    setReadBusy(true);
    const manifest = await getStoryBuilderSteps({ silent: true }).catch((error) => {
      if (manifestGenRef.current === gen) setManifestError(error.message || 'The step manifest is unavailable.');
      return null;
    });
    if (manifestGenRef.current !== gen) return;
    if (!Array.isArray(manifest?.steps) || manifest.steps.length === 0 ||
      manifest.steps.some((step) => !step?.id || !step?.label)) {
      setManifestError((error) => error || 'The step manifest could not be loaded.');
      setReadBusy(false);
      setLoading(false);
      return;
    }
    setSteps(manifest.steps);
    setManifestError(null);
    await reload();
  }, [reload]);

  useEffect(() => {
    loadDetail();
    return () => {
      manifestGenRef.current++;
      reloadGenRef.current++;
    };
  }, [loadDetail]);

  const stepIds = (steps || []).map((s) => s.id);
  const activeStepId = stepIds.includes(stepParam) ? stepParam : (session?.currentStep || 'idea');
  const activeIdx = stepIds.indexOf(activeStepId);
  const activeStep = steps?.[activeIdx];
  const stepState = session?.steps?.[activeStepId] || { status: 'pending', locked: false };
  const isStale = staleSteps.includes(activeStepId);
  const nextBlocked = !stepState.locked || isStale;
  const nextReason = nextButtonReason({ locked: stepState.locked, stale: isStale });

  // Navigation is advisory, not gated: the user may start from any point and
  // work the steps out of order (e.g. start from a drafted comic script and
  // backfill the idea / arc afterward). `firstUnmetUpstream` reports the first
  // earlier step that is unlocked or stale purely so the rail can show a hint —
  // it never blocks navigation.
  const firstUnmetUpstream = useCallback((idx) => {
    for (let i = 0; i < idx; i++) {
      const id = stepIds[i];
      if (session?.steps?.[id]?.locked !== true) return 'unlocked';
      if (staleSteps.includes(id)) return 'stale';
    }
    return null;
  }, [stepIds, session, staleSteps]);

  const lock = useLockToggle({
    // Locking makes the step read-only server-side, so anything still pending
    // on screen (dirty bible fields, an open Arc Canvas editor) must land
    // FIRST — otherwise its save is rejected by the fresh lock and the user's
    // last edits are silently lost (#3907). Unlocking re-opens the step and has
    // nothing to preserve, so it skips the flush.
    patchFn: async (next) => {
      if (next && await flushPending() === null) return null;
      return next ? lockStoryStep(storyId, activeStepId, { silent: true }) : unlockStoryStep(storyId, activeStepId, { silent: true });
    },
    onSuccess: (_updated, next) => {
      reload();
      // "Lock & continue" should actually continue — on a successful LOCK,
      // auto-advance to the next step. Skip if the current step is stale (the
      // user must re-review, not advance) and only navigate AFTER the server
      // accepts the pointer move, so a rejected gate doesn't strand the URL
      // ahead of the persisted currentStep. Unlocking stays put.
      if (next && !isStale && activeIdx >= 0 && activeIdx < stepIds.length - 1) {
        const nextId = stepIds[activeIdx + 1];
        setStoryCurrentStep(storyId, nextId, { silent: true })
          .then(() => navigate(`/story-builder/${storyId}/${nextId}`))
          // The lock succeeded, but the pointer move was re-gated/rejected. Stay
          // put (don't strand the URL ahead of the persisted currentStep) and
          // resync so the rail reflects the server's actual pointer.
          .catch(() => { toast.error('Locked, but could not advance'); reload(); });
      }
    },
    lockedMessage: `${activeStep?.label || 'Step'} locked`,
    unlockedMessage: `${activeStep?.label || 'Step'} unlocked`,
    errorMessage: 'Failed to update lock',
  });

  const goToStep = async (id) => {
    // Free navigation — any step is reachable. Upstream lock/stale state is
    // surfaced as a warning on the step (not a block), so a user can jump to a
    // later step and backfill the earlier ones. Navigate only AFTER the server
    // accepts the pointer move — otherwise a rejected re-gate (deleted session,
    // invalid step) strands the URL on a step the persisted currentStep never
    // advanced to. On rejection, resync so the rail reflects the real pointer.
    const ok = await setStoryCurrentStep(storyId, id, { silent: true }).then(() => true).catch(() => false);
    if (!ok) { toast.error('Could not switch step'); reload(); return; }
    navigate(`/story-builder/${storyId}/${id}`);
  };

  // Persist the picker choice to session.llm — the conductor reads it as the
  // default provider/model for every generate/refine, so one selection drives
  // the whole wizard.
  const saveLlm = async (next) => {
    const updated = await updateStorySession(storyId, {
      llm: { provider: next.provider || null, model: next.model || null },
    }, { silent: true }).catch(() => null);
    // An llm-only change touches nothing else — merge it locally instead of a
    // full reload() (which would refetch session + universe + series + issues
    // and briefly flicker the view).
    if (updated) setSession((prev) => (prev ? { ...prev, llm: updated.llm } : prev));
  };

  // Cross-machine resume (#730). The sync/reconcile routes return the full
  // recomputed session view (staleSteps + syncDrift), not just the record —
  // because toggling sync or reconciling shifts the staleness baseline, which
  // can change which steps read as stale. Merge the whole view so the step rail
  // and the drift indicator both update reactively, no full refetch.
  const applySessionView = (view) => {
    setSession((prev) => (prev ? { ...prev, ...view } : view));
    setStaleSteps(view.staleSteps || []);
    setSyncDrift(view.syncDrift === true);
  };

  const toggleSync = async () => {
    if (!session || syncBusy) return;
    const next = session.sync !== true;
    setSyncBusy(true);
    const view = await setStorySessionSync(storyId, next, { silent: true })
      .catch(() => null)
      .finally(() => setSyncBusy(false));
    if (!view) { toast.error('Failed to update cross-machine resume'); return; }
    applySessionView(view);
    toast.success(next ? 'Cross-machine resume enabled' : 'Cross-machine resume disabled');
  };

  const reconcile = async () => {
    if (!session || session.sync !== true || syncBusy) return;
    setSyncBusy(true);
    const view = await reconcileStorySession(storyId, { silent: true })
      .catch(() => null)
      .finally(() => setSyncBusy(false));
    if (!view) { toast.error('Failed to reconcile'); return; }
    applySessionView(view);
    toast.success('Re-baselined to this machine');
  };

  return {
    steps,
    manifestError,
    sessionError,
    sessionMissing,
    readBusy,
    session,
    staleSteps,
    syncDrift,
    universe,
    setUniverse,
    series,
    issues,
    issuesResource,
    loading,
    syncBusy,
    activeRuns,
    reload,
    loadDetail,
    applyUniverseCharRef,
    applySessionFields,
    updateSeriesFromServer,
    handleIssuesUpdate,
    flushPending,
    registerDraftFlush,
    stepIds,
    activeStepId,
    activeIdx,
    activeStep,
    stepState,
    isStale,
    nextBlocked,
    nextReason,
    firstUnmetUpstream,
    lock,
    goToStep,
    saveLlm,
    toggleSync,
    reconcile,
  };
}
