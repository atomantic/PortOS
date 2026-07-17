/**
 * Pipeline Issue — the actual production page.
 *
 * Tab-driven stage navigation per /pipeline/issues/:issueId/:stage. Top action
 * bar exposes the auto-run-text button which kicks off idea→prose→(comicScript
 * + teleplay) and streams progress via SSE.
 */

import { useEffect, useState, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Sparkles, Loader2, X, Lightbulb, BookOpen, FileText, Film as FilmIcon,
  LayoutGrid, Image as ImageIcon, Clapperboard, Users, Settings, Mic, Lock, Unlock,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import Modal from '../components/ui/Modal';
import TabPills from '../components/ui/TabPills';
import {
  getPipelineIssue, getPipelineSeries, updatePipelineIssue,
  startPipelineAutoRunText, cancelPipelineAutoRunText, pipelineAutoRunSseUrl,
  PIPELINE_STAGES, PIPELINE_TAB_STAGES, PIPELINE_STAGE_LABELS,
} from '../services/api';
import { usePipelineProgress } from '../hooks/usePipelineProgress';
import { useLockToggle } from '../hooks/useLockToggle';
import IdeaStage from '../components/pipeline/stages/IdeaStage';
import ProseStage from '../components/pipeline/stages/ProseStage';
import NounsStage from '../components/pipeline/stages/NounsStage';
import ComicScriptStage from '../components/pipeline/stages/ComicScriptStage';
import TeleplayStage from '../components/pipeline/stages/TeleplayStage';
import ComicPagesStage from '../components/pipeline/stages/ComicPagesStage';
import StoryboardsStage from '../components/pipeline/stages/StoryboardsStage';
import EpisodeVideoStage from '../components/pipeline/stages/EpisodeVideoStage';
import AudioStage from '../components/pipeline/stages/AudioStage';
import IssueJudgePanel from '../components/pipeline/IssueJudgePanel';
import SeriesLlmPicker from '../components/pipeline/SeriesLlmPicker';
import LengthProfilePicker from '../components/pipeline/LengthProfilePicker';
import CatalogCastPanel from '../components/CatalogCastPanel';
import { VisualGenSettingsPanel } from '../components/pipeline/stages/VisualGenSettings';

// Stages that surface a header-level settings gear. The Comic editor
// (`comicScript`) owns its own image-gen drawer inside ComicScriptStage,
// so it stays off this list — only Storyboards needs the shared modal.
const VISUAL_STAGE_LABELS = {
  storyboards: 'Storyboards',
};

const STAGE_ICONS = {
  idea: Lightbulb,
  prose: BookOpen,
  nouns: Users,
  comicScript: FileText,
  teleplay: FilmIcon,
  comicPages: LayoutGrid,
  storyboards: ImageIcon,
  episodeVideo: Clapperboard,
  audio: Mic,
};

const STAGE_COMPONENTS = {
  idea: IdeaStage,
  prose: ProseStage,
  nouns: NounsStage,
  comicScript: ComicScriptStage,
  teleplay: TeleplayStage,
  comicPages: ComicPagesStage,
  storyboards: StoryboardsStage,
  episodeVideo: EpisodeVideoStage,
  audio: AudioStage,
};

const STATUS_DOT = {
  empty: 'bg-gray-700',
  generating: 'bg-port-accent animate-pulse',
  ready: 'bg-port-success',
  edited: 'bg-port-warning',
  'needs-review': 'bg-port-warning',
  error: 'bg-port-error',
};

const lockStageIdsForTab = (id) => {
  if (id === 'nouns') return [];
  if (id === 'comicScript') return ['comicScript', 'comicPages'];
  return [id];
};

export default function PipelineIssue() {
  const { issueId, stage: stageParam } = useParams();
  const navigate = useNavigate();
  // `comicPages` URL still routes (folded into the Comic Script tab below);
  // we redirect those to `comicScript` since the merged editor lives there.
  const requested = PIPELINE_STAGES.includes(stageParam) ? stageParam : 'idea';
  const stageId = requested === 'comicPages' ? 'comicScript' : requested;

  const [issue, setIssue] = useState(null);
  const [series, setSeries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [autoRunStarting, setAutoRunStarting] = useState(false);
  const [autoRunActive, setAutoRunActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lengthProfileSaving, setLengthProfileSaving] = useState(false);
  const [genConfigSaving, setGenConfigSaving] = useState(false);
  // Close the settings modal whenever the active stage changes so it doesn't
  // reopen unexpectedly when the user returns to a previously-visited stage.
  useEffect(() => { setSettingsOpen(false); }, [stageId]);
  const { latest, frames } = usePipelineProgress(pipelineAutoRunSseUrl, [issueId], { enabled: autoRunActive });

  useEffect(() => {
    let canceled = false;
    getPipelineIssue(issueId)
      .then((iss) => {
        if (canceled) return iss;
        setIssue(iss);
        return getPipelineSeries(iss.seriesId, { silent: true });
      })
      .then((s) => { if (!canceled && s) setSeries(s); })
      .catch((err) => {
        if (canceled) return;
        toast.error(err.message || 'Failed to load issue');
        navigate('/pipeline');
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [issueId, navigate]);

  // When auto-run reports a completed stage, refresh the issue so the panels
  // re-render with the freshly-persisted output. Cheaper than re-fetching on
  // every frame.
  useEffect(() => {
    if (!latest) return;
    if (latest.type === 'stage:complete' || latest.type === 'complete' || latest.type === 'error' || latest.type === 'canceled') {
      getPipelineIssue(issueId).then(setIssue).catch(() => null);
    }
    if (latest.type === 'complete' || latest.type === 'canceled' || latest.type === 'error') {
      setAutoRunActive(false);
    }
  }, [latest, issueId]);

  const handleAutoRun = async (opts = {}) => {
    setAutoRunStarting(true);
    const res = await startPipelineAutoRunText(issueId, {
      providerId: series?.llm?.provider || undefined,
      model: series?.llm?.model || undefined,
      ...opts,
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to start auto-run');
      return null;
    });
    setAutoRunStarting(false);
    if (!res) return;
    setAutoRunActive(true);
    toast.success(res.alreadyRunning
      ? 'Auto-run already in progress'
      : (opts.includeVideo ? 'Auto-run started (with video)' : 'Auto-run started'));
  };

  const handleCancelAutoRun = async () => {
    await cancelPipelineAutoRunText(issueId, { silent: true }).catch((err) => {
      toast.error(err.message || 'Cancel failed');
    });
  };

  // Persist length-profile changes from the header picker. The patch is a
  // flat issue-level patch (no `stages.*` envelope) so the issue sanitizer
  // routes lengthProfile / pageTarget / minutesTarget straight onto the record.
  const handleLengthChange = async (patch) => {
    setLengthProfileSaving(true);
    updatePipelineIssue(issueId, patch, { silent: true })
      .then((updated) => { if (updated) setIssue(updated); })
      .catch((err) => { toast.error(err.message || 'Save failed'); })
      .finally(() => setLengthProfileSaving(false));
  };

  // Persist genConfig changes from the header settings modal. The active
  // visual stage owns the config record (we keep per-stage genConfig so a
  // user can pin "codex" for comicPages but "local" for storyboards).
  const handleGenConfigChange = async (next) => {
    setGenConfigSaving(true);
    const updated = await updatePipelineIssue(issueId, {
      stages: { [stageId]: { genConfig: next } },
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    }).finally(() => setGenConfigSaving(false));
    if (updated) setIssue(updated);
  };

  const activeLockStageIds = useMemo(() => lockStageIdsForTab(stageId), [stageId]);
  const activeStageLocked = activeLockStageIds.some((id) => issue?.stages?.[id]?.locked === true);
  const canLockActiveStage = activeLockStageIds.length > 0;

  // Toggle the per-stage lock for the currently-active tab. Routes through
  // the generic issue PATCH path so the issue sanitizer + write queue handle
  // the merge; the server enforces the lock semantics at the regenerate
  // boundary (textStages.generateStage, visualStages.enqueueXxx, etc.).
  // The merged Comic tab owns both text (`comicScript`) and render/page
  // artifacts (`comicPages`), so it toggles both persisted stages together.
  const { busy: stageLockSaving, toggle: toggleStageLock } = useLockToggle({
    patchFn: (next) => {
      const stages = Object.fromEntries(activeLockStageIds.map((id) => [id, { locked: next }]));
      return updatePipelineIssue(issueId, { stages }, { silent: true });
    },
    onSuccess: (updated) => setIssue(updated),
    lockedMessage: `${PIPELINE_STAGE_LABELS[stageId]} locked — regeneration is now blocked`,
    unlockedMessage: `${PIPELINE_STAGE_LABELS[stageId]} unlocked`,
    errorMessage: `${PIPELINE_STAGE_LABELS[stageId]} lock update failed`,
  });
  const handleStageLockToggle = () => {
    if (!issue || !canLockActiveStage) return;
    toggleStageLock(activeStageLocked);
  };

  const handleStageUpdate = (id, updatedStage, updatedIssue) => {
    if (updatedIssue) {
      setIssue(updatedIssue);
      return;
    }
    setIssue((prev) => prev ? ({
      ...prev,
      stages: { ...prev.stages, [id]: updatedStage },
    }) : prev);
  };

  // Surface parent-season + arc lock state on the strip — generation actions
  // routed through generateSeasonEpisodes / arc-resolve are gated on these
  // server-side, so the user sees WHY the buttons inside each stage panel
  // refuse to fire. The lock indicator replaces the status dot when locked
  // because lock > status (a locked stage's status is frozen by definition).
  // Per-stage locks (issue.stages.{id}.locked) layer on top — they refuse
  // regeneration of one stage while sibling stages remain runnable. The
  // pill trailing element prefers per-stage lock first, then the arc/season-
  // wide lock, then the status dot.
  const parentSeason = useMemo(() => {
    if (!series?.seasons || !issue?.seasonId) return null;
    return series.seasons.find((s) => s.id === issue.seasonId) || null;
  }, [series?.seasons, issue?.seasonId]);
  const seasonLocked = parentSeason?.locked === true;
  const arcLocked = series?.locked?.arc === true;
  const ambientLockHint = seasonLocked
    ? `Volume ${parentSeason.number || ''} is locked — unlock it on the Arc Canvas to enable regeneration`
    : arcLocked
      ? 'Arc is locked — unlock it on the Arc Canvas to enable regeneration'
      : null;

  const stageTabs = useMemo(() => PIPELINE_TAB_STAGES
    // Audio is only meaningful when the series ships video — comic-only
    // series don't render dialogue as sound, so the tab is hidden to keep
    // the strip uncluttered. Showing the audio data still works for users
    // who navigate to `/pipeline/issues/:id/audio` directly.
    .filter((id) => id !== 'audio' || series?.targetFormat !== 'comic')
    .map((id) => {
      const status = issue?.stages?.[id]?.status || 'empty';
      const tabLockStageIds = lockStageIdsForTab(id);
      const stageLocked = tabLockStageIds.some((lockId) => issue?.stages?.[lockId]?.locked === true);
      const tabLockHint = stageLocked
        ? `${PIPELINE_STAGE_LABELS[id]} stage is locked — unlock it to regenerate`
        : ambientLockHint;
      const trailing = tabLockHint
        ? <Lock size={11} className="text-port-warning" aria-label={tabLockHint} />
        : <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] || STATUS_DOT.empty}`} aria-hidden="true" />;
      return {
        id,
        label: PIPELINE_STAGE_LABELS[id],
        icon: STAGE_ICONS[id],
        trailing,
      };
    }), [issue, series?.targetFormat, ambientLockHint]);

  // Active-tab specific banner: prefer per-stage lock when the current tab is
  // locked, fall back to the arc/season-wide message otherwise.
  const lockHint = activeStageLocked
    ? `${PIPELINE_STAGE_LABELS[stageId]} stage is locked — unlock it to regenerate`
    : ambientLockHint;

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading issue…</div>;
  if (!issue) return null;

  const StageComponent = STAGE_COMPONENTS[stageId];
  const isVisualStage = stageId in VISUAL_STAGE_LABELS;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 md:p-6 border-b border-port-border space-y-3">
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <Link to="/pipeline" className="text-gray-400 hover:text-white inline-flex items-center gap-1">
            <ArrowLeft size={14} /> All Series
          </Link>
          {series ? (
            <>
              <span className="text-gray-600">/</span>
              <Link to={`/pipeline/series/${series.id}`} className="text-gray-400 hover:text-white truncate max-w-[200px]">
                {series.name}
              </Link>
            </>
          ) : null}
          <span className="text-gray-600">/</span>
          <span className="text-white truncate">#{issue.number} {issue.title}</span>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-xl font-bold text-white truncate">#{issue.number} — {issue.title}</h1>
          <div className="flex items-center gap-2 flex-wrap">
            <LengthProfilePicker
              issue={issue}
              onChange={handleLengthChange}
              disabled={autoRunStarting || autoRunActive || lengthProfileSaving}
            />
            {series ? (
              <SeriesLlmPicker
                series={series}
                onSeriesUpdate={setSeries}
                disabled={autoRunStarting || autoRunActive}
              />
            ) : null}
            {autoRunActive && (
              <button
                type="button"
                onClick={handleCancelAutoRun}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-port-card border border-port-border text-port-error text-sm"
              >
                <X size={14} /> Cancel auto-run
              </button>
            )}
            <button
              type="button"
              onClick={() => handleAutoRun({})}
              disabled={autoRunStarting || autoRunActive || lengthProfileSaving || genConfigSaving}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
              title={lengthProfileSaving ? 'Saving length profile…' : genConfigSaving ? 'Saving visual settings…' : 'Run idea → prose → (comic script + teleplay) end to end'}
            >
              {autoRunStarting || autoRunActive ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Auto-run text
            </button>
            <button
              type="button"
              onClick={() => handleAutoRun({ includeVideo: true })}
              disabled={autoRunStarting || autoRunActive || lengthProfileSaving || genConfigSaving}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-accent/40 text-white text-sm font-medium disabled:opacity-50 hover:bg-port-accent/10"
              title={lengthProfileSaving ? 'Saving length profile…' : genConfigSaving ? 'Saving visual settings…' : 'Run text stages and then kick off episode video via Creative Director (burns GPU)'}
            >
              {autoRunStarting || autoRunActive ? <Loader2 size={14} className="animate-spin" /> : <Clapperboard size={14} />}
              Run everything (incl. video)
            </button>
            {isVisualStage && (
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="inline-flex items-center justify-center p-2 rounded-lg bg-port-card border border-port-border text-gray-300 hover:text-white hover:border-port-accent/50"
                title={`${VISUAL_STAGE_LABELS[stageId]} generation settings`}
                aria-label={`${VISUAL_STAGE_LABELS[stageId]} generation settings`}
              >
                <Settings size={16} />
              </button>
            )}
            {canLockActiveStage ? (
              <button
                type="button"
                onClick={handleStageLockToggle}
                disabled={stageLockSaving || autoRunStarting || autoRunActive}
                aria-pressed={activeStageLocked}
                title={activeStageLocked
                  ? `Unlock ${PIPELINE_STAGE_LABELS[stageId]} — allows regeneration again`
                  : `Lock ${PIPELINE_STAGE_LABELS[stageId]} — blocks regeneration of this stage; siblings stay runnable`}
                aria-label={activeStageLocked ? `Unlock ${PIPELINE_STAGE_LABELS[stageId]}` : `Lock ${PIPELINE_STAGE_LABELS[stageId]}`}
                className={`inline-flex items-center justify-center p-2 rounded-lg border text-sm transition-colors disabled:opacity-40 ${
                  activeStageLocked
                    ? 'bg-port-warning/10 text-port-warning border-port-warning/40 hover:bg-port-warning/20'
                    : 'bg-port-card text-gray-300 border-port-border hover:text-white hover:border-port-accent/40'
                }`}
              >
                {stageLockSaving
                  ? <Loader2 size={16} className="animate-spin" />
                  : (activeStageLocked ? <Lock size={16} /> : <Unlock size={16} />)}
              </button>
            ) : null}
          </div>
        </div>

        {autoRunActive && latest ? (
          <div className="text-xs text-gray-400">
            {latest.type === 'stage:start' && <>Generating <span className="text-white">{PIPELINE_STAGE_LABELS[latest.stage]}</span>…</>}
            {latest.type === 'stage:complete' && latest.stage === 'episodeVideo' && <>{PIPELINE_STAGE_LABELS[latest.stage]} kicked off — {latest.scenes} scene{latest.scenes === 1 ? '' : 's'} queued in Creative Director</>}
            {latest.type === 'stage:complete' && latest.stage !== 'episodeVideo' && <>{PIPELINE_STAGE_LABELS[latest.stage]} ready ({latest.length} chars)</>}
            {latest.type === 'stage:error' && <>{PIPELINE_STAGE_LABELS[latest.stage]} error — {latest.error}</>}
            {latest.type === 'skip' && <>{PIPELINE_STAGE_LABELS[latest.stage]} skipped — {latest.reason}</>}
            {latest.type === 'start' && <>Starting auto-run…</>}
          </div>
        ) : null}
      </div>

      {/* Stage tabs */}
      <TabPills
        tabs={stageTabs}
        activeTab={stageId}
        onChange={(id) => navigate(`/pipeline/issues/${issueId}/${id}`)}
        ariaLabel="Pipeline stages"
      />

      {lockHint ? (
        <div className="px-4 md:px-6 py-1.5 border-b border-port-border bg-port-warning/5 text-xs text-port-warning flex items-center gap-1.5">
          <Lock size={11} /> {lockHint}.
        </div>
      ) : null}

      {/* Active stage panel */}
      <div className="flex-1 overflow-auto p-4 md:p-6 space-y-4">
        <CatalogCastPanel
          refKind="issue"
          refId={issue.id}
          refLabel={issue.title ? `#${issue.number} ${issue.title}` : `issue #${issue.number}`}
        />
        {StageComponent ? (
          <StageComponent
            issue={issue}
            series={series}
            onStageUpdate={handleStageUpdate}
            onSeriesUpdate={setSeries}
            actionsGated={lengthProfileSaving || genConfigSaving}
          />
        ) : (
          <div className="text-gray-500 text-sm">Unknown stage.</div>
        )}
        {/* Calibrated quality judge (#2167) — qualityScore = judge − slop. Renders
            only for text stages with drafted content (the panel self-gates). */}
        {['prose', 'comicScript', 'teleplay'].includes(stageId) ? (
          <IssueJudgePanel issue={issue} stageId={stageId} />
        ) : null}
        {/* Frames log for debugging during auto-run — collapsed but available. */}
        {frames.length > 0 ? (
          <details className="mt-6 text-xs text-gray-600">
            <summary className="cursor-pointer text-gray-500">Auto-run frames ({frames.length})</summary>
            <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded overflow-auto max-h-64">{frames.map((f) => JSON.stringify(f)).join('\n')}</pre>
          </details>
        ) : null}
      </div>

      {/* Per-stage generation settings — only available on visual stages. */}
      {isVisualStage && (
        <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} size="lg" ariaLabel="Generation settings">
          <div className="bg-port-card border border-port-border rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">
                {VISUAL_STAGE_LABELS[stageId]} — Generation settings
              </h2>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="p-1 text-gray-400 hover:text-white"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <VisualGenSettingsPanel
              value={issue.stages?.[stageId]?.genConfig || null}
              onChange={handleGenConfigChange}
              stageLabel={VISUAL_STAGE_LABELS[stageId]}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
