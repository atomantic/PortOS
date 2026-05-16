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

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, Trash2, Loader2, Sparkles, ShieldCheck, ChevronRight, ChevronDown,
  ChevronsUpDown, AlertCircle, Wand2,
} from 'lucide-react';
import toast from '../ui/Toast';
import { timeAgo } from '../../utils/formatters';
import { useArmedAction } from '../../hooks/useArmedAction';
import {
  createPipelineIssue, deletePipelineIssue, updatePipelineIssue,
  createPipelineSeason, updatePipelineSeason, deletePipelineSeason,
  generatePipelineArcOverview, generatePipelineSeasonEpisodes, verifyPipelineArc,
  resolvePipelineArcIssues,
  listPipelineIssues, updatePipelineSeries,
} from '../../services/api';
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

export default function ArcCanvas({ series, issues, onSeriesUpdate, onIssuesUpdate, onFlushPending }) {
  const seasons = series.seasons || [];
  // Group issues by seasonId for the tree; ungrouped issues land under null.
  const issuesBySeason = new Map();
  for (const iss of issues) {
    const key = iss.seasonId || null;
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
  const [running, setRunning] = useState(null); // 'generate' | 'verify' | 'resolve' | null
  const [verifyIssues, setVerifyIssues] = useState(null);
  // Which finding indexes have an in-flight per-finding resolve. Lets the row
  // show its own spinner without blocking the rest of the page.
  const [resolvingIdx, setResolvingIdx] = useState(new Set());

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
      // Server doesn't touch issues during resolve, but season reassignments
      // can shift counts — refresh so the UI tree stays in sync.
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
          <button
            type="button"
            onClick={runGenerate}
            disabled={!!running}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border transition-colors bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
          >
            {running === 'generate' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {generateBtnLabel}
          </button>
          {hasGeneratedArc ? (
            <button
              type="button"
              onClick={runVerify}
              disabled={!!running}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border bg-port-bg text-gray-300 border-port-border hover:border-port-accent/40 disabled:opacity-40"
            >
              {running === 'verify' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Verify arc
            </button>
          ) : null}
        </div>
      </div>

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
          onResolveAll={resolveAll}
          onResolveOne={resolveOne}
          resolvingAll={running === 'resolve' && resolvingIdx.size === 0}
          resolvingIdx={resolvingIdx}
        />
      ) : null}
    </section>
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
        <input
          value={(draft.themes || []).join(', ')}
          onChange={(e) => setDraft({ ...draft, themes: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
          placeholder="Themes (comma-separated)"
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
        />
        <ArcShapePicker
          value={draft.shape || null}
          onChange={(shape) => setDraft({ ...draft, shape })}
          disabled={saving}
        />
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
      {arc.logline ? <p className="text-sm text-white">{arc.logline}</p> : null}
      {(arc.themes?.length || shapeDef) ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {shapeDef ? (
            <span
              className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-port-accent/40 text-port-accent"
              title={shapeDef.description}
            >
              <ArcShapeSparkline shape={shapeDef} width={48} height={16} />
              {shapeDef.label}
            </span>
          ) : null}
          {arc.themes?.map((t) => (
            <span key={t} className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-port-border text-gray-300">
              {t}
            </span>
          ))}
        </div>
      ) : null}
      {arc.summary ? (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer hover:text-white">Summary</summary>
          <p className="mt-2 whitespace-pre-wrap">{arc.summary}</p>
        </details>
      ) : null}
      {arc.protagonistArc ? (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer hover:text-white">Protagonist arc</summary>
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

function VerifyResults({ issues, onDismiss, onResolveAll, onResolveOne, resolvingAll, resolvingIdx }) {
  const busy = resolvingAll || (resolvingIdx && resolvingIdx.size > 0);
  return (
    <div className="border border-port-border rounded p-3 bg-port-bg/50 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-xs uppercase tracking-wider text-gray-500">Verification — {issues.length} issue{issues.length === 1 ? '' : 's'}</h3>
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
      ? ` (+${extracted.characters} chars, +${extracted.settings} settings, +${extracted.objects} objects extracted)`
      : '';
    toast.success(`Generated ${n} issue${n === 1 ? '' : 's'} / episode${n === 1 ? '' : 's'}${extractedSummary}`);
  };

  const runDeleteSeason = async () => {
    const result = await deletePipelineSeason(series.id, season.id, { reassignTo: null }).catch((err) => {
      toast.error(err.message || 'Delete failed');
      return null;
    });
    if (!result) return;
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
  const [armDelete, deleteSeason] = useArmedAction(runDeleteSeason);

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
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          className="ml-auto text-xs text-gray-400 hover:text-white"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
        <button
          type="button"
          onClick={deleteSeason}
          className={`p-1.5 ${armDelete ? 'text-port-error' : 'text-gray-500 hover:text-port-error'}`}
          aria-label={armDelete ? `Confirm delete volume / season ${season.title}` : `Delete volume / season ${season.title}`}
          title={armDelete ? 'Click again to confirm' : 'Delete volume / season'}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {editing ? (
        <SeasonEditor series={series} season={season} seasons={seasons} onSeriesUpdate={onSeriesUpdate} />
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
          <SeasonActions
            series={series}
            season={season}
            hasEpisodes={issues.length > 0}
            generatingEpisodes={generatingEpisodes}
            onGenerateEpisodes={runGenerateEpisodes}
            onIssuesUpdate={onIssuesUpdate}
          />
        </>
      ) : null}
    </li>
  );
}

function SeasonEditor({ series, season, seasons, onSeriesUpdate }) {
  const [draft, setDraft] = useState(season);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const updated = await updatePipelineSeason(series.id, season.id, {
      title: draft.title,
      number: Number(draft.number) || season.number,
      logline: draft.logline,
      synopsis: draft.synopsis,
      endingHook: draft.endingHook,
      episodeCountTarget: Number(draft.episodeCountTarget) || 0,
      status: draft.status,
    }).catch((err) => {
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

  return (
    <div className="px-3 pb-3 space-y-2 bg-port-bg/40 border-t border-port-border">
      <div className="grid grid-cols-[1fr_auto] gap-2 pt-2">
        <input
          value={draft.title || ''}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="Title"
          className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={200}
        />
        <input
          type="number"
          value={draft.number || 0}
          onChange={(e) => setDraft({ ...draft, number: parseInt(e.target.value, 10) || 0 })}
          placeholder="#"
          className="w-16 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          min={0}
          max={99}
        />
      </div>
      <input
        value={draft.logline || ''}
        onChange={(e) => setDraft({ ...draft, logline: e.target.value })}
        placeholder="One-sentence logline"
        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
        maxLength={500}
      />
      <textarea
        value={draft.synopsis || ''}
        onChange={(e) => setDraft({ ...draft, synopsis: e.target.value })}
        placeholder="Season synopsis (~200 words)"
        rows={4}
        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
        maxLength={4000}
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          value={draft.endingHook || ''}
          onChange={(e) => setDraft({ ...draft, endingHook: e.target.value })}
          placeholder="Ending hook"
          className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={1000}
        />
        <input
          type="number"
          value={draft.episodeCountTarget || 0}
          onChange={(e) => setDraft({ ...draft, episodeCountTarget: parseInt(e.target.value, 10) || 0 })}
          placeholder="Issue / episode target"
          title="Issue / episode count target for this volume / season"
          className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
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

function SeasonActions({ series, season, hasEpisodes, generatingEpisodes, onGenerateEpisodes, onIssuesUpdate }) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
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

  return (
    <div className="px-3 pb-3 pt-1 border-t border-port-border/50 flex items-center gap-2 flex-wrap">
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
            disabled={generatingEpisodes || hasEpisodes || !seasonHasContext}
            title={
              hasEpisodes
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
        </>
      )}
    </div>
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
