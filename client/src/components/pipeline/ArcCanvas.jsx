/**
 * Pipeline — Arc Canvas
 *
 * Phase 4 of the Story Arc Planning redesign. Replaces the flat issue-card
 * grid on PipelineSeries with a structural Arc → Season → Episode tree:
 *
 *   ┌─ Arc ─────────────────────────────────────────────┐
 *   │ Logline / themes / [Verify arc] [Regenerate arc]  │
 *   └───────────────────────────────────────────────────┘
 *
 *   ▼ Season 1 — "Pilot" [8 episodes]
 *      Episode 1 — "First Light" [draft]   <delete>
 *      Episode 2 — "Hollow Bones" [ready]  <delete>
 *      ...
 *      [+ Add episode] [Generate episodes (LLM)]
 *
 *   ▶ Season 2 — "Diaspora" [collapsed]
 *
 *   [+ Add season] [Generate arc (LLM)]
 *
 * The LLM passes (arc/generate, episodes/generate, verify) hit the Phase 3
 * routes; mutations are reflected in local state so the canvas stays
 * responsive without a refetch.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, Trash2, Loader2, Sparkles, ShieldCheck, ChevronRight, ChevronDown,
  ChevronsUpDown, AlertCircle, Wand2, Info, ListChecks, X, Lock, Unlock,
  ImageIcon, Layers, FileDown,
} from 'lucide-react';
import toast from '../ui/Toast';
import { timeAgo } from '../../utils/formatters';
import { useArmedAction } from '../../hooks/useArmedAction';
import { useLockToggle } from '../../hooks/useLockToggle';
import {
  createPipelineIssue, deletePipelineIssue, updatePipelineIssue,
  createPipelineSeason, updatePipelineSeason, deletePipelineSeason,
  generatePipelineArcOverview, generatePipelineSeasonEpisodes, verifyPipelineArc,
  verifyPipelineVolume,
  resolvePipelineArcIssues,
  listPipelineIssues, updatePipelineSeries, setPipelineArcFieldLock,
  startPipelineVolumeBeats, cancelPipelineVolumeBeats,
  generatePipelineVolumeCover, generatePipelineVolumeBackCover,
  generatePipelineVolumeCoverConcepts,
  pipelineVolumePdfUrl,
} from '../../services/api';
import { usePipelineVolumeBeatsProgress } from '../../hooks/usePipelineVolumeBeatsProgress';
import SeriesLlmPicker from './SeriesLlmPicker';
import { ArcShapePicker, ArcShapeSparkline, getStoryShape } from './StoryShapes';

const ISSUE_STATUS_COLORS = {
  draft: 'text-gray-400 bg-gray-700/30',
  running: 'text-port-accent bg-port-accent/10',
  'needs-review': 'text-port-warning bg-port-warning/10',
  shipped: 'text-port-success bg-port-success/10',
};

const SEVERITY_COLORS = {
  high: 'text-port-error border-port-error/40 bg-port-error/10',
  medium: 'text-port-warning border-port-warning/40 bg-port-warning/10',
  low: 'text-gray-400 border-gray-500/30 bg-gray-700/20',
};

// What each verify pass actually checks. Surfaced as a `<details>` next to
// the button so the editor knows what they're getting (and what they're NOT
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

const VERIFY_VOLUME_SCOPE = {
  depth: 'One volume in depth — reads beat sheets (stages.idea.output) for issues that have them, falls back to synopsis depth for un-expanded issues. Boundary checks against the immediate-neighbor volumes only.',
  checks: [
    'Volume-internal arc shape (does the volume read as a complete sub-arc; does the final issue pay off the endingHook)',
    'Within-volume continuity (a character / object / beat that disappears mid-volume without resolution)',
    'Beat-level escalation (issues with beats only) — adjacent issues that plateau or contradict each other',
    'Promise drift (the volume logline / synopsis makes a promise no issue delivers — or vice versa)',
    'Boundary continuity (volume opening picks up the prior endingHook; volume endingHook seeds the next volume)',
    'Cast economy (a one-beat introduction never seen again, or a major bible character the volume never uses)',
    'Volume-scope world-entity drift',
    'Length-vs-weight mismatch obvious in isolation',
  ],
};

function VerifyScopeHint({ scope }) {
  return (
    <details className="text-[10px] text-gray-500">
      <summary className="cursor-pointer hover:text-gray-300 inline-flex items-center gap-1">
        <Info size={10} /> What this checks
      </summary>
      <div className="mt-1 pl-4 space-y-1">
        <p className="text-gray-400 italic">{scope.depth}</p>
        <ul className="list-disc pl-4 space-y-0.5">
          {scope.checks.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}

// Hover-revealed tooltip variant — anchors below a parent with the `group`
// class. Use this when the scope hint should sit on the button itself
// instead of taking up vertical space in the layout. The `id` is exposed so
// the triggering button can wire `aria-describedby` for screen readers.
function VerifyScopeTooltip({ scope, id }) {
  return (
    <div
      id={id}
      role="tooltip"
      className="absolute top-full right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-port-card border border-port-border rounded-lg shadow-lg p-3 z-30 opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-opacity pointer-events-none text-left normal-case tracking-normal"
    >
      <p className="text-[10px] text-gray-300 font-medium mb-1 flex items-center gap-1">
        <Info size={10} /> What this checks
      </p>
      <p className="text-[10px] text-gray-400 italic mb-2">{scope.depth}</p>
      <ul className="list-disc pl-4 space-y-0.5 text-[10px] text-gray-400">
        {scope.checks.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

export default function ArcCanvas({ series, issues, onSeriesUpdate, onIssuesUpdate, onFlushPending }) {
  const seasons = series.seasons || [];
  // Stale seasonIds (e.g. after a verify-resolve season rewrite) bucket under
  // null so they show as ungrouped instead of vanishing into an un-iterated key.
  const validSeasonIds = new Set(seasons.map((s) => s.id));
  const issuesBySeason = new Map();
  for (const iss of issues) {
    const key = iss.seasonId && validSeasonIds.has(iss.seasonId) ? iss.seasonId : null;
    if (!issuesBySeason.has(key)) issuesBySeason.set(key, []);
    issuesBySeason.get(key).push(iss);
  }
  for (const list of issuesBySeason.values()) {
    list.sort((a, b) => (a.arcPosition ?? 9999) - (b.arcPosition ?? 9999) || (a.number || 0) - (b.number || 0));
  }
  const ungroupedIssues = issuesBySeason.get(null) || [];

  return (
    <div className="space-y-4">
      <ArcHeader
        series={series}
        onSeriesUpdate={onSeriesUpdate}
        onIssuesUpdate={onIssuesUpdate}
        onFlushPending={onFlushPending}
      />

      {seasons.length > 0 ? (
        <ul className="space-y-3">
          {seasons.map((season) => (
            <SeasonRow
              key={season.id}
              series={series}
              season={season}
              seasons={seasons}
              issues={issuesBySeason.get(season.id) || []}
              onSeriesUpdate={onSeriesUpdate}
              onIssuesUpdate={onIssuesUpdate}
            />
          ))}
        </ul>
      ) : null}

      {ungroupedIssues.length > 0 ? (
        <UngroupedIssues
          issues={ungroupedIssues}
          seasons={seasons}
          onIssuesUpdate={onIssuesUpdate}
        />
      ) : null}

      <AddSeasonRow series={series} onSeriesUpdate={onSeriesUpdate} />
    </div>
  );
}

// ---- Arc header (logline, themes, action buttons) ----

function ArcHeader({ series, onSeriesUpdate, onIssuesUpdate, onFlushPending }) {
  const arc = series.arc;
  const arcLocked = !!series.locked?.arc;
  const [running, setRunning] = useState(null); // 'generate' | 'verify' | 'resolve' | null
  const [verifyIssues, setVerifyIssues] = useState(null);
  // Which finding indexes have an in-flight per-finding resolve. Lets the row
  // show its own spinner without blocking the rest of the page.
  const [resolvingIdx, setResolvingIdx] = useState(new Set());
  const [confirmingRegen, setConfirmingRegen] = useState(false);
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
      generatePipelineArcOverview(series.id, { commit: true, ...llmOverride }).catch((err) => {
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
      verifyPipelineArc(series.id, llmOverride).catch((err) => {
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
      }).catch((err) => {
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
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
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
            <div className="relative group">
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
              <VerifyScopeTooltip scope={VERIFY_ARC_SCOPE} id="verify-arc-scope-tooltip" />
            </div>
          ) : null}
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
    </section>
  );
}

// Theme pill limits — mirror server/lib/storyArc.js ARC_LIMITS.
const THEME_MAX = 100;
const THEMES_PER_ARC_MAX = 20;

// Inline-editable theme pills. Click a pill to rename, hover for the × to
// remove, trailing dashed "+ Add theme" pill opens an inline input. Each
// commit PATCHes series.arc.themes optimistically and reconciles on the
// server response. Single-flight via `savingRef` so a blur-then-click
// sequence can't double-persist against the same base state.
function ThemeChips({ series, arc, onSeriesUpdate }) {
  const themes = arc.themes || [];
  const atMax = themes.length >= THEMES_PER_ARC_MAX;
  const [editingIdx, setEditingIdx] = useState(null); // number | 'new' | null
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const persist = async (nextThemes) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    onSeriesUpdate({ ...series, arc: { ...arc, themes: nextThemes } });
    const updated = await updatePipelineSeries(series.id, { arc: { ...arc, themes: nextThemes } })
      .catch((err) => {
        toast.error(err.message || 'Failed to save themes');
        return null;
      });
    savingRef.current = false;
    setSaving(false);
    if (updated) onSeriesUpdate(updated);
    else onSeriesUpdate(series); // rollback to the last known-good arc
  };

  const startEdit = (idx) => {
    if (saving) return;
    setEditingIdx(idx);
    setDraft(themes[idx]);
  };

  const startAdd = () => {
    if (saving || atMax) return;
    setEditingIdx('new');
    setDraft('');
  };

  const commit = async () => {
    const v = draft.trim().slice(0, THEME_MAX);
    const idx = editingIdx;
    setEditingIdx(null);
    setDraft('');
    if (idx === 'new') {
      if (!v || themes.includes(v)) return;
      await persist([...themes, v]);
    } else if (typeof idx === 'number') {
      if (v === themes[idx]) return;
      const next = [...themes];
      if (v) next[idx] = v;
      else next.splice(idx, 1); // clearing a rename removes the pill
      await persist(next);
    }
  };

  const cancel = () => {
    setEditingIdx(null);
    setDraft('');
  };

  const remove = (idx) => {
    if (saving) return;
    persist(themes.filter((_, i) => i !== idx));
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  return (
    <>
      {themes.map((t, i) => editingIdx === i ? (
        <input
          key={`edit-${i}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          autoFocus
          maxLength={THEME_MAX}
          aria-label={`Edit theme ${i + 1}`}
          className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-port-accent text-white outline-none"
          style={{ width: `${Math.max(draft.length + 1, 5)}ch` }}
        />
      ) : (
        <span
          key={`${i}-${t}`}
          className="group inline-flex items-center text-[10px] uppercase tracking-wider rounded bg-port-bg border border-port-border text-gray-300 hover:border-port-accent/40"
        >
          <button
            type="button"
            onClick={() => startEdit(i)}
            disabled={saving}
            title="Click to rename"
            className="px-2 py-0.5 hover:text-white disabled:opacity-50 disabled:cursor-wait"
          >
            {t}
          </button>
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={saving}
            aria-label={`Remove theme ${t}`}
            title={`Remove "${t}"`}
            className="pr-1.5 -ml-0.5 text-gray-500 hover:text-port-error opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-0"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {editingIdx === 'new' ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          autoFocus
          maxLength={THEME_MAX}
          placeholder="new theme"
          aria-label="New theme"
          className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-port-accent text-white outline-none placeholder:text-gray-600"
          style={{ width: `${Math.max(draft.length + 1, 10)}ch` }}
        />
      ) : !atMax ? (
        <button
          type="button"
          onClick={startAdd}
          disabled={saving}
          title={`Add a theme (${themes.length}/${THEMES_PER_ARC_MAX})`}
          className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-dashed border-port-border text-gray-500 hover:text-port-accent hover:border-port-accent/40 disabled:opacity-50"
        >
          <Plus size={10} /> Add theme
        </button>
      ) : null}
      {saving ? <Loader2 size={10} className="animate-spin text-gray-500 ml-1" /> : null}
    </>
  );
}

// Per-field arc lock toggle. Click flips `series.locked.arcFields[field]`; the
// server-side `commitSeasonsWithRemap` honors the map so auto-resolve /
// regenerate rewrite unlocked fields while preserving locked ones verbatim.
// Subtle inline icon — not a full button — to stay out of the read flow.
function FieldLockToggle({ series, field, label, onSeriesUpdate }) {
  const lockedFields = series.locked?.arcFields || {};
  const locked = lockedFields[field] === true;
  const { busy: saving, toggle } = useLockToggle({
    patchFn: (next) => setPipelineArcFieldLock(series.id, field, next, { silent: true }),
    onSuccess: (updated) => onSeriesUpdate(updated),
    lockedMessage: `${label} locked — preserved on regenerate / auto-resolve`,
    unlockedMessage: `${label} unlocked`,
    errorMessage: `${label} lock update failed`,
  });
  return (
    <button
      type="button"
      onClick={(e) => {
        // Several callers render this button inside a <details><summary>...
        // tree (Summary, Protagonist arc). A click on the lock would otherwise
        // bubble to the summary and toggle the disclosure. Stop here so the
        // user only flips the lock.
        e.stopPropagation();
        e.preventDefault();
        toggle(locked);
      }}
      disabled={saving}
      aria-pressed={locked}
      title={locked
        ? `${label} is locked — click to unlock`
        : `Lock ${label} to preserve it through regenerate / auto-resolve`}
      aria-label={locked ? `Unlock ${label}` : `Lock ${label}`}
      className={`inline-flex items-center justify-center w-4 h-4 rounded transition-colors disabled:opacity-40 ${
        locked ? 'text-port-warning hover:text-port-warning/80' : 'text-gray-600 hover:text-gray-300'
      }`}
    >
      {saving
        ? <Loader2 size={10} className="animate-spin" />
        : (locked ? <Lock size={10} /> : <Unlock size={10} />)}
    </button>
  );
}

function ArcContent({ series, onSeriesUpdate }) {
  const arc = series.arc;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(arc);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft({ ...arc });
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(arc);
  };

  const save = async () => {
    setSaving(true);
    const updated = await updatePipelineSeries(series.id, { arc: draft }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    setSaving(false);
    if (!updated) return;
    onSeriesUpdate(updated);
    setEditing(false);
    toast.success('Arc saved');
  };

  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          value={draft.logline || ''}
          onChange={(e) => setDraft({ ...draft, logline: e.target.value })}
          placeholder="One-sentence whole-arc pitch"
          rows={2}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={500}
        />
        <textarea
          value={draft.summary || ''}
          onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
          placeholder="Multi-volume / multi-season summary (~500 words)"
          rows={6}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={8000}
        />
        <textarea
          value={draft.protagonistArc || ''}
          onChange={(e) => setDraft({ ...draft, protagonistArc: e.target.value })}
          placeholder="Protagonist arc across all volumes / seasons"
          rows={3}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={4000}
        />
        <ArcShapePicker
          value={draft.shape || null}
          onChange={(shape) => setDraft({ ...draft, shape })}
          disabled={saving}
        />
        <p className="text-[10px] text-gray-500 italic">Themes are edited inline above — click a pill to rename, hover for ×, or use the dashed “+ Add theme” chip.</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Save arc
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            disabled={saving}
            className="px-3 py-1.5 rounded text-sm text-gray-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const shapeDef = arc.shape ? getStoryShape(arc.shape) : null;

  return (
    <div className="space-y-2">
      {arc.logline ? (
        <div className="flex items-start gap-2">
          <p className="text-sm text-white flex-1">{arc.logline}</p>
          <FieldLockToggle series={series} field="logline" label="Logline" onSeriesUpdate={onSeriesUpdate} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {shapeDef ? (
          <>
            <span
              className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-port-accent/40 text-port-accent"
              title={shapeDef.description}
            >
              <ArcShapeSparkline shape={shapeDef} width={48} height={16} />
              {shapeDef.label}
            </span>
            <FieldLockToggle series={series} field="shape" label="Shape" onSeriesUpdate={onSeriesUpdate} />
          </>
        ) : null}
        <ThemeChips series={series} arc={arc} onSeriesUpdate={onSeriesUpdate} />
        {(arc.themes?.length ?? 0) > 0 ? (
          <FieldLockToggle series={series} field="themes" label="Themes" onSeriesUpdate={onSeriesUpdate} />
        ) : null}
      </div>
      {arc.summary ? (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer hover:text-white inline-flex items-center gap-1.5">
            Summary
            <FieldLockToggle series={series} field="summary" label="Summary" onSeriesUpdate={onSeriesUpdate} />
          </summary>
          <p className="mt-2 whitespace-pre-wrap">{arc.summary}</p>
        </details>
      ) : null}
      {arc.protagonistArc ? (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer hover:text-white inline-flex items-center gap-1.5">
            Protagonist arc
            <FieldLockToggle series={series} field="protagonistArc" label="Protagonist arc" onSeriesUpdate={onSeriesUpdate} />
          </summary>
          <p className="mt-2 whitespace-pre-wrap">{arc.protagonistArc}</p>
        </details>
      ) : null}
      <button
        type="button"
        onClick={startEdit}
        className="text-xs text-port-accent hover:underline"
      >
        Edit arc
      </button>
    </div>
  );
}

function VerifyResults({ issues, onDismiss, onResolveAll, onResolveOne, resolvingAll, resolvingIdx, title = 'Verification', lockedNote = null }) {
  const busy = resolvingAll || (resolvingIdx && resolvingIdx.size > 0);
  return (
    <div className="border border-port-border rounded p-3 bg-port-bg/50 space-y-2">
      {lockedNote ? (
        <p className="text-[11px] text-port-warning italic flex items-center gap-1.5">
          <Lock size={11} /> {lockedNote}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-xs uppercase tracking-wider text-gray-500">{title} — {issues.length} issue{issues.length === 1 ? '' : 's'}</h3>
        <div className="flex items-center gap-2">
          {onResolveAll ? (
            <button
              type="button"
              onClick={onResolveAll}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border bg-port-accent/10 text-port-accent border-port-accent/40 hover:bg-port-accent/20 disabled:opacity-40"
              title="Run an LLM pass that rewrites the arc to resolve every finding"
            >
              {resolvingAll ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              Resolve all
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="text-xs text-gray-400 hover:text-white disabled:opacity-40"
          >
            Dismiss
          </button>
        </div>
      </div>
      <ul className="space-y-2">
        {issues.map((iss, i) => {
          const resolvingThis = resolvingIdx && resolvingIdx.has(i);
          return (
            <li key={i} className={`text-xs p-2 rounded border ${SEVERITY_COLORS[iss.severity] || SEVERITY_COLORS.medium}`}>
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle size={12} />
                <span className="uppercase tracking-wider font-semibold">{iss.severity}</span>
                {iss.location ? <span className="text-gray-500">— {iss.location}</span> : null}
                {onResolveOne ? (
                  <button
                    type="button"
                    onClick={() => onResolveOne(i, iss)}
                    disabled={busy}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border border-port-border bg-port-bg text-gray-300 hover:text-white hover:border-port-accent/40 disabled:opacity-40"
                    title="Run an LLM pass that rewrites the arc to resolve only this finding"
                  >
                    {resolvingThis ? <Loader2 size={10} className="animate-spin" /> : <Wand2 size={10} />}
                    Resolve
                  </button>
                ) : null}
              </div>
              <p className="text-gray-200">{iss.problem}</p>
              {iss.suggestion ? <p className="mt-1 text-gray-400 italic">→ {iss.suggestion}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- Season + child issues ----

function SeasonRow({ series, season, seasons, issues, onSeriesUpdate, onIssuesUpdate }) {
  const [collapsed, setCollapsed] = useState(false);
  const [generatingEpisodes, setGeneratingEpisodes] = useState(false);
  const [editing, setEditing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyIssues, setVerifyIssues] = useState(null);
  const seasonLocked = season.locked === true;
  const { busy: lockBusy, toggle: toggleSeasonLock } = useLockToggle({
    patchFn: (next) => updatePipelineSeason(series.id, season.id, { locked: next }),
    onSuccess: (updated) => onSeriesUpdate({
      ...series,
      seasons: seasons.map((s) => (s.id === season.id ? updated : s)),
    }),
    lockedMessage: `Volume ${season.number} locked — generation, delete, and content edits are blocked`,
    unlockedMessage: `Volume ${season.number} unlocked`,
    errorMessage: 'Lock toggle failed',
  });
  // Volume beat-sheet bulk run — `active` gates SSE subscription; the latest
  // frame drives the per-issue label on the button.
  const [beatsActive, setBeatsActive] = useState(false);
  const [beatsStarting, setBeatsStarting] = useState(false);
  const { latest: beatsLatest } = usePipelineVolumeBeatsProgress(series.id, season.id, { enabled: beatsActive });

  // Stable ref over the parent's setter — `handleIssuesUpdate` in
  // PipelineSeries is re-allocated every render, so depending on it would
  // re-run this effect on every parent update.
  const onIssuesUpdateRef = useRef(onIssuesUpdate);
  onIssuesUpdateRef.current = onIssuesUpdate;

  // Refresh issues + toast when the run lands on a terminal frame and tear
  // the SSE subscription down. Per-issue frames just drive the button
  // label — refetching the whole list per issue would cost N+1 reads per
  // run for no benefit (the button already shows live ordinal/total).
  useEffect(() => {
    if (!beatsActive || !beatsLatest) return;
    const type = beatsLatest.type;
    if (type !== 'complete' && type !== 'canceled' && type !== 'error') return;
    setBeatsActive(false);
    listPipelineIssues(series.id)
      .then((refreshed) => onIssuesUpdateRef.current(refreshed))
      .catch(() => null);
    if (type === 'complete') {
      const n = beatsLatest.generated || 0;
      const s = beatsLatest.skipped || 0;
      const e = beatsLatest.errored || 0;
      const parts = [`${n} generated`];
      if (s) parts.push(`${s} skipped`);
      if (e) parts.push(`${e} errored`);
      (e > 0 ? toast.error : toast.success)(`Volume ${season.number} beat sheets — ${parts.join(', ')}`);
    } else if (type === 'canceled') {
      toast.success(`Volume ${season.number} beat-sheet run canceled`);
    } else {
      toast.error(beatsLatest.error || 'Beat-sheet run failed');
    }
  }, [beatsActive, beatsLatest, series.id, season.number]);

  const startBeats = async (mode) => {
    setBeatsStarting(true);
    const result = await startPipelineVolumeBeats(series.id, season.id, {
      mode,
      providerOverride: series.llm?.provider || undefined,
      modelOverride: series.llm?.model || undefined,
    }).catch((err) => {
      toast.error(err.message || 'Failed to start beat-sheet run');
      return null;
    });
    setBeatsStarting(false);
    if (!result) return;
    setBeatsActive(true);
  };

  const cancelBeats = async () => {
    await cancelPipelineVolumeBeats(series.id, season.id).catch((err) => {
      toast.error(err.message || 'Cancel failed');
    });
  };

  const hasArc = !!series.arc;
  const hasEpisodes = issues.length > 0;
  const runVerifyVolume = async () => {
    setVerifying(true);
    const result = await verifyPipelineVolume(series.id, season.id, {
      providerOverride: series.llm?.provider || undefined,
      modelOverride: series.llm?.model || undefined,
    }).catch((err) => {
      toast.error(err.message || 'Failed to verify volume');
      return null;
    });
    setVerifying(false);
    if (!result) return;
    setVerifyIssues(result.issues || []);
    const n = (result.issues || []).length;
    if (n === 0) {
      toast.success(`Volume ${season.number} verified — no issues found`);
    } else {
      toast.error(`Volume ${season.number} verification surfaced ${n} issue${n === 1 ? '' : 's'}`);
    }
  };

  const runGenerateEpisodes = async () => {
    if (issues.length > 0) {
      toast.error('Volume already has issues / episodes — clear them first or use the per-issue regenerate flow');
      return;
    }
    setGeneratingEpisodes(true);
    const result = await generatePipelineSeasonEpisodes(series.id, season.id, {
      commit: true,
      providerOverride: series.llm?.provider || undefined,
      modelOverride: series.llm?.model || undefined,
    })
      .catch((err) => {
        toast.error(err.message || 'Failed to generate issues / episodes');
        return null;
      });
    setGeneratingEpisodes(false);
    if (!result) return;
    const refreshed = await listPipelineIssues(series.id).catch(() => null);
    if (refreshed) onIssuesUpdate(refreshed);
    if (result.bibleExtracted?.series) onSeriesUpdate(result.bibleExtracted.series);
    const n = result.createdIssues?.length || 0;
    const extracted = result.bibleExtracted;
    const extractedSummary = extracted
      ? ` (+${extracted.characters} chars, +${extracted.places} places, +${extracted.objects} objects extracted)`
      : '';
    toast.success(`Generated ${n} issue${n === 1 ? '' : 's'} / episode${n === 1 ? '' : 's'}${extractedSummary}`);
  };

  // 'idle' | 'confirm' | 'deleting' — drives an inline confirm row that swaps
  // in for the Edit/Trash buttons. Two-click "arm" was confusing (see
  // feedback memory); inline confirm matches LayoutEditor's pattern.
  const [deleteMode, setDeleteMode] = useState('idle');
  const runDeleteSeason = async () => {
    setDeleteMode('deleting');
    const result = await deletePipelineSeason(series.id, season.id, { reassignTo: null }).catch((err) => {
      toast.error(err.message || 'Delete failed');
      return null;
    });
    if (!result) {
      setDeleteMode('idle');
      return;
    }
    onSeriesUpdate({ ...series, seasons: seasons.filter((s) => s.id !== season.id) });
    const refreshed = await listPipelineIssues(series.id).catch(() => null);
    if (refreshed) onIssuesUpdate(refreshed);
    if (result.reassignedIssueCount > 0) {
      const n = result.reassignedIssueCount;
      toast.success(`Volume deleted; ${n} issue${n === 1 ? '' : 's'} / episode${n === 1 ? '' : 's'} un-grouped`);
    } else {
      toast.success('Volume / season deleted');
    }
  };

  return (
    <li className="bg-port-card border border-port-border rounded-lg">
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="text-gray-500 hover:text-white p-0.5"
          aria-label={collapsed ? 'Expand volume / season' : 'Collapse volume / season'}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <span className="text-xs text-gray-500 font-mono" title="Volume / Season">V{season.number}</span>
        <span className="text-sm text-white font-medium truncate">{season.title || '(untitled)'}</span>
        <span className="text-[10px] uppercase tracking-wider text-gray-500" title="Issues / Episodes">
          {issues.length} / {season.episodeCountTarget || '?'} issues
        </span>
        <div className="ml-auto flex items-center gap-2">
          {deleteMode === 'idle' && (
            <>
              <button
                type="button"
                onClick={() => toggleSeasonLock(seasonLocked)}
                disabled={lockBusy}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border disabled:opacity-50 ${
                  seasonLocked
                    ? 'border-port-warning/40 text-port-warning hover:bg-port-warning/10'
                    : 'border-port-border text-gray-400 hover:text-white'
                }`}
                title={seasonLocked
                  ? 'Volume is locked — click to unlock and allow regeneration, delete, and content edits'
                  : 'Lock this volume to prevent regeneration, delete, and content edits'}
                aria-pressed={seasonLocked}
              >
                {lockBusy
                  ? <Loader2 size={12} className="animate-spin" />
                  : (seasonLocked ? <Lock size={12} /> : <Unlock size={12} />)}
                {seasonLocked ? 'Locked' : 'Lock'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(!editing)}
                className="text-xs text-gray-400 hover:text-white"
              >
                {editing ? 'Done' : 'Edit'}
              </button>
              <button
                type="button"
                onClick={() => setDeleteMode('confirm')}
                disabled={seasonLocked}
                className="p-1.5 text-gray-500 hover:text-port-error disabled:opacity-40 disabled:hover:text-gray-500"
                aria-label={`Delete volume / season ${season.title}`}
                title={seasonLocked
                  ? 'Volume is locked — unlock to delete'
                  : 'Delete volume / season'}
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
          {deleteMode === 'confirm' && (
            <>
              <span className="text-xs text-port-error">Delete volume?</span>
              <button
                type="button"
                onClick={() => setDeleteMode('idle')}
                className="px-2 py-0.5 text-xs text-gray-300 hover:text-white rounded border border-port-border"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={runDeleteSeason}
                className="px-2 py-0.5 text-xs rounded bg-port-error text-white hover:bg-port-error/80"
              >
                Delete
              </button>
            </>
          )}
          {deleteMode === 'deleting' && (
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <Loader2 size={12} className="animate-spin" />
              Deleting…
            </span>
          )}
        </div>
      </div>

      {editing ? (
        <SeasonEditor
          series={series}
          season={season}
          seasons={seasons}
          onSeriesUpdate={onSeriesUpdate}
          seasonLocked={seasonLocked}
        />
      ) : !collapsed && (season.logline || season.synopsis) ? (
        <div className="px-3 pb-2 text-xs text-gray-400 space-y-1">
          {season.logline ? <p className="italic">{season.logline}</p> : null}
          {season.synopsis ? (
            <details>
              <summary className="cursor-pointer hover:text-white">Synopsis</summary>
              <p className="mt-1 whitespace-pre-wrap">{season.synopsis}</p>
            </details>
          ) : null}
          {season.endingHook ? <p className="text-port-accent/80">↪ {season.endingHook}</p> : null}
        </div>
      ) : null}

      {!collapsed && seasonLocked ? (
        <div className="px-3 pb-2 text-xs text-port-warning flex items-center gap-1.5">
          <Lock size={11} /> Volume locked — generation, delete, and content edits are blocked. Unlock above to make changes.
        </div>
      ) : null}

      {!collapsed ? (
        <>
          <ul className="px-3 pb-2 space-y-1.5">
            {issues.map((iss) => (
              <IssueRow
                key={iss.id}
                issue={iss}
                seasons={seasons}
                onIssuesUpdate={onIssuesUpdate}
              />
            ))}
          </ul>
          {verifyIssues && verifyIssues.length > 0 ? (
            <div className="px-3 pb-3">
              <VerifyResults
                issues={verifyIssues}
                title={`Volume ${season.number} verification`}
                onDismiss={() => setVerifyIssues(null)}
              />
            </div>
          ) : null}
          <VolumeCoversPanel
            series={series}
            season={season}
            seasons={seasons}
            onSeriesUpdate={onSeriesUpdate}
          />
          <SeasonActions
            series={series}
            season={season}
            seasonLocked={seasonLocked}
            hasArc={hasArc}
            hasEpisodes={hasEpisodes}
            generatingEpisodes={generatingEpisodes}
            verifying={verifying}
            onGenerateEpisodes={runGenerateEpisodes}
            onValidateVolume={runVerifyVolume}
            onIssuesUpdate={onIssuesUpdate}
            beatsActive={beatsActive}
            beatsStarting={beatsStarting}
            beatsLatest={beatsLatest}
            onStartBeats={startBeats}
            onCancelBeats={cancelBeats}
          />
        </>
      ) : null}
    </li>
  );
}

// Tiny thumb cell — shows the rendered image when present, an empty-state
// dashed box otherwise. Smaller and dependency-free vs ComicScriptStage's
// MediaJobThumb (which tracks live job status); for the Arc canvas's at-a-
// glance row we only need the persisted-filename render.
function VolumeCoverThumb({ slot, label, emptyHint }) {
  const filename = slot?.filename || null;
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      {filename ? (
        <a
          href={`/data/images/${filename}`}
          target="_blank"
          rel="noreferrer"
          className="block aspect-[3/4] bg-port-bg border border-port-border rounded overflow-hidden hover:border-port-accent/40"
        >
          <img src={`/data/images/${filename}`} alt={label} className="w-full h-full object-cover" />
        </a>
      ) : (
        <div className="aspect-[3/4] bg-port-bg border border-dashed border-port-border rounded flex items-center justify-center text-[10px] text-gray-500 text-center p-2">
          {emptyHint}
        </div>
      )}
    </div>
  );
}

function VolumeCoversPanel({ series, season, seasons, onSeriesUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const cover = season.cover || { script: '', proofImage: null, finalImage: null };
  const backCover = season.backCover || { script: '', proofImage: null, finalImage: null };

  // Local draft text so keystrokes don't round-trip until blur.
  const [draftCover, setDraftCover] = useState(cover.script || '');
  const [draftBack, setDraftBack] = useState(backCover.script || '');
  useEffect(() => { setDraftCover(cover.script || ''); }, [cover.script]);
  useEffect(() => { setDraftBack(backCover.script || ''); }, [backCover.script]);

  const [generatingConcepts, setGeneratingConcepts] = useState(false);
  // One in-flight flag per target × variant. Indexed object so the four
  // render buttons share an enable/disable shape without a 4-bool sprawl.
  const [busy, setBusy] = useState({ coverProof: false, coverFinal: false, backProof: false, backFinal: false });

  // Splice the updated season back into series.seasons[] in place — never
  // refetch the series list when a partial update will do.
  const replaceSeasonInSeries = (updatedSeason) => {
    if (!updatedSeason) return;
    onSeriesUpdate({
      ...series,
      seasons: (seasons || []).map((s) => (s.id === updatedSeason.id ? updatedSeason : s)),
    });
  };

  const persistScript = async (target, nextScript) => {
    const updatedSeason = await updatePipelineSeason(series.id, season.id, {
      [target]: { script: nextScript },
    }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    if (updatedSeason) replaceSeasonInSeries(updatedSeason);
  };

  const handleGenerateConcepts = async () => {
    setGeneratingConcepts(true);
    const result = await generatePipelineVolumeCoverConcepts(series.id, season.id, {
      commit: true,
      providerOverride: series.llm?.provider || undefined,
      modelOverride: series.llm?.model || undefined,
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to generate cover concepts');
      return null;
    });
    setGeneratingConcepts(false);
    if (!result) return;
    if (result.series) {
      // Server returned the full updated series — use it for the in-place splice.
      onSeriesUpdate(result.series);
    } else if (result.season) {
      replaceSeasonInSeries(result.season);
    }
    const parts = [];
    if (result.seeded?.cover) parts.push('front');
    if (result.seeded?.backCover) parts.push('back');
    if (parts.length === 0) {
      toast.success('Cover concepts generated (existing edits preserved)');
    } else {
      toast.success(`Volume ${season.number} ${parts.join(' + ')} cover concept${parts.length > 1 ? 's' : ''} seeded`);
    }
  };

  const handleRender = async (target, variant) => {
    const busyKey = `${target === 'cover' ? 'cover' : 'back'}${variant === 'final' ? 'Final' : 'Proof'}`;
    setBusy((b) => ({ ...b, [busyKey]: true }));
    const apiCall = target === 'cover' ? generatePipelineVolumeCover : generatePipelineVolumeBackCover;
    const scriptKey = target === 'cover' ? 'coverScript' : 'backCoverScript';
    const draftText = target === 'cover' ? draftCover : draftBack;
    const label = target === 'cover' ? 'cover' : 'back cover';
    const result = await apiCall(series.id, season.id, {
      [scriptKey]: draftText || '',
      target: variant,
    }, { silent: true }).catch((err) => {
      toast.error(err.message || `Failed to render ${variant} ${label}`);
      return null;
    });
    setBusy((b) => ({ ...b, [busyKey]: false }));
    if (!result) return;
    if (result.series) onSeriesUpdate(result.series);
    else if (result.season) replaceSeasonInSeries(result.season);
    toast.success(`Queued ${result.mode} volume ${variant} ${label} render (${result.jobId.slice(0, 8)})`);
  };

  // PDF readiness mirrors the server's pickRenderedFilename fallback chain
  // (finalImage → proofImage → legacy filename) — see lib/renderSlot.js.
  const volCoverRendered = !!(cover.finalImage?.filename || cover.proofImage?.filename || cover.filename);
  const volPdfReady = volCoverRendered;
  const volPdfHref = volPdfReady ? pipelineVolumePdfUrl(series.id, season.id) : undefined;
  const volPdfTitle = volPdfReady
    ? 'Compile a trade-paperback PDF — volume front + every issue (cover, pages, back) + volume back.'
    : 'Render the volume front cover first.';

  return (
    <div className="px-3 pb-3 border-t border-port-border/50 pt-2 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Volume covers
          <span className="text-[10px] text-gray-500">
            {volCoverRendered ? '(front rendered)' : '(none yet)'}
          </span>
        </button>
        <button
          type="button"
          onClick={handleGenerateConcepts}
          disabled={generatingConcepts}
          title="Have the LLM propose front + back cover concepts for the volume"
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-port-accent hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40"
        >
          {generatingConcepts ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          Generate cover concepts (LLM)
        </button>
        <a
          href={volPdfHref}
          aria-disabled={!volPdfReady}
          onClick={(e) => { if (!volPdfReady) e.preventDefault(); }}
          title={volPdfTitle}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${
            volPdfReady
              ? 'text-white bg-port-card border-port-border hover:border-port-accent/50'
              : 'text-gray-500 bg-port-card border-port-border cursor-not-allowed'
          }`}
        >
          <FileDown size={12} /> Compile volume PDF
        </a>
      </div>

      {expanded ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <VolumeCoverEditorBox
            label="Front cover"
            record={cover}
            draft={draftCover}
            setDraft={setDraftCover}
            onPersist={(next) => persistScript('cover', next)}
            onRenderProof={() => handleRender('cover', 'proof')}
            onRenderFinal={() => handleRender('cover', 'final')}
            renderingProof={busy.coverProof}
            renderingFinal={busy.coverFinal}
            placeholder="Volume front cover concept — iconic image for the whole volume. Series masthead + 'Vol. N' tag added by the renderer."
            proofTitle="Render a fast proof of the volume front cover"
            finalTitle="Render the hi-res final volume front cover"
          />
          <VolumeCoverEditorBox
            label="Back cover"
            record={backCover}
            draft={draftBack}
            setDraft={setDraftBack}
            onPersist={(next) => persistScript('backCover', next)}
            onRenderProof={() => handleRender('backCover', 'proof')}
            onRenderFinal={() => handleRender('backCover', 'final')}
            renderingProof={busy.backProof}
            renderingFinal={busy.backFinal}
            placeholder="Volume back cover concept — illustration only. No text, no masthead. Quiet companion image."
            proofTitle="Render a fast proof of the volume back cover"
            finalTitle="Render the hi-res final volume back cover"
          />
        </div>
      ) : null}
    </div>
  );
}

// One panel inside VolumeCoversPanel — header (label + 2 render buttons),
// editable script textarea, and the 2-thumb proof/final row. The front-
// and back-cover panels are structurally identical; props carry only what
// actually differs (label, persisted record, render handlers, placeholder).
function VolumeCoverEditorBox({
  label, record, draft, setDraft, onPersist,
  onRenderProof, onRenderFinal, renderingProof, renderingFinal,
  placeholder, proofTitle, finalTitle,
}) {
  return (
    <div className="space-y-2 p-2 bg-port-bg border border-port-border rounded">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRenderProof}
            disabled={renderingProof}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-40"
            title={proofTitle}
          >
            {renderingProof ? <Loader2 size={10} className="animate-spin" /> : <ImageIcon size={10} />}
            Proof
          </button>
          <button
            type="button"
            onClick={onRenderFinal}
            disabled={renderingFinal}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-40"
            title={finalTitle}
          >
            {renderingFinal ? <Loader2 size={10} className="animate-spin" /> : <Layers size={10} />}
            Final
          </button>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if ((record.script || '') !== draft) onPersist(draft);
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full px-2 py-1 bg-port-card border border-port-border rounded text-white text-xs"
        maxLength={8000}
      />
      <div className="grid grid-cols-2 gap-2">
        <VolumeCoverThumb slot={record.proofImage} label="Proof" emptyHint="No proof yet." />
        <VolumeCoverThumb slot={record.finalImage} label="Final" emptyHint="No final yet." />
      </div>
    </div>
  );
}

function SeasonEditor({ series, season, seasons, onSeriesUpdate, seasonLocked = false }) {
  const [draft, setDraft] = useState(season);
  const [saving, setSaving] = useState(false);
  // Content fields (title/number/logline/synopsis/endingHook/episodeCountTarget)
  // are frozen when the season is locked — status stays editable since
  // production workflow can advance independently of editorial freeze.
  // Server's `LOCKED_SEASON_ALLOWED_KEYS` mirrors this contract.
  const contentDisabled = seasonLocked;

  const save = async () => {
    setSaving(true);
    const patch = seasonLocked
      ? { status: draft.status }
      : {
        title: draft.title,
        number: Number(draft.number) || season.number,
        logline: draft.logline,
        synopsis: draft.synopsis,
        endingHook: draft.endingHook,
        episodeCountTarget: Number(draft.episodeCountTarget) || 0,
        status: draft.status,
      };
    const updated = await updatePipelineSeason(series.id, season.id, patch).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    setSaving(false);
    if (!updated) return;
    onSeriesUpdate({
      ...series,
      seasons: seasons.map((s) => s.id === season.id ? updated : s).sort((a, b) => (a.number || 0) - (b.number || 0)),
    });
    toast.success('Volume / season saved');
  };

  const contentInputClass = `px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm ${contentDisabled ? 'opacity-60' : ''}`;

  return (
    <div className="px-3 pb-3 space-y-2 bg-port-bg/40 border-t border-port-border">
      <div className="grid grid-cols-[1fr_auto] gap-2 pt-2">
        <input
          value={draft.title || ''}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          disabled={contentDisabled}
          placeholder="Title"
          className={contentInputClass}
          maxLength={200}
        />
        <input
          type="number"
          value={draft.number || 0}
          onChange={(e) => setDraft({ ...draft, number: parseInt(e.target.value, 10) || 0 })}
          disabled={contentDisabled}
          placeholder="#"
          className={`w-16 ${contentInputClass}`}
          min={0}
          max={99}
        />
      </div>
      <input
        value={draft.logline || ''}
        onChange={(e) => setDraft({ ...draft, logline: e.target.value })}
        disabled={contentDisabled}
        placeholder="One-sentence logline"
        className={`w-full ${contentInputClass}`}
        maxLength={500}
      />
      <textarea
        value={draft.synopsis || ''}
        onChange={(e) => setDraft({ ...draft, synopsis: e.target.value })}
        disabled={contentDisabled}
        placeholder="Season synopsis (~200 words)"
        rows={4}
        className={`w-full ${contentInputClass}`}
        maxLength={4000}
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          value={draft.endingHook || ''}
          onChange={(e) => setDraft({ ...draft, endingHook: e.target.value })}
          disabled={contentDisabled}
          placeholder="Ending hook"
          className={contentInputClass}
          maxLength={1000}
        />
        <input
          type="number"
          value={draft.episodeCountTarget || 0}
          onChange={(e) => setDraft({ ...draft, episodeCountTarget: parseInt(e.target.value, 10) || 0 })}
          disabled={contentDisabled}
          placeholder="Issue / episode target"
          title="Issue / episode count target for this volume / season"
          className={contentInputClass}
          min={0}
        />
      </div>
      <div className="flex items-center gap-2">
        <select
          value={draft.status || 'draft'}
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
        >
          <option value="draft">draft</option>
          <option value="verified">verified</option>
          <option value="in-production">in-production</option>
          <option value="complete">complete</option>
        </select>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}

// Volume beat-sheet runner frame → button label. Keyed on the SSE frame's
// `type` field; see server/services/pipeline/volumeBeatsRunner.js for the
// frame shapes.
const BEATS_FRAME_LABELS = {
  start: (f) => `Starting (${f.total} issues)…`,
  'issue:start': (f) => `Generating ${f.ordinal}/${f.total} — ${f.issueTitle || `#${f.issueNumber}`}`,
  'issue:complete': (f) => `${f.ordinal}/${f.total} done`,
  'issue:skip': (f) => `Skipped ${f.ordinal}/${f.total}`,
  'issue:error': (f) => `Error on ${f.ordinal}/${f.total}`,
};

function SeasonActions({
  series, season, seasonLocked = false, hasArc, hasEpisodes, generatingEpisodes,
  verifying, onGenerateEpisodes, onValidateVolume, onIssuesUpdate,
  beatsActive, beatsStarting, beatsLatest, onStartBeats, onCancelBeats,
}) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  // Inline mode picker — surfaces only when the user clicks the button
  // (per Ask each time choice for skip-existing vs regenerate-all).
  const [beatsModePicker, setBeatsModePicker] = useState(false);
  const seasonHasContext = !!(season.logline?.trim() || season.synopsis?.trim());

  const handleAdd = async (e) => {
    e?.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    const created = await createPipelineIssue(series.id, {
      title,
      seasonId: season.id,
      // arcPosition = max(existing) + 1 — sequential within the season.
      arcPosition: null, // server will fall through to null; we'll patch right after to set position
    }).catch((err) => {
      toast.error(err.message || 'Failed to create episode');
      return null;
    });
    if (!created) return;
    // Re-fetch so the issue lands in the right group.
    const refreshed = await listPipelineIssues(series.id).catch(() => null);
    if (refreshed) onIssuesUpdate(refreshed);
    setNewTitle('');
    setAdding(false);
    toast.success(`Issue / Episode "${created.title}" added`);
  };

  // Validate volume needs (1) an authored arc on the parent series and
  // (2) at least one issue under this volume — otherwise there is nothing
  // for the LLM to check against the volume's promises.
  const validateDisabledReason = !hasArc
    ? 'Generate the series arc first (the volume verifier checks against the arc)'
    : !hasEpisodes
      ? 'Add or generate at least one issue / episode first'
      : null;

  // Generate-all-beats needs episodes to iterate over; the per-issue
  // generator handles the "no arc context" case gracefully so we don't gate
  // on hasArc here.
  const beatsDisabledReason = !hasEpisodes
    ? 'Add or generate at least one issue / episode first'
    : null;

  // Human-readable status string for the in-flight button label. Terminal
  // frames (complete/canceled/error) are absorbed by the parent useEffect.
  const beatsLabel = beatsActive && beatsLatest
    ? (BEATS_FRAME_LABELS[beatsLatest.type]?.(beatsLatest) ?? null)
    : (beatsStarting ? 'Starting…' : null);

  return (
    <>
      <div className="px-3 pb-2 pt-2 border-t border-port-border/50 flex items-center gap-2 flex-wrap">
        {adding ? (
          <form onSubmit={handleAdd} className="flex items-center gap-2 flex-1">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Issue / Episode title…"
              className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
              autoFocus
              maxLength={300}
            />
            <button
              type="submit"
              disabled={!newTitle.trim()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-40"
            >
              <Plus size={12} /> Add
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setNewTitle(''); }}
              className="text-xs text-gray-400 hover:text-white px-2"
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg"
            >
              <Plus size={12} /> Add issue / episode
            </button>
            <button
              type="button"
              onClick={onGenerateEpisodes}
              disabled={generatingEpisodes || hasEpisodes || !seasonHasContext || seasonLocked}
              title={
                seasonLocked
                  ? 'Volume is locked — unlock to generate episodes'
                  : hasEpisodes
                    ? 'Volume already has issues / episodes'
                    : !seasonHasContext
                      ? 'Add a volume logline or synopsis first'
                      : 'Have an LLM plan the per-issue / per-episode breakdown'
              }
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-port-accent hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40 disabled:hover:text-port-accent"
            >
              {generatingEpisodes ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              Generate issues / episodes (LLM)
            </button>
            <button
              type="button"
              onClick={() => setBeatsModePicker((v) => !v)}
              disabled={!!beatsDisabledReason || beatsActive || beatsStarting}
              title={beatsDisabledReason || `Generate beat sheets for every issue in volume ${season.number} sequentially`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40 disabled:hover:text-gray-300"
            >
              {beatsStarting || beatsActive ? <Loader2 size={12} className="animate-spin" /> : <ListChecks size={12} />}
              Generate beat sheets
            </button>
            {beatsActive ? (
              <button
                type="button"
                onClick={onCancelBeats}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-port-warning hover:text-white border border-port-warning/40 bg-port-bg hover:bg-port-warning/10"
                title="Stop the run after the current issue finishes"
              >
                <X size={12} /> Stop
              </button>
            ) : null}
            <button
              type="button"
              onClick={onValidateVolume}
              disabled={!!validateDisabledReason || verifying}
              title={validateDisabledReason || `Deep continuity pass on volume ${season.number}`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40 disabled:hover:text-gray-300"
            >
              {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
              Validate volume
            </button>
          </>
        )}
      </div>
      {beatsModePicker && !beatsActive && !beatsStarting ? (
        <div className="mx-3 mb-2 p-2 border border-port-border rounded bg-port-bg/60 text-xs space-y-2">
          <p className="text-gray-300">
            Generate beat sheets for every issue in volume {season.number}, one at a time.
            Each prompt picks up the prior issue's freshly-written beats.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => { setBeatsModePicker(false); onStartBeats('skip-existing'); }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-port-accent text-white hover:bg-port-accent/80"
              title="Only generate for issues that don't already have a beat sheet"
            >
              Skip issues with beats
            </button>
            <button
              type="button"
              onClick={() => { setBeatsModePicker(false); onStartBeats('regenerate-all'); }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-port-warning/40 text-port-warning hover:bg-port-warning/10"
              title="Overwrite every issue's existing beat sheet"
            >
              Regenerate all
            </button>
            <button
              type="button"
              onClick={() => setBeatsModePicker(false)}
              className="text-gray-400 hover:text-white px-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {beatsLabel ? (
        <div className="px-3 pb-2 text-xs text-gray-400 flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          {beatsLabel}
        </div>
      ) : null}
      {!adding ? (
        <div className="px-3 pb-3">
          <VerifyScopeHint scope={VERIFY_VOLUME_SCOPE} />
        </div>
      ) : null}
    </>
  );
}

function IssueRow({ issue, seasons, onIssuesUpdate }) {
  const [reassigning, setReassigning] = useState(false);

  const runDelete = async () => {
    const ok = await deletePipelineIssue(issue.id).catch((err) => {
      toast.error(err.message || 'Delete failed');
      return null;
    });
    if (ok == null) return;
    onIssuesUpdate((prev) => prev.filter((i) => i.id !== issue.id));
  };
  const [armDelete, armedDelete] = useArmedAction(runDelete);
  const handleDelete = (e) => {
    e.preventDefault();
    e.stopPropagation();
    armedDelete();
  };

  const handleReassign = async (newSeasonId) => {
    if (newSeasonId === (issue.seasonId || '')) return;
    setReassigning(true);
    const patched = await updatePipelineIssue(issue.id, {
      seasonId: newSeasonId || null,
    }).catch((err) => {
      toast.error(err.message || 'Reassign failed');
      return null;
    });
    setReassigning(false);
    if (!patched) return;
    onIssuesUpdate((prev) => prev.map((i) => i.id === issue.id ? patched : i));
  };

  return (
    <li className="group flex items-center gap-2 p-2 rounded hover:bg-port-bg/40">
      <Link
        to={`/pipeline/issues/${issue.id}/idea`}
        className="flex items-center gap-2 flex-1 min-w-0"
      >
        <span className="text-[10px] text-gray-500 font-mono w-8 shrink-0">
          {issue.arcPosition ? `E${issue.arcPosition}` : `#${issue.number}`}
        </span>
        <span className="text-sm text-white truncate">{issue.title || 'Untitled'}</span>
        <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${ISSUE_STATUS_COLORS[issue.status] || ISSUE_STATUS_COLORS.draft}`}>
          {issue.status}
        </span>
        <span className="text-[10px] text-gray-600">updated {timeAgo(issue.updatedAt)}</span>
      </Link>
      <select
        value={issue.seasonId || ''}
        onChange={(e) => handleReassign(e.target.value)}
        disabled={reassigning}
        title="Move to a different season"
        className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-[10px] bg-port-bg border border-port-border rounded text-gray-300 max-w-[100px]"
      >
        <option value="">— ungrouped —</option>
        {seasons.map((s) => (
          <option key={s.id} value={s.id}>V{s.number}: {s.title}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={handleDelete}
        className={`p-1 ${armDelete ? 'text-port-error opacity-100' : 'text-gray-500 hover:text-port-error opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
        aria-label={armDelete ? `Confirm delete ${issue.title}` : `Delete ${issue.title}`}
        title={armDelete ? 'Click again to confirm' : 'Delete issue / episode'}
      >
        <Trash2 size={12} />
      </button>
    </li>
  );
}

function UngroupedIssues({ issues, seasons, onIssuesUpdate }) {
  return (
    <section className="bg-port-card border border-port-border rounded-lg">
      <div className="flex items-center gap-2 p-3 border-b border-port-border">
        <ChevronsUpDown size={16} className="text-gray-500" />
        <h3 className="text-xs uppercase tracking-wider text-gray-500">
          Un-grouped issues / episodes ({issues.length})
        </h3>
      </div>
      <ul className="px-3 py-2 space-y-1.5">
        {issues.map((iss) => (
          <IssueRow
            key={iss.id}
            issue={iss}
            seasons={seasons}
            onIssuesUpdate={onIssuesUpdate}
          />
        ))}
      </ul>
    </section>
  );
}

function AddSeasonRow({ series, onSeriesUpdate }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async (e) => {
    e?.preventDefault();
    const t = title.trim();
    if (!t) return;
    setSaving(true);
    const created = await createPipelineSeason(series.id, { title: t }).catch((err) => {
      toast.error(err.message || 'Failed to create volume / season');
      return null;
    });
    setSaving(false);
    if (!created) return;
    onSeriesUpdate({
      ...series,
      seasons: [...(series.seasons || []), created].sort((a, b) => (a.number || 0) - (b.number || 0)),
    });
    setTitle('');
    setAdding(false);
    toast.success(`Volume / Season ${created.number}: ${created.title} added`);
  };

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="inline-flex items-center gap-1 px-3 py-2 rounded border border-dashed border-port-border bg-port-bg text-sm text-gray-400 hover:text-white hover:border-port-accent/40"
      >
        <Plus size={14} /> Add volume / season
      </button>
    );
  }
  return (
    <form onSubmit={handleAdd} className="flex items-center gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Volume / Season title…"
        className="w-72 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
        autoFocus
        maxLength={200}
      />
      <button
        type="submit"
        disabled={!title.trim() || saving}
        className="inline-flex items-center gap-1 px-3 py-2 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-40"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        Add volume / season
      </button>
      <button
        type="button"
        onClick={() => { setAdding(false); setTitle(''); }}
        className="text-xs text-gray-400 hover:text-white px-2"
      >
        Cancel
      </button>
    </form>
  );
}
