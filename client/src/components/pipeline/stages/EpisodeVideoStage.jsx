import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Film, ExternalLink, Loader2, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
import toast from '../../ui/Toast';
import { generatePipelineVisualImage } from '../../../services/api';
import { getCreativeDirectorProject } from '../../../services/apiCreativeDirector';

const POLL_INTERVAL_MS = 4000;

const isTerminalProjectStatus = (s) => s === 'complete' || s === 'failed';

const STATUS_LABEL = {
  draft: 'Preparing',
  planning: 'Planning',
  rendering: 'Rendering',
  stitching: 'Stitching final cut',
  complete: 'Complete',
  paused: 'Paused',
  failed: 'Failed',
};

function sceneStatusBadge(status) {
  if (status === 'accepted') return { text: 'done', cls: 'bg-port-success/20 text-port-success' };
  if (status === 'rendering') return { text: 'rendering', cls: 'bg-port-accent/20 text-port-accent' };
  if (status === 'evaluating') return { text: 'checking', cls: 'bg-port-warning/20 text-port-warning' };
  if (status === 'failed') return { text: 'failed', cls: 'bg-port-error/20 text-port-error' };
  return { text: 'pending', cls: 'bg-port-border text-gray-400' };
}

export default function EpisodeVideoStage({ issue, onStageUpdate }) {
  const stage = issue.stages?.episodeVideo || {};
  const cdProjectId = stage.cdProjectId || null;
  const storyboardScenes = issue.stages?.storyboards?.scenes || [];
  const usableScenes = storyboardScenes.filter((s) => (s?.description || '').trim().length > 0);

  const [cdProject, setCdProject] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
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

  const submit = async ({ force }) => {
    if (!force && !usableScenes.length) {
      toast.error('Add storyboard scenes with descriptions first');
      return;
    }
    setConfirmRestart(false);
    if (force) setCdProject(null);
    setSubmitting(true);
    const result = await generatePipelineVisualImage(issue.id, 'episodeVideo', force ? { force: true } : {}).catch((err) => {
      toast.error(err.message || (force ? 'Failed to restart episode render' : 'Failed to start episode render'));
      return null;
    });
    setSubmitting(false);
    if (!result) return;
    if (force) {
      toast.success(`Restarted: ${result.cdProjectId.slice(0, 8)}`);
    } else if (result.reused) {
      toast.success(`Reusing in-flight CD project ${result.cdProjectId.slice(0, 8)}`);
    } else {
      toast.success(`Queued ${result.scenes} scene${result.scenes === 1 ? '' : 's'}`);
    }
    onStageUpdate?.('episodeVideo', {
      ...stage,
      status: 'generating',
      cdProjectId: result.cdProjectId,
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
        ) : confirmRestart ? (
          <div className="inline-flex items-center gap-2">
            <span className="text-xs text-port-warning">Start a new CD project?</span>
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
                  const badge = sceneStatusBadge(s.status);
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
              <video
                src={`/data/videos/${finalVideoId}.mp4`}
                poster={`/data/video-thumbnails/${finalVideoId}.jpg`}
                controls
                preload="metadata"
                playsInline
                className="w-full rounded-lg bg-port-bg"
              />
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span className="font-mono">final {finalVideoId.slice(0, 8)}</span>
                <a
                  href={`/data/videos/${finalVideoId}.mp4`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-port-accent hover:underline inline-flex items-center gap-1"
                >
                  Open <ExternalLink size={10} />
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
