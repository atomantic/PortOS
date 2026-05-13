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

import { useState } from 'react';
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
  listPipelineIssues, updatePipelineSeries,
} from '../../services/api';

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

export default function ArcCanvas({ series, issues, onSeriesUpdate, onIssuesUpdate }) {
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
      <ArcHeader series={series} onSeriesUpdate={onSeriesUpdate} />

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

function ArcHeader({ series, onSeriesUpdate }) {
  const arc = series.arc;
  const [running, setRunning] = useState(null); // 'generate' | 'verify' | null
  const [verifyIssues, setVerifyIssues] = useState(null);

  const runGenerate = async () => {
    setRunning('generate');
    const result = await generatePipelineArcOverview(series.id, { commit: true }).catch((err) => {
      toast.error(err.message || 'Failed to generate arc');
      return null;
    });
    setRunning(null);
    if (!result) return;
    onSeriesUpdate(result.series);
    toast.success('Arc generated and saved');
  };
  // Two-click-arm pattern only applies when there's already an arc to clobber
  // — first-time generation skips the confirm.
  const [armReplace, armedGenerate] = useArmedAction(runGenerate);
  const tryGenerate = () => (arc ? armedGenerate() : runGenerate());

  const runVerify = async () => {
    setRunning('verify');
    const result = await verifyPipelineArc(series.id).catch((err) => {
      toast.error(err.message || 'Failed to verify arc');
      return null;
    });
    setRunning(null);
    if (!result) return;
    setVerifyIssues(result.issues || []);
    if ((result.issues || []).length === 0) {
      toast.success('Arc verified — no issues found');
    } else {
      toast.error(`Arc verification surfaced ${result.issues.length} issue${result.issues.length === 1 ? '' : 's'}`);
    }
  };

  const generateBtnLabel = !arc ? 'Generate arc'
    : armReplace ? 'Click again to replace'
      : 'Regenerate arc';

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xs uppercase tracking-wider text-gray-500">Series arc</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={tryGenerate}
            disabled={!!running}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border transition-colors ${
              armReplace
                ? 'bg-port-warning/10 text-port-warning border-port-warning/40'
                : 'bg-port-bg text-port-accent border-port-border hover:border-port-accent/40'
            } disabled:opacity-40`}
          >
            {running === 'generate' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {generateBtnLabel}
          </button>
          {arc ? (
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
          No arc yet — describe the series in the bible, then click <em>Generate arc</em> to have an LLM propose a multi-season spine + season breakdown.
        </p>
      )}

      {verifyIssues && verifyIssues.length > 0 ? (
        <VerifyResults issues={verifyIssues} onDismiss={() => setVerifyIssues(null)} />
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
          placeholder="Multi-season summary (~500 words)"
          rows={6}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={8000}
        />
        <textarea
          value={draft.protagonistArc || ''}
          onChange={(e) => setDraft({ ...draft, protagonistArc: e.target.value })}
          placeholder="Protagonist arc across all seasons"
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

  return (
    <div className="space-y-2">
      {arc.logline ? <p className="text-sm text-white">{arc.logline}</p> : null}
      {arc.themes?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {arc.themes.map((t) => (
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

function VerifyResults({ issues, onDismiss }) {
  return (
    <div className="border border-port-border rounded p-3 bg-port-bg/50 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wider text-gray-500">Verification — {issues.length} issue{issues.length === 1 ? '' : 's'}</h3>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-gray-400 hover:text-white"
        >
          Dismiss
        </button>
      </div>
      <ul className="space-y-2">
        {issues.map((iss, i) => (
          <li key={i} className={`text-xs p-2 rounded border ${SEVERITY_COLORS[iss.severity] || SEVERITY_COLORS.medium}`}>
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle size={12} />
              <span className="uppercase tracking-wider font-semibold">{iss.severity}</span>
              {iss.location ? <span className="text-gray-500">— {iss.location}</span> : null}
            </div>
            <p className="text-gray-200">{iss.problem}</p>
            {iss.suggestion ? <p className="mt-1 text-gray-400 italic">→ {iss.suggestion}</p> : null}
          </li>
        ))}
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
      toast.error('Season already has episodes — clear them first or use the per-episode regenerate flow');
      return;
    }
    setGeneratingEpisodes(true);
    const result = await generatePipelineSeasonEpisodes(series.id, season.id, { commit: true })
      .catch((err) => {
        toast.error(err.message || 'Failed to generate episodes');
        return null;
      });
    setGeneratingEpisodes(false);
    if (!result) return;
    // Refresh the issues list so the new ones appear under this season.
    const refreshed = await listPipelineIssues(series.id).catch(() => null);
    if (refreshed) onIssuesUpdate(refreshed);
    toast.success(`Generated ${result.createdIssues?.length || 0} episode${result.createdIssues?.length === 1 ? '' : 's'}`);
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
      toast.success(`Season deleted; ${result.reassignedIssueCount} episode${result.reassignedIssueCount === 1 ? '' : 's'} un-grouped`);
    } else {
      toast.success('Season deleted');
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
          aria-label={collapsed ? 'Expand season' : 'Collapse season'}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <span className="text-xs text-gray-500 font-mono">S{season.number}</span>
        <span className="text-sm text-white font-medium truncate">{season.title || '(untitled)'}</span>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">
          {issues.length} / {season.episodeCountTarget || '?'} episodes
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
          aria-label={armDelete ? `Confirm delete season ${season.title}` : `Delete season ${season.title}`}
          title={armDelete ? 'Click again to confirm' : 'Delete season'}
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
    toast.success('Season saved');
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
          placeholder="Episode target"
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
    toast.success(`Episode "${created.title}" added`);
  };

  return (
    <div className="px-3 pb-3 pt-1 border-t border-port-border/50 flex items-center gap-2 flex-wrap">
      {adding ? (
        <form onSubmit={handleAdd} className="flex items-center gap-2 flex-1">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Episode title…"
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
            <Plus size={12} /> Add episode
          </button>
          <button
            type="button"
            onClick={onGenerateEpisodes}
            disabled={generatingEpisodes || hasEpisodes || !seasonHasContext}
            title={
              hasEpisodes
                ? 'Season already has episodes'
                : !seasonHasContext
                  ? 'Add a season logline or synopsis first'
                  : 'Have an LLM plan the per-episode breakdown'
            }
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-port-accent hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40 disabled:hover:text-port-accent"
          >
            {generatingEpisodes ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
            Generate episodes (LLM)
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
          <option key={s.id} value={s.id}>S{s.number}: {s.title}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={handleDelete}
        className={`p-1 ${armDelete ? 'text-port-error opacity-100' : 'text-gray-500 hover:text-port-error opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
        aria-label={armDelete ? `Confirm delete ${issue.title}` : `Delete ${issue.title}`}
        title={armDelete ? 'Click again to confirm' : 'Delete episode'}
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
          Un-grouped episodes ({issues.length})
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
      toast.error(err.message || 'Failed to create season');
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
    toast.success(`Season ${created.number}: ${created.title} added`);
  };

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="inline-flex items-center gap-1 px-3 py-2 rounded border border-dashed border-port-border bg-port-bg text-sm text-gray-400 hover:text-white hover:border-port-accent/40"
      >
        <Plus size={14} /> Add season
      </button>
    );
  }
  return (
    <form onSubmit={handleAdd} className="flex items-center gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Season title…"
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
        Add season
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
