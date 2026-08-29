/**
 * FableLoom editor — the full-bleed visual workspace for one loom.
 *
 * URL is the source of truth: /fableloom/:loomId/plan is the series workspace;
 * /fableloom/:loomId/:episodeId selects an episode, /outline switches that
 * episode to its text outline, and /:nodeId selects a scene in the graph. The
 * play drawer rides ?play=1.
 * Left: the scene-graph canvas (stacks top-to-bottom under the `lg` rail
 * breakpoint). Right rail: the selected scene's editor, or the
 * structure/review panel when nothing is selected. On small screens the
 * rail sits under the canvas and is height-capped so the graph stays the
 * thing you scroll.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, BookOpenText, ListTree, Loader2, Plus, Settings, Sparkles, Trash2, Waypoints, Workflow as WorkflowIcon } from 'lucide-react';
import toast from '../components/ui/Toast';
import Drawer from '../components/Drawer';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { FormField } from '../components/ui/FormField.jsx';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import useContainerWidth from '../hooks/useContainerWidth';
import LoomCanvas from '../components/fableloom/LoomCanvas';
import LoomEpisodeOutline from '../components/fableloom/LoomEpisodeOutline';
import LoomEpisodeFeedback from '../components/fableloom/LoomEpisodeFeedback';
import LoomMediaJobWatchers from '../components/fableloom/LoomMediaJobWatchers';
import LoomNodeEditor from '../components/fableloom/LoomNodeEditor';
import LoomPlayPanel from '../components/fableloom/LoomPlayPanel';
import LoomSettingsDrawer from '../components/fableloom/LoomSettingsDrawer';
import LoomSeriesPlan from '../components/fableloom/LoomSeriesPlan';
import LoomValidationPanel from '../components/fableloom/LoomValidationPanel';
import { fieldClass, labelClass } from '../components/fableloom/fieldStyles';
import {
  buildFableLoomImageRequest, buildFableLoomVideoRequest,
} from '../components/fableloom/sceneMediaRequests';
import { universeStylePreset } from '../lib/universeStylePreset';
import { LOOM_ORIENTATION, LOOM_STACK_WIDTH } from '../lib/loomLayout';
import {
  addLoomEpisode, addLoomNode, deleteLoomEpisode, generateImage, generateVideo,
  getLoom, getPipelineSeries, getUniverse, updateLoomEpisode, updateLoomNode,
  weaveLoomEpisode,
} from '../services/api';

const CONTINUITY_FALLBACK_CODES = new Set([
  'IMAGE_EDIT_UNSUPPORTED_MODE',
  'REFERENCE_IMAGE_NOT_FOUND',
  'REFERENCE_IMAGES_FLUX2_ONLY',
]);

export default function FableLoomStory({ view = 'graph' }) {
  const { loomId, episodeId, nodeId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loom, setLoom] = useState(null);
  // The series this loom is soft-linked to, resolved for the header backlink.
  // `seriesId` is a soft ref: deleting the series is allowed and leaves the id
  // dangling, so an unresolvable id renders NO chip rather than a dead link.
  const [linkedSeries, setLinkedSeries] = useState(null);
  const [linkedSeriesStatus, setLinkedSeriesStatus] = useState('idle');
  const [linkedUniverse, setLinkedUniverse] = useState(null);
  const [linkedUniverseStatus, setLinkedUniverseStatus] = useState('idle');
  // nodeId -> { image?: job snapshot, video?: job snapshot }. The page owns
  // this so the graph card and editor rail display one shared lifecycle and the
  // socket hook mounts exactly once per job.
  const [mediaJobs, setMediaJobs] = useState({});
  const [notFound, setNotFound] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const playOpen = searchParams.get('play') === '1';
  const seriesPlanOpen = episodeId === 'plan';
  const outlineOpen = view === 'outline';
  // Orientation keys off the PAGE, not the canvas. The canvas is the leftover
  // after the 380px rail on `lg+`, so measuring it would stack a laptop graph
  // while the rail is still beside it.
  const [pageRef, pageWidth] = useContainerWidth();
  const graphOrientation = pageWidth > 0
    ? (pageWidth < LOOM_STACK_WIDTH ? LOOM_ORIENTATION.TB : LOOM_ORIENTATION.LR)
    : undefined;

  useEffect(() => {
    setNotFound(false);
    setMediaJobs({});
    getLoom(loomId).then(setLoom).catch(() => setNotFound(true));
  }, [loomId]);

  const linkedSeriesId = loom?.seriesId || null;
  useEffect(() => {
    if (!linkedSeriesId) {
      setLinkedSeries(null);
      setLinkedSeriesStatus('idle');
      return undefined;
    }
    let canceled = false;
    setLinkedSeries(null);
    setLinkedSeriesStatus('loading');
    getPipelineSeries(linkedSeriesId, { silent: true })
      .then((series) => {
        if (canceled) return;
        setLinkedSeries(series || null);
        setLinkedSeriesStatus(series ? 'ready' : 'unavailable');
      })
      .catch(() => {
        if (canceled) return;
        setLinkedSeries(null);
        setLinkedSeriesStatus('unavailable');
      });
    return () => { canceled = true; };
  }, [linkedSeriesId]);

  // A loom normally carries universeId directly. The series fallback covers
  // older/hand-linked records whose visual context exists only on the series.
  const linkedUniverseId = loom?.universeId || linkedSeries?.universeId || null;
  useEffect(() => {
    if (!linkedUniverseId) {
      setLinkedUniverse(null);
      setLinkedUniverseStatus('idle');
      return undefined;
    }
    let canceled = false;
    setLinkedUniverse(null);
    setLinkedUniverseStatus('loading');
    getUniverse(linkedUniverseId, { silent: true })
      .then((universe) => {
        if (canceled) return;
        setLinkedUniverse(universe || null);
        setLinkedUniverseStatus(universe ? 'ready' : 'unavailable');
      })
      .catch(() => {
        if (canceled) return;
        setLinkedUniverse(null);
        setLinkedUniverseStatus('unavailable');
      });
    return () => { canceled = true; };
  }, [linkedUniverseId]);

  const seriesStylePending = Boolean(linkedSeriesId)
    && linkedSeriesStatus !== 'ready'
    && linkedSeriesStatus !== 'unavailable';
  const universeStylePending = Boolean(linkedUniverseId)
    && linkedUniverseStatus !== 'ready'
    && linkedUniverseStatus !== 'unavailable';
  const styleContextLoading = seriesStylePending || universeStylePending;
  const styleContextUnavailable = Boolean(linkedUniverseId) && linkedUniverseStatus === 'unavailable';
  const generationDisabledReason = styleContextLoading
    ? 'Loading linked universe style…'
    : styleContextUnavailable
      ? 'Linked universe style is unavailable'
      : '';
  const sceneStylePreset = useMemo(
    () => universeStylePreset(linkedUniverse, linkedSeries),
    [linkedSeries, linkedUniverse],
  );

  const episode = seriesPlanOpen ? null : loom?.episodes.find((e) => e.id === episodeId) || null;
  const node = episode?.nodes.find((n) => n.id === nodeId) || null;

  const setSceneMediaJob = useCallback((targetNodeId, kind, nextJob) => {
    setMediaJobs((prev) => {
      const currentNodeJobs = prev[targetNodeId] || {};
      if (nextJob) {
        return { ...prev, [targetNodeId]: { ...currentNodeJobs, [kind]: nextJob } };
      }
      const nextNodeJobs = { ...currentNodeJobs };
      delete nextNodeJobs[kind];
      if (Object.keys(nextNodeJobs).length > 0) return { ...prev, [targetNodeId]: nextNodeJobs };
      const next = { ...prev };
      delete next[targetNodeId];
      return next;
    });
  }, []);

  const handleMediaJobUpdate = useCallback((targetNodeId, kind, jobId, progress) => {
    setMediaJobs((prev) => {
      const current = prev[targetNodeId]?.[kind];
      if (!current || current.jobId !== jobId) return prev;
      return {
        ...prev,
        [targetNodeId]: {
          ...prev[targetNodeId],
          [kind]: { ...current, ...progress, jobId },
        },
      };
    });
  }, []);

  const applySceneMedia = useCallback((targetNodeId, patch) => {
    setLoom((prev) => (prev ? {
      ...prev,
      episodes: prev.episodes.map((item) => ({
        ...item,
        nodes: item.nodes.map((scene) => (scene.id === targetNodeId ? { ...scene, ...patch } : scene)),
      })),
    } : prev));
  }, []);

  const handleMediaJobTerminal = useCallback((targetNodeId, kind, jobId, progress) => {
    const label = kind === 'video' ? 'video' : 'image';
    if (progress.status === 'failed') {
      toast.error(`Scene ${label} generation failed${progress.error ? `: ${progress.error}` : ''}`);
      return;
    }
    if (progress.status === 'canceled') return;
    if (progress.status !== 'completed') return;

    if (kind === 'image') {
      applySceneMedia(targetNodeId, { image: progress.filename, imageJobId: jobId });
    } else {
      applySceneMedia(targetNodeId, { videoHistoryId: jobId });
    }
    setSceneMediaJob(targetNodeId, kind, null);
    toast.success(`Scene ${label} ready`);
  }, [applySceneMedia, setSceneMediaJob]);

  const queueSceneImage = useCallback(async (targetNode) => {
    const prompt = (targetNode?.imagePrompt || '').trim();
    if (!prompt) {
      toast.error('Write an image prompt first');
      return null;
    }
    if (styleContextLoading || styleContextUnavailable) {
      toast.error(generationDisabledReason || 'Scene style is not ready');
      return null;
    }

    setSceneMediaJob(targetNode.id, 'image', { jobId: null, status: 'submitting', progress: 0 });
    const imageRequest = (includeContinuity) => buildFableLoomImageRequest({
      loom,
      episode: includeContinuity ? episode : null,
      episodeId,
      node: targetNode,
      stylePreset: sceneStylePreset,
    });
    let continuityFallbackCode = null;
    const queued = await generateImage(imageRequest(true), { silent: true })
      .catch((err) => {
        if (!CONTINUITY_FALLBACK_CODES.has(err.code)) throw err;
        continuityFallbackCode = err.code;
        return generateImage(imageRequest(false), { silent: true });
      })
      .catch((err) => {
        setSceneMediaJob(targetNode.id, 'image', {
          jobId: null, status: 'failed', progress: 0, error: err.message || 'Could not start the render',
        });
        toast.error(`Could not start scene image: ${err.message || 'Render request failed'}`);
        return null;
      });
    if (!queued) return null;
    if (continuityFallbackCode) {
      toast.warning(continuityFallbackCode === 'REFERENCE_IMAGE_NOT_FOUND'
        ? 'The prior shot image is missing — rendering this scene without continuity conditioning'
        : 'The current image backend cannot use the prior shot — rendering this scene without continuity conditioning');
    }
    // External SD-API renders synchronously: its generationId identifies the
    // completed request, not a media-job record. The server has already filed
    // the image onto the scene, so swap the preview immediately and do not
    // mount a watcher that would poll a nonexistent queue job.
    if (!queued.jobId && queued.filename) {
      applySceneMedia(targetNode.id, {
        image: queued.filename,
        imageJobId: queued.generationId || null,
      });
      setSceneMediaJob(targetNode.id, 'image', null);
      toast.success('Scene image ready');
      return queued;
    }
    // `generationId` was the queue id on older route responses, but external
    // synchronous results carry no status. Keep that compatibility without
    // confusing their transient generation id for a pollable job.
    const jobId = queued.jobId || (queued.status ? queued.generationId : null);
    if (!jobId) {
      const error = 'Image generator returned no job id';
      setSceneMediaJob(targetNode.id, 'image', { jobId: null, status: 'failed', progress: 0, error });
      toast.error(error);
      return null;
    }
    setSceneMediaJob(targetNode.id, 'image', {
      jobId, status: queued.status || 'queued', progress: 0,
    });
    toast.success('Scene image queued');
    return queued;
  }, [applySceneMedia, episode, episodeId, generationDisabledReason, loom, sceneStylePreset, setSceneMediaJob, styleContextLoading, styleContextUnavailable]);

  const queueSceneVideo = useCallback(async (targetNode) => {
    const prompt = (targetNode?.videoPrompt || '').trim() || (targetNode?.prose || '').trim();
    if (!prompt) {
      toast.error('Write the scene first');
      return null;
    }
    if (styleContextLoading || styleContextUnavailable) {
      toast.error(generationDisabledReason || 'Scene style is not ready');
      return null;
    }

    setSceneMediaJob(targetNode.id, 'video', { jobId: null, status: 'submitting', progress: 0 });
    const queued = await generateVideo(buildFableLoomVideoRequest({
      loom, episodeId, node: targetNode, stylePreset: sceneStylePreset,
    })).catch((err) => {
      setSceneMediaJob(targetNode.id, 'video', {
        jobId: null, status: 'failed', progress: 0, error: err.message || 'Could not start the render',
      });
      toast.error(`Could not start scene video: ${err.message || 'Render request failed'}`);
      return null;
    });
    if (!queued) return null;
    const jobId = queued.jobId || queued.generationId;
    if (!jobId) {
      const error = 'Video generator returned no job id';
      setSceneMediaJob(targetNode.id, 'video', { jobId: null, status: 'failed', progress: 0, error });
      toast.error(error);
      return null;
    }
    setSceneMediaJob(targetNode.id, 'video', {
      jobId, status: queued.status || 'queued', progress: 0,
    });
    toast.success('Scene video queued');
    return queued;
  }, [episodeId, generationDisabledReason, loom, sceneStylePreset, setSceneMediaJob, styleContextLoading, styleContextUnavailable]);

  const basePath = `/fableloom/${loomId}`;
  const episodePath = useCallback(
    (epId, nId) => `${basePath}/${epId}${nId ? `/${nId}` : ''}`,
    [basePath],
  );
  // Node selection navigates (URL is the selection) and keeps the play
  // drawer's ?play=1 across the move.
  const selectNode = (id) => {
    navigate(episodePath(episodeId, id) + (playOpen ? '?play=1' : ''));
  };

  const setPlayOpen = (open) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (open) next.set('play', '1');
      else next.delete('play');
      return next;
    }, { replace: true });
  };

  const handleAddEpisode = async () => {
    const updated = await addLoomEpisode(loomId, { title: `Episode ${(loom?.episodes.length || 0) + 1}` })
      .catch(() => null);
    if (updated) {
      setLoom(updated);
      const added = updated.episodes[updated.episodes.length - 1];
      navigate(episodePath(added.id));
      setSetupOpen(true);
    }
  };

  // A rewrite changes scene text server-side (per chunk, so even a failed run
  // moved some). Re-read the record and drop the scene selection: an open
  // scene editor still holds the pre-rewrite text and would write it back on
  // its next blur-save.
  const handleRewritten = async ({ refetch = true } = {}) => {
    if (nodeId) navigate(episodePath(episodeId, null) + (playOpen ? '?play=1' : ''));
    if (!refetch) return;
    const fresh = await getLoom(loomId).catch(() => null);
    if (fresh) setLoom(fresh);
  };

  const handleAddNode = async () => {
    const updated = await addLoomNode(loomId, episode.id, { title: 'New scene' }).catch(() => null);
    if (updated) {
      setLoom(updated);
      const ep = updated.episodes.find((e) => e.id === episode.id);
      const added = ep?.nodes[ep.nodes.length - 1];
      if (added) navigate(episodePath(episode.id, added.id));
    }
  };

  const handleMoveNode = (movedNodeId, pos) => {
    // Optimistic: fold the new position into local state, persist silently.
    // The echo is NOT folded back in — pos is already exact client-side, and
    // replacing the loom would re-layout the whole canvas a second time.
    setLoom((prev) => ({
      ...prev,
      episodes: prev.episodes.map((e) => (e.id !== episode.id ? e : {
        ...e,
        nodes: e.nodes.map((n) => (n.id === movedNodeId ? { ...n, pos } : n)),
      })),
    }));
    updateLoomNode(loomId, episode.id, movedNodeId, { pos }, { silent: true }).catch(() => {});
  };

  if (notFound) {
    return (
      <div className="p-8 text-center">
        <p className="text-sm text-port-text-muted">This loom no longer exists.</p>
        <Link to="/fableloom" className="text-port-accent text-sm hover:underline">Back to FableLoom</Link>
      </div>
    );
  }
  if (!loom) {
    return <PageSkeleton label="Loading loom" fullHeight padded sidebar={false} />;
  }

  // Route normalization: a loom without episodes starts in series planning;
  // an established loom opens its first episode. The reserved `plan` id is
  // the series view.
  if (!episodeId && !loom.episodes.length) {
    return <Navigate to={`${basePath}/plan`} replace />;
  }
  if (!seriesPlanOpen && !episode && loom.episodes.length) {
    return <Navigate to={episodePath(loom.episodes[0].id)} replace />;
  }
  if (!seriesPlanOpen && episodeId && !episode) {
    return <Navigate to={basePath} replace />;
  }

  return (
    <div ref={pageRef} className="h-full flex flex-col">
      <LoomMediaJobWatchers
        jobs={mediaJobs}
        onUpdate={handleMediaJobUpdate}
        onTerminal={handleMediaJobTerminal}
      />
      <header className="border-b border-port-border px-4 py-2.5 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Link to="/fableloom" className="text-port-text-muted hover:text-port-text" aria-label="Back to FableLoom">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="font-semibold flex items-center gap-2 min-w-0">
            <Waypoints size={16} className="text-port-accent shrink-0" />
            <span className="truncate">{loom.name}</span>
          </h1>
          {linkedSeries ? (
            <Link
              to={`/pipeline/series/${encodeURIComponent(linkedSeries.id)}`}
              className="flex items-center gap-1 px-2 py-1 rounded border border-port-border text-xs text-port-text-muted hover:text-port-text hover:border-port-accent min-w-0"
              title="Open the series this branching narrative is linked to"
            >
              <WorkflowIcon size={12} className="shrink-0" />
              <span className="truncate max-w-[12rem]">{linkedSeries.name || 'Untitled series'}</span>
            </Link>
          ) : null}
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Story settings"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-port-border text-xs hover:border-port-accent"
            >
              <Settings size={13} /> Settings
            </button>
            {episode && (
              <>
              <button
                type="button"
                onClick={handleAddNode}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-port-border text-xs hover:border-port-accent"
              >
                <Plus size={13} /> Scene
              </button>
              <button
                type="button"
                onClick={() => setSetupOpen(true)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-port-border text-xs hover:border-port-accent"
              >
                <Sparkles size={13} /> Weave
              </button>
              <button
                type="button"
                onClick={() => setPlayOpen(true)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-port-accent text-white text-xs"
              >
                <BookOpenText size={13} /> Play
              </button>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <TabPills
            variant="pills"
            size="sm"
            ariaLabel="Series and episodes"
            mobileDropdown
            tabs={[
              { id: 'plan', label: 'Series plan' },
              ...loom.episodes.map((e) => ({ id: e.id, label: `${e.number}. ${e.title || 'Untitled'}` })),
            ]}
            activeTab={seriesPlanOpen ? 'plan' : episodeId}
            onChange={(id) => navigate(episodePath(id))}
          />
          <button
            type="button"
            onClick={handleAddEpisode}
            className="px-2.5 py-1 rounded-full text-xs border border-dashed border-port-border text-port-text-muted hover:border-port-accent hover:text-port-accent"
          >
            + Episode
          </button>
          {episode && (
            <TabPills
              variant="pills"
              size="xs"
              ariaLabel="Episode view"
              tabs={[
                { id: 'graph', label: 'Graph', icon: Waypoints },
                { id: 'outline', label: 'Outline', icon: ListTree },
              ]}
              activeTab={outlineOpen ? 'outline' : 'graph'}
              onChange={(id) => navigate(id === 'outline' ? `${episodePath(episode.id)}/outline` : episodePath(episode.id))}
            />
          )}
        </div>
      </header>

      {seriesPlanOpen ? (
        <LoomSeriesPlan loom={loom} onLoomUpdate={setLoom} />
      ) : !episode ? (
        <div className="flex-1 grid place-items-center p-8 text-center">
          <div>
            <Waypoints size={32} className="mx-auto text-port-text-muted mb-3" />
            <p className="text-sm text-port-text-muted mb-3">
              No episodes yet — add one, then weave its scene graph with AI or build it by hand.
            </p>
            <button
              type="button"
              onClick={handleAddEpisode}
              className="px-3 py-2 rounded bg-port-accent text-white text-sm"
            >
              Add the first episode
            </button>
          </div>
        </div>
      ) : outlineOpen ? (
        <LoomEpisodeOutline
          loom={loom}
          episode={episode}
          onSelectNode={(id) => navigate(episodePath(episode.id, id))}
        />
      ) : (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          <section className="flex-1 min-h-[55vh] lg:min-h-0 min-w-0 relative">
            {episode.nodes.length ? (
              <LoomCanvas
                episode={episode}
                selectedNodeId={nodeId || null}
                onSelectNode={selectNode}
                onMoveNode={handleMoveNode}
                orientation={graphOrientation}
                mediaJobs={mediaJobs}
                onGenerateImage={queueSceneImage}
                onGenerateVideo={queueSceneVideo}
                generationDisabled={styleContextLoading || styleContextUnavailable}
                generationDisabledReason={generationDisabledReason}
              />
            ) : (
              <div className="h-full grid place-items-center p-8 text-center">
                <div>
                  <p className="text-sm text-port-text-muted mb-3">
                    This episode has no scenes yet.
                  </p>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSetupOpen(true)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded bg-port-accent text-white text-sm"
                    >
                      <Sparkles size={14} /> Weave with AI
                    </button>
                    <button
                      type="button"
                      onClick={handleAddNode}
                      className="px-3 py-2 rounded border border-port-border text-sm hover:border-port-accent"
                    >
                      Add a scene by hand
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
          <aside
            className="lg:w-[380px] lg:shrink-0 max-h-dvh-cap lg:max-h-none border-t lg:border-t-0 lg:border-l border-port-border overflow-y-auto"
            style={{ '--dvh-cap': '45vh', '--dvh-cap-dynamic': '45dvh' }}
          >
            {node ? (
              <LoomNodeEditor
                key={node.id}
                loom={loom}
                episode={episode}
                node={node}
                onLoomUpdate={setLoom}
                onClearSelection={() => navigate(episodePath(episode.id))}
                mediaJobs={mediaJobs[node.id]}
                onGenerateImage={queueSceneImage}
                onGenerateVideo={queueSceneVideo}
                generationDisabled={styleContextLoading || styleContextUnavailable}
                generationDisabledReason={generationDisabledReason}
                onMakeStart={node.id !== episode.startNodeId ? async () => {
                  const updated = await updateLoomEpisode(loomId, episode.id, { startNodeId: node.id })
                    .catch(() => null);
                  if (updated) setLoom(updated);
                } : null}
              />
            ) : (
              <LoomValidationPanel
                loom={loom}
                episode={episode}
                onSelectNode={selectNode}
              />
            )}
          </aside>
        </div>
      )}

      {episode && (
        <EpisodeSetupDrawer
          open={setupOpen}
          onClose={() => setSetupOpen(false)}
          loom={loom}
          episode={episode}
          onLoomUpdate={setLoom}
          onFeedbackStarted={() => handleRewritten({ refetch: false })}
          onDeleted={() => {
            setSetupOpen(false);
            navigate(basePath);
          }}
        />
      )}

      <LoomSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        loom={loom}
        onLoomUpdate={setLoom}
        onRewritten={handleRewritten}
      />

      {episode && (
        <Drawer open={playOpen} onClose={() => setPlayOpen(false)} title="Play" subtitle={loom.name} size="md" bodyClassName="p-0">
          <LoomPlayPanel loom={loom} episode={episode} />
        </Drawer>
      )}
    </div>
  );
}

/**
 * Episode setup drawer — title/synopsis (the weave inputs), the AI weave
 * controls, and episode deletion.
 */
function EpisodeSetupDrawer({ open, onClose, loom, episode, onLoomUpdate, onFeedbackStarted, onDeleted }) {
  const [form, setForm] = useState({ title: '', synopsis: '', guidance: '' });
  // The weave reads server-side state (title/synopsis), so it gates on
  // in-flight meta saves per the client save-gating convention.
  const [metaSaving, setMetaSaving] = useState(0);
  const [feedbackRunning, setFeedbackRunning] = useState(false);
  const del = useConfirmDelete();
  const hasScenes = episode.nodes.length > 0;

  // Sync from the record on episode switch ONLY — re-syncing on every server
  // echo would clobber typing in a sibling field while a blur-save
  // round-trips (same rule as the scene editor).
  useEffect(() => {
    setForm((prev) => ({ ...prev, title: episode.title || '', synopsis: episode.synopsis || '' }));
  }, [episode.id]);

  const saveMeta = async (key) => {
    if (form[key] === (episode[key] || '')) return;
    setMetaSaving((n) => n + 1);
    await updateLoomEpisode(loom.id, episode.id, { [key]: form[key] }, { silent: true })
      .then(onLoomUpdate)
      .catch((err) => toast.error(`Save failed: ${err.message}`));
    setMetaSaving((n) => n - 1);
  };

  const [runWeave, weaving] = useAsyncAction(async () => {
    const result = await weaveLoomEpisode(loom.id, episode.id, {
      guidance: form.guidance,
      replace: hasScenes,
    }, { silent: true });
    onLoomUpdate(result.loom);
    toast.success('Episode woven');
    onClose();
  }, { errorMessage: 'Weave failed' });

  const handleDelete = async () => {
    const updated = await deleteLoomEpisode(loom.id, episode.id).catch(() => null);
    if (updated) {
      onLoomUpdate(updated);
      onDeleted();
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Episode setup" subtitle={`${loom.name} — episode ${episode.number}`} size="sm">
      <div className="space-y-4">
        <FormField label="Title" labelClassName={labelClass}>
          <input
            className={fieldClass}
            value={form.title}
            onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
            onBlur={() => saveMeta('title')}
          />
        </FormField>
        <FormField label="Synopsis (feeds the weave)" labelClassName={labelClass}>
          <textarea
            rows={4}
            className={fieldClass}
            placeholder="What this episode is about — setup, stakes, tone"
            value={form.synopsis}
            onChange={(e) => setForm((p) => ({ ...p, synopsis: e.target.value }))}
            onBlur={() => saveMeta('synopsis')}
          />
        </FormField>

        <div className="border-t border-port-border pt-4 space-y-3">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <Sparkles size={14} className="text-port-accent" /> Weave the scene graph
          </h4>
          <FormField label="Guidance (optional)" labelClassName={labelClass}>
            <textarea
              rows={2}
              className={fieldClass}
              placeholder="e.g. lean into dread; one ending must be hopeful"
              value={form.guidance}
              onChange={(e) => setForm((p) => ({ ...p, guidance: e.target.value }))}
            />
          </FormField>
          <p className="text-xs text-port-text-muted">
            The story writer and creative director choose the number of camera-cut scenes and endings from the episode.
          </p>
          {hasScenes && (
            <p className="text-xs text-port-warning">
              Weaving replaces this episode's {episode.nodes.length} existing scene{episode.nodes.length === 1 ? '' : 's'} and drops their rendered stills and video clips.
            </p>
          )}
          <button
            type="button"
            onClick={runWeave}
            disabled={weaving || feedbackRunning || metaSaving > 0}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-60"
          >
            {weaving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {weaving ? 'Weaving…' : hasScenes ? 'Reweave episode' : 'Weave episode'}
          </button>
        </div>

        <LoomEpisodeFeedback
          open={open}
          loom={loom}
          episode={episode}
          onLoomUpdate={onLoomUpdate}
          onFeedbackStarted={onFeedbackStarted}
          disabled={metaSaving > 0}
          onRunningChange={setFeedbackRunning}
        />

        <div className="border-t border-port-border pt-4">
          {del.isConfirming(episode.id) ? (
            <ConfirmButtonPair
              prompt="Delete episode?"
              onConfirm={handleDelete}
              onCancel={del.cancelDelete}
            />
          ) : (
            <button
              type="button"
              onClick={() => del.requestDelete(episode.id)}
              className="flex items-center gap-1.5 text-xs text-port-text-muted hover:text-port-error"
            >
              <Trash2 size={13} /> Delete this episode
            </button>
          )}
        </div>
      </div>
    </Drawer>
  );
}
