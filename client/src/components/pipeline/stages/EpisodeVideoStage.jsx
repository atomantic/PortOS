import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Film, ExternalLink, Loader2, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
import toast from '../../ui/Toast';
import { generatePipelineVisualImage } from '../../../services/api';
import { getCreativeDirectorProject } from '../../../services/apiCreativeDirector';
import { getSceneStatusBadge, PROJECT_STATUS_LABEL } from '../../creative-director/sceneStatus';
import ScenePreview from '../../creative-director/ScenePreview';
import { useAsyncAction } from '../../../hooks/useAsyncAction';

const POLL_INTERVAL_MS = 4000;

const isTerminalProjectStatus = (s) => s === 'complete' || s === 'failed';

// Extra labels EpisodeVideoStage uses beyond the shared scene-status map —
// these are CD project statuses specific to the long-form pipeline (planning,
// stitching, paused). Fall through to PROJECT_STATUS_LABEL for the shared ones.
const STATUS_LABEL = {
  ...PROJECT_STATUS_LABEL,
  planning: 'Planning',
  stitching: 'Stitching final cut',
  paused: 'Paused',
};

export default function EpisodeVideoStage({ issue, series, onStageUpdate }) {
  const stage = issue.stages?.episodeVideo || {};
  const cdProjectId = stage.cdProjectId || null;
  const storyboardScenes = issue.stages?.storyboards?.scenes || [];
  const usableScenes = storyboardScenes.filter((s) => (s?.description || '').trim().length > 0);

  const [cdProject, setCdProject] = useState(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  // Initialize from the persisted stage values so a page reload (or a fresh
  // tab) doesn't lose the user's previous picks. Falls through to defaults
  // for an unstarted episodeVideo stage.
  const [aspectRatio, setAspectRatio] = useState(stage.aspectRatio || '16:9');
  const [quality, setQuality] = useState(stage.quality || 'standard');
  const intervalRef = useRef(null);

  // Single polling effect keyed only on cdProjectId so a status flip doesn't
  // tear down and rebuild the interval (each tear-down fired an immediate
  // fetch → setState → effect re-run, producing a fetch storm at every
  // transition). The interval clears itself once status becomes terminal.
  useEffect(() => {
    if (!cdProjectId) {
      setCdProject(null);
      return undefined;
    }
    let cancelled = false;
    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    const fetchOnce = async () => {
      if (document.hidden) return;
      const p = await getCreativeDirectorProject(cdProjectId, { slim: true }).catch((err) => {
        if (!cancelled) console.log(`pipeline:episode poll error ${err.message}`);
        return null;
      });
      if (cancelled || !p) return;
      // Skip the setState (and downstream re-render + scene re-sort) when the
      // poll returns the same monotonic snapshot we already hold.
      setCdProject((prev) => (
        prev && prev.updatedAt === p.updatedAt && prev.status === p.status ? prev : p
      ));
      if (isTerminalProjectStatus(p.status)) stop();
    };
    fetchOnce();
    intervalRef.current = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [cdProjectId]);

  const [runSubmit, submitting] = useAsyncAction(
    async ({ force }) => {
      const payload = { aspectRatio, quality };
      if (force) payload.force = true;
      return generatePipelineVisualImage(issue.id, 'episodeVideo', payload).catch((err) => {
        // Re-throw with a force-aware fallback so useAsyncAction's toaster
        // surfaces the right verb (start vs restart) if the server didn't
        // include a message.
        throw new Error(err.message || (force ? 'Failed to restart episode render' : 'Failed to start episode render'));
      });
    },
  );

  const submit = async ({ force }) => {
    if (!force && !usableScenes.length) {
      toast.error('Add storyboard scenes with descriptions first');
      return;
    }
    setConfirmRestart(false);
    const result = await runSubmit({ force });
    if (!result) return;
    if (force) {
      // Only clear the prior project view AFTER the restart kickoff succeeds.
      // Clearing pre-flight (which we used to do) meant a failed restart
      // tore the in-flight progress UI off the page even though the
      // previous CD project was still rendering.
      setCdProject(null);
      toast.success(`Restarted: ${result.cdProjectId?.slice(0, 8) ?? '?'}`);
    } else if (result.reused) {
      toast.success(`Reusing in-flight CD project ${result.cdProjectId?.slice(0, 8) ?? '?'}`);
    } else {
      toast.success(`Queued ${result.scenes} scene${result.scenes === 1 ? '' : 's'}`);
    }
    onStageUpdate?.('episodeVideo', {
      ...stage,
      status: 'generating',
      cdProjectId: result.cdProjectId,
      // Mirror the server's persisted render settings on the client-side
      // issue model so a same-session navigate-away-and-back doesn't reset
      // the restart pickers to defaults before a full refetch lands.
      aspectRatio,
      quality,
    });
  };

  const sortedScenes = useMemo(
    () => [...(cdProject?.treatment?.scenes || [])].sort((a, b) => a.order - b.order),
    [cdProject?.treatment?.scenes],
  );
  const accepted = sortedScenes.filter((s) => s.status === 'accepted').length;
  const total = sortedScenes.length;
  const finalVideoId = cdProject?.finalVideoId || null;
  const isComplete = cdProject?.status === 'complete' && finalVideoId;
  const isFailed = cdProject?.status === 'failed';
  const polling = cdProject && !isTerminalProjectStatus(cdProject.status);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Film className="w-5 h-5 text-port-accent" />
          <div>
            <h2 className="text-lg font-semibold text-white">Episode Video</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Renders each storyboard scene as a video clip, then stitches them into a final episode.
            </p>
          </div>
        </div>
        {!cdProjectId ? (
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value)}
              disabled={submitting}
              aria-label="Aspect ratio"
              title="Aspect ratio for the rendered scenes"
              className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-300"
            >
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
            </select>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              disabled={submitting}
              aria-label="Render quality"
              title="Render quality — higher = slower + more GPU time"
              className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-300"
            >
              <option value="draft">draft</option>
              <option value="standard">standard</option>
              <option value="high">high</option>
            </select>
            <button
              type="button"
              onClick={() => submit({ force: false })}
              disabled={submitting || !usableScenes.length}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm disabled:opacity-50"
              title={!usableScenes.length ? 'Add storyboard scenes with descriptions first' : ''}
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Generate Episode ({usableScenes.length} scene{usableScenes.length === 1 ? '' : 's'})
            </button>
          </div>
        ) : confirmRestart ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-port-warning">Start a new CD project?</span>
            <select
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value)}
              disabled={submitting}
              aria-label="Aspect ratio"
              className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-300"
            >
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
            </select>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              disabled={submitting}
              aria-label="Render quality"
              className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-300"
            >
              <option value="draft">draft</option>
              <option value="standard">standard</option>
              <option value="high">high</option>
            </select>
            <button
              type="button"
              onClick={() => submit({ force: true })}
              disabled={submitting}
              className="px-2 py-1 rounded bg-port-error text-white text-xs disabled:opacity-50"
            >
              {submitting ? <Loader2 size={12} className="animate-spin" /> : 'Yes, restart'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmRestart(false)}
              className="px-2 py-1 rounded bg-port-card border border-port-border text-white text-xs"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRestart(true)}
            disabled={submitting}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-50"
          >
            <Sparkles size={14} />
            Restart
          </button>
        )}
      </div>

      {!cdProjectId ? (
        <div className="p-4 bg-port-card border border-port-border rounded-lg space-y-2">
          {usableScenes.length === 0 ? (
            <p className="text-sm text-gray-400 flex items-center gap-2">
              <AlertCircle size={14} className="text-port-warning" />
              No storyboard scenes with descriptions yet. Fill in the Storyboards stage first.
            </p>
          ) : (
            <p className="text-sm text-gray-300">
              Ready to render {usableScenes.length} scene{usableScenes.length === 1 ? '' : 's'}. Each one becomes a short video clip; the first is text-to-video and every subsequent scene chains from the prior scene's last frame for visual continuity. Audio is disabled and scenes are auto-accepted (no LLM evaluator round-trip).
            </p>
          )}
        </div>
      ) : (
        <div className="p-4 bg-port-card border border-port-border rounded-lg space-y-3">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              {isComplete ? (
                <CheckCircle2 size={16} className="text-port-success" />
              ) : isFailed ? (
                <AlertCircle size={16} className="text-port-error" />
              ) : (
                <Loader2 size={16} className={polling ? 'animate-spin text-port-accent' : 'text-gray-500'} />
              )}
              <span className="text-white">
                {STATUS_LABEL[cdProject?.status || 'draft'] || cdProject?.status || 'Preparing'}
              </span>
              {total > 0 && (
                <span className="text-xs text-gray-500">— {accepted}/{total} scenes</span>
              )}
            </div>
            <Link
              to={`/media/creative-director/${cdProjectId}`}
              className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline"
            >
              Open in Creative Director <ExternalLink size={11} />
            </Link>
          </div>

          {isFailed && cdProject?.failureReason && (
            <p className="text-xs text-port-error bg-port-error/10 border border-port-error/30 rounded p-2">
              {cdProject.failureReason}
            </p>
          )}

          {total > 0 && (
            <div className="space-y-1">
              <div className="h-1.5 w-full bg-port-bg rounded-full overflow-hidden">
                <div
                  className="h-full bg-port-accent transition-all"
                  style={{ width: `${total ? (accepted / total) * 100 : 0}%` }}
                />
              </div>
              <ul className="flex flex-wrap gap-1.5 pt-1">
                {sortedScenes.map((s) => {
                  const badge = getSceneStatusBadge(s.status);
                  return (
                    <li
                      key={s.sceneId}
                      className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${badge.cls}`}
                      title={s.intent || s.sceneId}
                    >
                      #{s.order + 1} {badge.text}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {isComplete && finalVideoId && (
            <div className="space-y-2 pt-1">
              <ScenePreview jobId={finalVideoId} label="Final episode video" />
              <div className="text-xs text-gray-500">
                <span className="font-mono">final {finalVideoId.slice(0, 8)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
