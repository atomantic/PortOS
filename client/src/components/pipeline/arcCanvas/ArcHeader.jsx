import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, ShieldCheck, Lock, Unlock, BookText, FileSearch } from 'lucide-react';
import toast from '../../ui/Toast';
import { useLockToggle } from '../../../hooks/useLockToggle';
import {
  generatePipelineArcOverview, verifyPipelineArc,
  resolvePipelineArcIssues,
  derivePipelineArcFromManuscript, commitPipelineArcFromManuscript,
  analyzePipelineManuscriptCompleteness,
  listPipelineIssues, updatePipelineSeries,
} from '../../../services/api';
import SeriesLlmPicker from '../SeriesLlmPicker';
import VerifyScopeTooltip from './VerifyScopeTooltip.jsx';
import ArcContent from './ArcContent.jsx';
import VerifyResults from './VerifyResults.jsx';
import DeriveFromManuscriptPreview from './DeriveFromManuscriptPreview.jsx';
import CompletenessResults from './CompletenessResults.jsx';

// What the arc verify pass actually checks. Surfaced as a tooltip next to the
// button so the editor knows what they're getting (and what they're NOT
// getting) before they trust the green check.
const VERIFY_ARC_SCOPE = {
  depth: 'Synopsis-level only across every volume. Beats and scripts are NOT read — use Validate volume for that.',
  checks: [
    'Character contradictions across volumes (dead character speaks; protagonist state breaks at a volume boundary)',
    'Dropped subplots (an early endingHook never paid off later)',
    'Episode-count vs. arc-weight mismatch per volume',
    'Unresolved finale hooks (logline / protagonist arc / themes)',
    'Arc-role imbalance (missing or duplicate pilot / finale)',
    'Theme drift (a theme is named in the arc but appears in no synopsis)',
    'World entity drift (refs to nonexistent factions / characters / locations, or unused major entities)',
  ],
};

// ---- Arc header (logline, themes, action buttons) ----

export default function ArcHeader({ series, onSeriesUpdate, onIssuesUpdate, onFlushPending }) {
  const arc = series.arc;
  const arcLocked = !!series.locked?.arc;
  const [running, setRunning] = useState(null); // 'generate' | 'verify' | 'resolve' | 'derive' | 'derive-commit' | 'completeness' | null
  const [verifyIssues, setVerifyIssues] = useState(null);
  // Derive-from-manuscript preview (null until the LLM proposal lands) and the
  // categorized "finish the draft" findings.
  const [derivePreview, setDerivePreview] = useState(null);
  const [completeness, setCompleteness] = useState(null);
  // Which finding indexes have an in-flight per-finding resolve. Lets the row
  // show its own spinner without blocking the rest of the page.
  const [resolvingIdx, setResolvingIdx] = useState(new Set());
  const [confirmingRegen, setConfirmingRegen] = useState(false);

  // Switching series must not leak the prior series' advisory results. These
  // are all ephemeral (never persisted) — reset on id change. `running` is
  // intentionally excluded: it's bound to an in-flight call whose
  // setRunning(null) must still fire on completion.
  useEffect(() => {
    setVerifyIssues(null);
    setDerivePreview(null);
    setCompleteness(null);
    setConfirmingRegen(false);
    setResolvingIdx(new Set());
  }, [series.id]);

  const { busy: lockBusy, toggle: toggleArcLock } = useLockToggle({
    patchFn: (next) => updatePipelineSeries(series.id, {
      locked: { ...(series.locked || {}), arc: next },
    }, { silent: true }),
    onSuccess: (updated, next) => {
      onSeriesUpdate(updated);
      if (next) setConfirmingRegen(false);
    },
    lockedMessage: 'Arc locked — regeneration and auto-resolve are now blocked',
    unlockedMessage: 'Arc unlocked',
    errorMessage: 'Failed to update lock',
  });

  const llmOverride = useMemo(() => ({
    providerOverride: series.llm?.provider || undefined,
    modelOverride: series.llm?.model || undefined,
  }), [series.llm?.provider, series.llm?.model]);

  // Persist pending bible edits BEFORE the LLM call reads from the server,
  // so typing "32" into the issue count and clicking Regenerate runs against
  // the on-screen value, not the previously-saved one.
  const withFlush = async (fn) => {
    if (onFlushPending) await onFlushPending();
    return fn();
  };

  const runGenerate = async () => {
    setConfirmingRegen(false);
    setRunning('generate');
    const result = await withFlush(() =>
      generatePipelineArcOverview(series.id, { commit: true, ...llmOverride }, { silent: true }).catch((err) => {
        toast.error(err.message || 'Failed to generate arc');
        return null;
      }),
    );
    setRunning(null);
    if (!result) return;
    onSeriesUpdate(result.series);
    toast.success('Arc generated and saved');
  };

  const runVerify = async () => {
    setRunning('verify');
    const result = await withFlush(() =>
      verifyPipelineArc(series.id, llmOverride, { silent: true }).catch((err) => {
        toast.error(err.message || 'Failed to verify arc');
        return null;
      }),
    );
    setRunning(null);
    if (!result) return;
    setVerifyIssues(result.issues || []);
    if ((result.issues || []).length === 0) {
      toast.success('Arc verified — no issues found');
    } else {
      toast.error(`Arc verification surfaced ${result.issues.length} issue${result.issues.length === 1 ? '' : 's'}`);
    }
  };

  // Auto-resolve. `findings` undefined = resolve all currently-displayed
  // findings (server re-verifies first if findings comes through empty).
  const runResolve = async (findingsSubset) => {
    setRunning('resolve');
    const result = await withFlush(() =>
      resolvePipelineArcIssues(series.id, {
        findings: findingsSubset,
        ...llmOverride,
      }, { silent: true }).catch((err) => {
        toast.error(err.message || 'Auto-resolve failed');
        return null;
      }),
    );
    setRunning(null);
    if (!result) return null;
    if (result.series) onSeriesUpdate(result.series);
    if (onIssuesUpdate) {
      // Server may reassign child issues' seasonId when resolve replaces
      // season records — refresh so the tree reflects the moves.
      const refreshed = await listPipelineIssues(series.id).catch(() => null);
      if (refreshed) onIssuesUpdate(refreshed);
    }
    if (result.applied) {
      toast.success('Arc updated to resolve findings — re-verify when ready');
    } else {
      toast.success(result.notes || 'Nothing to resolve');
    }
    return result;
  };

  const resolveAll = async () => {
    const result = await runResolve(verifyIssues || []);
    if (result?.applied) setVerifyIssues(null);
  };

  const resolveOne = async (idx, finding) => {
    setResolvingIdx((prev) => new Set(prev).add(idx));
    const result = await runResolve([finding]);
    setResolvingIdx((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
    if (result?.applied) {
      setVerifyIssues((prev) => (prev || []).filter((_, i) => i !== idx));
    }
  };

  // Back-derive arc + bible + a single-volume restructure from the issue
  // manuscripts. Read-only — opens the preview the user reviews/edits before
  // committing.
  const runDerive = async () => {
    setRunning('derive');
    const result = await withFlush(() =>
      derivePipelineArcFromManuscript(series.id, llmOverride, { silent: true }).catch((err) => {
        toast.error(err.message || 'Failed to derive from manuscript');
        return null;
      }),
    );
    setRunning(null);
    if (!result) return;
    setDerivePreview(result);
  };

  // Apply the (edited) derive preview. No LLM re-run — the confirmed proposal
  // is sent verbatim. Refreshes series + issues so the volume collapse + issue
  // reassignment + bible fill show immediately.
  const runDeriveCommit = async (proposal) => {
    setRunning('derive-commit');
    const result = await commitPipelineArcFromManuscript(series.id, proposal, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to apply');
      return null;
    });
    setRunning(null);
    if (!result) return;
    if (result.series) onSeriesUpdate(result.series);
    if (onIssuesUpdate) {
      const refreshed = await listPipelineIssues(series.id).catch(() => null);
      if (refreshed) onIssuesUpdate(refreshed);
    }
    setDerivePreview(null);
    toast.success(`Arc, bible, and a single volume of ${result.issueCount} issue${result.issueCount === 1 ? '' : 's'} derived from the manuscript`);
  };

  // "Finish the draft" — manuscript-completeness editor pass. Advisory; no
  // auto-resolve (the suggestions guide manual authoring).
  const runCompleteness = async () => {
    setRunning('completeness');
    const result = await withFlush(() =>
      analyzePipelineManuscriptCompleteness(series.id, llmOverride, { silent: true }).catch((err) => {
        toast.error(err.message || 'Failed to analyze manuscript');
        return null;
      }),
    );
    setRunning(null);
    if (!result) return;
    setCompleteness(result.issues || []);
    if ((result.issues || []).length === 0) {
      toast.success('Manuscript looks complete — no gaps found');
    } else {
      toast(`Found ${result.issues.length} suggestion${result.issues.length === 1 ? '' : 's'} to finish the draft`);
    }
  };

  // A picked `shape` alone counts as an "arc" record (it's an explicit
  // narrative-design decision the sanitizer preserves), but it isn't a
  // generated arc — the LLM hasn't written anything yet. Use the
  // text-content check to drive the "Generate" vs "Regenerate" affordances
  // so the user isn't told to regenerate something that doesn't exist yet.
  const hasGeneratedArc = !!(
    arc && (arc.logline || arc.summary || arc.protagonistArc || arc.themes?.length)
  );
  const generateBtnLabel = hasGeneratedArc ? 'Regenerate arc' : 'Generate arc';
  // First-time Generate has nothing to overwrite, so skip the confirm prompt.
  const handleGenerateClick = () => {
    if (arcLocked) return;
    if (hasGeneratedArc) setConfirmingRegen(true);
    else runGenerate();
  };

  return (
    <section className="@container bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xs uppercase tracking-wider text-gray-500">Series arc</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <SeriesLlmPicker
            series={series}
            onSeriesUpdate={onSeriesUpdate}
            disabled={!!running}
          />
          {hasGeneratedArc ? (
            <button
              type="button"
              onClick={() => toggleArcLock(arcLocked)}
              disabled={lockBusy || !!running}
              title={arcLocked
                ? 'Arc is locked — click to unlock and allow regeneration'
                : 'Lock the arc to prevent regeneration and auto-resolve from overwriting it'}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border transition-colors disabled:opacity-40 ${
                arcLocked
                  ? 'bg-port-warning/10 text-port-warning border-port-warning/40 hover:bg-port-warning/20'
                  : 'bg-port-bg text-gray-400 border-port-border hover:text-white hover:border-port-accent/40'
              }`}
            >
              {lockBusy
                ? <Loader2 size={14} className="animate-spin" />
                : (arcLocked ? <Lock size={14} /> : <Unlock size={14} />)}
              {arcLocked ? 'Locked' : 'Lock arc'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleGenerateClick}
            disabled={!!running || arcLocked || confirmingRegen}
            title={arcLocked ? 'Arc is locked — unlock to regenerate' : undefined}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border transition-colors bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
          >
            {running === 'generate' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {generateBtnLabel}
          </button>
          {hasGeneratedArc ? (
            <VerifyScopeTooltip scope={VERIFY_ARC_SCOPE} id="verify-arc-scope-tooltip">
              <button
                type="button"
                onClick={runVerify}
                disabled={!!running}
                aria-describedby="verify-arc-scope-tooltip"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border bg-port-bg text-gray-300 border-port-border hover:border-port-accent/40 disabled:opacity-40"
              >
                {running === 'verify' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                Verify arc
              </button>
            </VerifyScopeTooltip>
          ) : null}
          <button
            type="button"
            onClick={runDerive}
            disabled={!!running || arcLocked}
            title={arcLocked
              ? 'Arc is locked — unlock to derive from the manuscript'
              : 'Reconstruct the arc, bible, and a single-volume structure from the issue scripts you already wrote'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border bg-port-bg text-gray-300 border-port-border hover:border-port-accent/40 disabled:opacity-40"
          >
            {running === 'derive' ? <Loader2 size={14} className="animate-spin" /> : <BookText size={14} />}
            Derive from manuscript
          </button>
          <button
            type="button"
            onClick={runCompleteness}
            disabled={!!running}
            title="Read the actual drafted script and suggest what's missing to finish the draft — gaps in content, arc, and character development"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border bg-port-bg text-gray-300 border-port-border hover:border-port-accent/40 disabled:opacity-40"
          >
            {running === 'completeness' ? <Loader2 size={14} className="animate-spin" /> : <FileSearch size={14} />}
            Finish the draft
          </button>
        </div>
      </div>

      {confirmingRegen ? (
        <div className="bg-port-bg border border-port-warning/30 rounded-lg p-3 space-y-2">
          <p className="text-sm text-white">Regenerate the entire arc?</p>
          <p className="text-xs text-gray-400">
            This overwrites the arc logline, summary, protagonist arc, themes, and every volume / season outline.
            Click <em>Lock arc</em> above first to preserve your approved version — once locked, regeneration and auto-resolve are blocked until you unlock.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runGenerate}
              disabled={!!running}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium bg-port-warning/20 text-port-warning border border-port-warning/40 hover:bg-port-warning/30 disabled:opacity-40"
            >
              {running === 'generate' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Confirm regenerate
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRegen(false)}
              disabled={!!running}
              className="px-3 py-1.5 rounded text-sm text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {arc ? (
        <ArcContent series={series} onSeriesUpdate={onSeriesUpdate} />
      ) : (
        <p className="text-xs text-gray-500 italic">
          No arc yet — describe the series in the bible, then click <em>Generate arc</em> to have an LLM propose a multi-volume spine + volume breakdown.
        </p>
      )}

      {verifyIssues && verifyIssues.length > 0 ? (
        <VerifyResults
          issues={verifyIssues}
          onDismiss={() => setVerifyIssues(null)}
          onResolveAll={arcLocked ? null : resolveAll}
          onResolveOne={arcLocked ? null : resolveOne}
          resolvingAll={running === 'resolve' && resolvingIdx.size === 0}
          resolvingIdx={resolvingIdx}
          lockedNote={arcLocked ? 'Arc is locked — unlock above to enable auto-resolve.' : null}
        />
      ) : null}

      {derivePreview ? (
        <DeriveFromManuscriptPreview
          preview={derivePreview}
          committing={running === 'derive-commit'}
          onCancel={() => setDerivePreview(null)}
          onConfirm={runDeriveCommit}
        />
      ) : null}

      {completeness ? (
        <CompletenessResults
          issues={completeness}
          seriesId={series.id}
          onDismiss={() => setCompleteness(null)}
        />
      ) : null}
    </section>
  );
}
