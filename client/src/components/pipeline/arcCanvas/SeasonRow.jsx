import { useEffect, useRef, useState } from 'react';
import { Trash2, Loader2, ChevronRight, ChevronDown, Lock, Unlock } from 'lucide-react';
import toast from '../../ui/Toast';
import { useLockToggle } from '../../../hooks/useLockToggle';
import {
  updatePipelineSeason, deletePipelineSeason,
  generatePipelineSeasonEpisodes, verifyPipelineVolume,
  listPipelineIssues,
  startPipelineVolumeBeats, cancelPipelineVolumeBeats,
  pipelineVolumeBeatsSseUrl,
} from '../../../services/api';
import { usePipelineProgress } from '../../../hooks/usePipelineProgress';
import CoverArt from './CoverArt.jsx';
import VerifyResults from './VerifyResults.jsx';
import VolumeCoverLiveUpdates from './VolumeCoverLiveUpdates.jsx';
import VolumeCoversPanel from './VolumeCoversPanel.jsx';
import SeasonEditor from './SeasonEditor.jsx';
import SeasonActions from './SeasonActions.jsx';
import IssueRow from './IssueRow.jsx';

export default function SeasonRow({ series, season, seasons, issues, onSeriesUpdate, onIssuesUpdate }) {
  const [collapsed, setCollapsed] = useState(false);
  const [generatingEpisodes, setGeneratingEpisodes] = useState(false);
  const [editing, setEditing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyIssues, setVerifyIssues] = useState(null);
  const seasonLocked = season.locked === true;
  const { busy: lockBusy, toggle: toggleSeasonLock } = useLockToggle({
    patchFn: (next) => updatePipelineSeason(series.id, season.id, { locked: next }, { silent: true }),
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
  const { latest: beatsLatest } = usePipelineProgress(pipelineVolumeBeatsSseUrl, [series.id, season.id], { enabled: beatsActive });

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
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to start beat-sheet run');
      return null;
    });
    setBeatsStarting(false);
    if (!result) return;
    setBeatsActive(true);
  };

  const cancelBeats = async () => {
    await cancelPipelineVolumeBeats(series.id, season.id, { silent: true }).catch((err) => {
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
    }, { silent: true }).catch((err) => {
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
    }, { silent: true })
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
    const result = await deletePipelineSeason(series.id, season.id, { reassignTo: null }, { silent: true }).catch((err) => {
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
      <VolumeCoverLiveUpdates
        series={series}
        season={season}
        onSeriesUpdate={onSeriesUpdate}
      />
      <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 p-3">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="aspect-[3/4] rounded overflow-hidden bg-port-bg border border-port-border hover:border-port-accent/50 transition-colors"
          aria-label={collapsed ? 'Expand volume / season' : 'Collapse volume / season'}
        >
          <CoverArt
            record={season.cover}
            label={`Volume ${season.number} cover`}
            className="rounded-none border-0"
            placeholderClassName="rounded-none border-0"
          />
        </button>
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
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
          {!editing && !collapsed && (season.logline || season.endingHook) ? (
            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(180px,0.45fr)] gap-2 text-xs">
              {season.logline ? <p className="text-gray-300 italic line-clamp-2">{season.logline}</p> : <span />}
              {season.endingHook ? (
                <p className="text-port-accent/80 line-clamp-2">↪ {season.endingHook}</p>
              ) : null}
            </div>
          ) : null}
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
          {season.synopsis ? (
            <details>
              <summary className="cursor-pointer hover:text-white">Synopsis</summary>
              <p className="mt-1 whitespace-pre-wrap max-h-32 overflow-y-auto pr-1">{season.synopsis}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      {!collapsed && seasonLocked ? (
        <div className="px-3 pb-2 text-xs text-port-warning flex items-center gap-1.5">
          <Lock size={11} /> Volume locked — generation, delete, and content edits are blocked. Unlock above to make changes.
        </div>
      ) : null}

      {!collapsed ? (
        <>
          <ul className="px-3 pb-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6 gap-3">
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
