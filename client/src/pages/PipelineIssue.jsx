/**
 * Pipeline Issue — the actual production page.
 *
 * Tab-driven stage navigation per /pipeline/issues/:issueId/:stage. Top action
 * bar exposes the auto-run-text button which kicks off idea→prose→(comicScript
 * + tvScript) and streams progress via SSE.
 */

import { useEffect, useState, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Sparkles, Loader2, X, Lightbulb, BookOpen, FileText, Film as FilmIcon,
  LayoutGrid, Image as ImageIcon, Clapperboard,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getPipelineIssue, getPipelineSeries,
  startPipelineAutoRunText, cancelPipelineAutoRunText,
  PIPELINE_STAGES, PIPELINE_STAGE_LABELS,
} from '../services/api';
import { usePipelineAutoRunProgress } from '../hooks/usePipelineAutoRunProgress';
import IdeaStage from '../components/pipeline/stages/IdeaStage';
import ProseStage from '../components/pipeline/stages/ProseStage';
import ComicScriptStage from '../components/pipeline/stages/ComicScriptStage';
import TVScriptStage from '../components/pipeline/stages/TVScriptStage';
import ComicPagesStage from '../components/pipeline/stages/ComicPagesStage';
import StoryboardsStage from '../components/pipeline/stages/StoryboardsStage';
import EpisodeVideoStage from '../components/pipeline/stages/EpisodeVideoStage';

const STAGE_ICONS = {
  idea: Lightbulb,
  prose: BookOpen,
  comicScript: FileText,
  tvScript: FilmIcon,
  comicPages: LayoutGrid,
  storyboards: ImageIcon,
  episodeVideo: Clapperboard,
};

const STAGE_COMPONENTS = {
  idea: IdeaStage,
  prose: ProseStage,
  comicScript: ComicScriptStage,
  tvScript: TVScriptStage,
  comicPages: ComicPagesStage,
  storyboards: StoryboardsStage,
  episodeVideo: EpisodeVideoStage,
};

const STATUS_DOT = {
  empty: 'bg-gray-700',
  generating: 'bg-port-accent animate-pulse',
  ready: 'bg-port-success',
  edited: 'bg-port-warning',
  'needs-review': 'bg-port-warning',
  error: 'bg-port-error',
};

export default function PipelineIssue() {
  const { issueId, stage: stageParam } = useParams();
  const navigate = useNavigate();
  const stageId = PIPELINE_STAGES.includes(stageParam) ? stageParam : 'idea';

  const [issue, setIssue] = useState(null);
  const [series, setSeries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [autoRunStarting, setAutoRunStarting] = useState(false);
  const [autoRunActive, setAutoRunActive] = useState(false);
  const { latest, frames } = usePipelineAutoRunProgress(issueId, { enabled: autoRunActive });

  useEffect(() => {
    let canceled = false;
    getPipelineIssue(issueId)
      .then((iss) => {
        if (canceled) return iss;
        setIssue(iss);
        return getPipelineSeries(iss.seriesId);
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
    const res = await startPipelineAutoRunText(issueId, opts).catch((err) => {
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
    await cancelPipelineAutoRunText(issueId).catch((err) => {
      toast.error(err.message || 'Cancel failed');
    });
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

  const stageTabs = useMemo(() => PIPELINE_STAGES.map((id) => ({
    id,
    label: PIPELINE_STAGE_LABELS[id],
    Icon: STAGE_ICONS[id],
    status: issue?.stages?.[id]?.status || 'empty',
  })), [issue]);

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading issue…</div>;
  if (!issue) return null;

  const StageComponent = STAGE_COMPONENTS[stageId];

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
          <div className="flex items-center gap-2">
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
              disabled={autoRunStarting || autoRunActive}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
              title="Run idea → prose → (comic script + TV script) end to end"
            >
              {autoRunStarting || autoRunActive ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Auto-run text
            </button>
            <button
              type="button"
              onClick={() => handleAutoRun({ includeVideo: true })}
              disabled={autoRunStarting || autoRunActive}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-accent/40 text-white text-sm font-medium disabled:opacity-50 hover:bg-port-accent/10"
              title="Run text stages and then kick off episode video via Creative Director (burns GPU)"
            >
              {autoRunStarting || autoRunActive ? <Loader2 size={14} className="animate-spin" /> : <Clapperboard size={14} />}
              Run everything (incl. video)
            </button>
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
      <div className="flex border-b border-port-border overflow-x-auto" role="tablist">
        {stageTabs.map(({ id, label, Icon, status }) => {
          const isActive = id === stageId;
          return (
            <button
              key={id}
              onClick={() => navigate(`/pipeline/issues/${issueId}/${id}`)}
              role="tab"
              aria-selected={isActive}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? 'text-port-accent border-b-2 border-port-accent bg-port-accent/5'
                  : 'text-gray-400 hover:text-white hover:bg-port-card'
              }`}
            >
              <Icon size={14} aria-hidden="true" />
              {label}
              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] || STATUS_DOT.empty}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      {/* Active stage panel */}
      <div className="flex-1 overflow-auto p-4 md:p-6">
        {StageComponent ? (
          <StageComponent issue={issue} series={series} onStageUpdate={handleStageUpdate} onSeriesUpdate={setSeries} />
        ) : (
          <div className="text-gray-500 text-sm">Unknown stage.</div>
        )}
        {/* Frames log for debugging during auto-run — collapsed but available. */}
        {frames.length > 0 ? (
          <details className="mt-6 text-xs text-gray-600">
            <summary className="cursor-pointer text-gray-500">Auto-run frames ({frames.length})</summary>
            <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded overflow-auto max-h-64">{frames.map((f) => JSON.stringify(f)).join('\n')}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
