/**
 * FableLoom editor — the full-bleed visual workspace for one loom.
 *
 * URL is the source of truth: /fableloom/:loomId/plan is the series workspace;
 * /fableloom/:loomId/:episodeId selects an episode, /outline switches that
 * episode to its text outline, and /:nodeId selects a scene in the graph. The
 * full-screen player rides ?play=1.
 * Left: the scene-graph canvas (stacks top-to-bottom under the `lg` rail
 * breakpoint). Right rail: the selected scene's editor, or the
 * structure/review panel when nothing is selected. On small screens a
 * selected scene slides up over the graph as a dismissible details sheet.
 * The page never scrolls (the app `<main>` is `overflow-hidden` for this
 * route), so the stacked graph/rail split is sized in percentages of the pane
 * left under the header, and the header demotes its actions into an
 * `OverflowMenu` on phones — `vh` sizing here silently pushes the rail's
 * content off-screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, BookOpenText, ListTree, PencilLine, Plus, Settings, Sparkles, Trash2, Waypoints, Workflow as WorkflowIcon, X } from 'lucide-react';
import toast from '../components/ui/Toast';
import Drawer from '../components/Drawer';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { FormField } from '../components/ui/FormField.jsx';
import Modal from '../components/ui/Modal';
import OverflowMenu from '../components/ui/OverflowMenu';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import useFableLoomAiRun from '../hooks/useFableLoomAiRun';
import useContainerWidth from '../hooks/useContainerWidth';
import { useScrollLock } from '../hooks/useScrollLock';
import LoomCanvas from '../components/fableloom/LoomCanvas';
import LoomEpisodeOutline from '../components/fableloom/LoomEpisodeOutline';
import LoomEpisodeOutlinePlanner from '../components/fableloom/LoomEpisodeOutlinePlanner';
import LoomEpisodeFeedback from '../components/fableloom/LoomEpisodeFeedback';
import LoomMediaJobWatchers from '../components/fableloom/LoomMediaJobWatchers';
import LoomNodeEditor from '../components/fableloom/LoomNodeEditor';
import LoomPlayPanel from '../components/fableloom/LoomPlayPanel';
import LoomSettingsDrawer from '../components/fableloom/LoomSettingsDrawer';
import LoomSeriesPlan from '../components/fableloom/LoomSeriesPlan';
import LoomValidationPanel from '../components/fableloom/LoomValidationPanel';
import LoomAiRunStatus from '../components/fableloom/LoomAiRunStatus';
import FalH3MaxPromptFallback from '../components/videoGen/FalH3MaxPromptFallback';
import { fieldClass, labelClass } from '../components/fableloom/fieldStyles';
import {
  buildFableLoomImageRequest, buildFableLoomVideoRequest,
} from '../components/fableloom/sceneMediaRequests';
import { universeStylePreset } from '../lib/universeStylePreset';
import { fableLoomMediaReadiness } from '../lib/fableLoomReadiness';
import { openFalH3MaxFreeTool } from '../lib/falVideoHandoff';
import { LOOM_ORIENTATION, LOOM_STACK_WIDTH } from '../lib/loomLayout';
import {
  addLoomEpisode, addLoomNode, deleteLoomEpisode, generateImage, generateVideo,
  getLoom, getPipelineSeries, getUniverse, updateLoomEpisode, updateLoomNode,
  weaveLoomEpisode,
} from '../services/api';

// Phone-first sizing: a 44px touch target next to the overflow trigger, then
// the denser desktop row from `sm` up. Base and variants never both set the
// same utility — with no tailwind-merge, two border colors resolve by
// stylesheet order, not by class-string order.
const headerActionBase = 'flex min-h-[44px] items-center gap-1 rounded border px-2.5 py-2 text-xs sm:min-h-[36px] sm:py-1.5';
const headerActionClass = `${headerActionBase} border-port-border hover:border-port-accent`;
const headerPlayClass = `${headerActionBase} border-port-accent bg-port-accent text-white`;

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
  const [falManualPrompt, setFalManualPrompt] = useState('');
  const playOpen = searchParams.get('play') === '1';
  useScrollLock(playOpen);
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
  const mediaReadiness = useMemo(
    () => fableLoomMediaReadiness(loom, episode),
    [loom, episode],
  );
  const mediaWorkflowBlocked = Boolean(episode?.nodes?.length && !mediaReadiness.ready);
  const mediaGenerationDisabledReason = mediaWorkflowBlocked
    ? mediaReadiness.reason
    : generationDisabledReason;

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
        nodes: item.nodes.map((scene) => (scene.id === targetNodeId ? {
          ...scene,
          ...patch,
          ...(patch.image && scene.visualCanon ? {
            visualCanon: { ...scene.visualCanon, storyboardImageApproved: false },
          } : {}),
        } : scene)),
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
    if (mediaWorkflowBlocked) {
      toast.error(mediaReadiness.reason);
      return null;
    }
    if (styleContextLoading || styleContextUnavailable) {
      toast.error(generationDisabledReason || 'Scene style is not ready');
      return null;
    }

    setSceneMediaJob(targetNode.id, 'image', { jobId: null, status: 'submitting', progress: 0 });
    const imageRequest = buildFableLoomImageRequest({
      loom,
      episodeId,
      node: targetNode,
      stylePreset: sceneStylePreset,
    });
    const queued = await generateImage(imageRequest, { silent: true })
      .catch((err) => {
        setSceneMediaJob(targetNode.id, 'image', {
          jobId: null, status: 'failed', progress: 0, error: err.message || 'Could not start the render',
        });
        toast.error(`Could not start scene image: ${err.message || 'Render request failed'}`);
        return null;
      });
    if (!queued) return null;
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
  }, [applySceneMedia, episode, episodeId, generationDisabledReason, loom, mediaReadiness.reason, mediaWorkflowBlocked, sceneStylePreset, setSceneMediaJob, styleContextLoading, styleContextUnavailable]);

  const queueSceneVideo = useCallback(async (targetNode) => {
    const prompt = (targetNode?.videoPrompt || '').trim() || (targetNode?.prose || '').trim();
    if (!prompt) {
      toast.error('Write the scene first');
      return null;
    }
    if (mediaWorkflowBlocked) {
      toast.error(mediaReadiness.reason);
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
  }, [episodeId, generationDisabledReason, loom, mediaReadiness.reason, mediaWorkflowBlocked, sceneStylePreset, setSceneMediaJob, styleContextLoading, styleContextUnavailable]);

  const openFalSceneVideo = useCallback((targetNode) => {
    const prompt = (targetNode?.videoPrompt || '').trim() || (targetNode?.prose || '').trim();
    if (!prompt) {
      toast.error('Write the scene first');
      return false;
    }
    if (mediaWorkflowBlocked) {
      toast.error(mediaReadiness.reason);
      return false;
    }
    if (styleContextLoading || styleContextUnavailable) {
      toast.error(generationDisabledReason || 'Scene style is not ready');
      return false;
    }
    const request = buildFableLoomVideoRequest({
      loom, episodeId, node: targetNode, stylePreset: sceneStylePreset,
    });
    return openFalH3MaxFreeTool({
      ...request,
      onCopyFailure: setFalManualPrompt,
    });
  }, [episodeId, generationDisabledReason, loom, mediaReadiness.reason, mediaWorkflowBlocked, sceneStylePreset, styleContextLoading, styleContextUnavailable]);

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
  const clearNodeSelection = () => {
    navigate(episodePath(episodeId) + (playOpen ? '?play=1' : ''));
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

  // One list drives both header shapes: labelled buttons from `sm` up, and the
  // same actions inside the overflow menu on phones, where five buttons plus
  // the loom title ran off the right edge of the screen.
  const headerActions = [
    { id: 'settings', label: 'Story settings', short: 'Settings', icon: Settings, onSelect: () => setSettingsOpen(true) },
    ...(episode ? [
      { id: 'add-scene', label: 'Add scene', short: 'Scene', icon: Plus, onSelect: handleAddNode },
      { id: 'edit-episode', label: 'Edit episode', hint: 'Edit episode title and synopsis', icon: PencilLine, onSelect: () => setSetupOpen(true) },
      { id: 'weave', label: 'Weave', hint: 'Weave this episode with AI', icon: Sparkles, onSelect: () => setSetupOpen(true) },
    ] : []),
  ];

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
      <header className="border-b border-port-border px-3 py-2 sm:px-4 sm:py-2.5 space-y-1.5 sm:space-y-2">
        <div className="flex items-center gap-2 sm:gap-3">
          <Link to="/fableloom" className="shrink-0 text-port-text-muted hover:text-port-text" aria-label="Back to FableLoom">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="font-semibold flex items-center gap-2 min-w-0 flex-1">
            <Waypoints size={16} className="text-port-accent shrink-0" />
            <span className="truncate">{loom.name}</span>
          </h1>
          {linkedSeries ? (
            <Link
              to={`/pipeline/series/${encodeURIComponent(linkedSeries.id)}`}
              className="flex min-w-0 shrink items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-port-text-muted hover:border-port-accent hover:text-port-text"
              title="Open the series this branching narrative is linked to"
            >
              <WorkflowIcon size={12} className="shrink-0" />
              <span className="truncate max-w-[5rem] sm:max-w-[12rem]">{linkedSeries.name || 'Untitled series'}</span>
            </Link>
          ) : null}
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden items-center gap-2 sm:flex">
              {headerActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={action.onSelect}
                  aria-label={action.label}
                  title={action.hint || action.label}
                  className={headerActionClass}
                >
                  <action.icon size={13} /> {action.short || action.label}
                </button>
              ))}
            </div>
            <OverflowMenu label="Story actions" items={headerActions} className="sm:hidden" />
            {episode && (
              <button
                type="button"
                onClick={() => setPlayOpen(true)}
                aria-label="Play"
                title="Play this episode"
                className={headerPlayClass}
              >
                <BookOpenText size={13} /> Play
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          <TabPills
            variant="pills"
            size="sm"
            ariaLabel="Series and episodes"
            mobileDropdown
            mobileSelectClassName="sm:hidden min-w-0 flex-1"
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
            aria-label="Add episode"
            title="Add episode"
            className="flex min-h-[36px] shrink-0 items-center rounded-full border border-dashed border-port-border px-3 text-xs text-port-text-muted hover:border-port-accent hover:text-port-accent"
          >
            + <span className="hidden sm:inline">Episode</span>
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
        // Stacked (phone) split: the graph takes whatever the validation rail
        // doesn't. The rail is capped as a PERCENTAGE OF THIS PANE, never in
        // `vh` — the page is `overflow-hidden` under the app chrome, so viewport
        // units ignored the header and pushed the rail's content off-screen
        // (the graph claimed 55vh while only ~70vh was left to split).
        <div className="relative flex-1 min-h-0 flex flex-col lg:flex-row">
          <section className="relative min-h-0 min-w-0 flex-1">
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
                onOpenFalVideo={openFalSceneVideo}
                generationDisabled={styleContextLoading || styleContextUnavailable || mediaWorkflowBlocked}
                generationDisabledReason={mediaGenerationDisabledReason}
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
          {node && (
            <button
              type="button"
              aria-label="Return to graph"
              onClick={clearNodeSelection}
              className="absolute inset-0 z-10 bg-black/45 lg:hidden"
            />
          )}
          <aside
            data-testid={node ? 'scene-details-sheet' : 'loom-validation-rail'}
            aria-label={node ? `${node.title || 'Scene'} details` : 'Episode validation'}
            className={node
              ? 'absolute inset-x-0 bottom-0 z-20 flex h-[calc(100%_-_0.75rem)] flex-col overflow-hidden rounded-t-2xl border border-b-0 border-port-border bg-port-card shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-200 lg:static lg:h-auto lg:w-[380px] lg:shrink-0 lg:rounded-none lg:border-y-0 lg:border-r-0 lg:border-l'
              : 'flex max-h-[45%] flex-col overflow-hidden border-t border-port-border lg:max-h-none lg:w-[380px] lg:shrink-0 lg:border-t-0 lg:border-l'}
          >
            {node && (
              <div className="relative flex min-h-[4.5rem] shrink-0 items-center justify-center border-b border-port-border px-4 py-3 lg:hidden">
                <span className="h-1 w-10 rounded-full bg-port-border" aria-hidden="true" />
                <button
                  type="button"
                  onClick={clearNodeSelection}
                  aria-label="Close scene details"
                  className="absolute right-3 top-1/2 flex min-h-[56px] min-w-[56px] -translate-y-1/2 items-center justify-center rounded-xl text-port-text-muted hover:bg-port-border/50 hover:text-port-text"
                >
                  <X size={24} />
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {node ? (
                <LoomNodeEditor
                  key={node.id}
                  loom={loom}
                  episode={episode}
                  node={node}
                  universe={linkedUniverse}
                  onLoomUpdate={setLoom}
                  onClearSelection={clearNodeSelection}
                  mediaJobs={mediaJobs[node.id]}
                  onGenerateImage={queueSceneImage}
                  onGenerateVideo={queueSceneVideo}
                  onOpenFalVideo={openFalSceneVideo}
                  generationDisabled={styleContextLoading || styleContextUnavailable || mediaWorkflowBlocked}
                  generationDisabledReason={mediaGenerationDisabledReason}
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
                  onOpenSettings={() => setSettingsOpen(true)}
                  onOpenSeriesPlan={(section) => navigate(
                    `${episodePath('plan')}${section ? `?section=${encodeURIComponent(section)}` : ''}`,
                  )}
                  onOpenEpisodeSetup={() => setSetupOpen(true)}
                  onOpenPlay={() => setPlayOpen(true)}
                  onLoomUpdate={setLoom}
                />
              )}
            </div>
          </aside>
        </div>
      )}

      {episode && (
        <EpisodeSetupDrawer
          key={episode.id}
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
        universe={linkedUniverse}
        onLoomUpdate={setLoom}
        onRewritten={handleRewritten}
      />

      {episode && (
        <Modal
          open={playOpen}
          onClose={() => setPlayOpen(false)}
          size="none"
          align="none"
          usePortal
          zIndexClassName="z-[100]"
          backdropClassName="bg-black"
          panelClassName="h-[100dvh] w-full overflow-hidden bg-black"
          ariaLabel={`${loom.name} player`}
        >
          <LoomPlayPanel loom={loom} episode={episode} onClose={() => setPlayOpen(false)} />
        </Modal>
      )}

      <FalH3MaxPromptFallback
        prompt={falManualPrompt}
        onClose={() => setFalManualPrompt('')}
      />
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
  const { run: aiRun, begin: beginAiRun, fail: failAiRun } = useFableLoomAiRun();
  const del = useConfirmDelete();
  const expansionConfirm = useConfirmDelete();
  const hasScenes = episode.nodes.length > 0;

  // Sync from the record on episode switch ONLY — re-syncing on every server
  // echo would clobber typing in a sibling field while a blur-save
  // round-trips (same rule as the scene editor). Guidance is intentionally
  // episode-local scratch input; carrying it into the next episode can make an
  // otherwise valid outline request contradict that episode's graph.
  useEffect(() => {
    setForm({ title: episode.title || '', synopsis: episode.synopsis || '', guidance: '' });
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
    const operationId = beginAiRun();
    const result = await weaveLoomEpisode(loom.id, episode.id, {
      guidance: form.guidance,
      replace: hasScenes,
      expandFromOutline: true,
      operationId,
    }, { silent: true }).catch((error) => {
      failAiRun(error.message);
      throw error;
    });
    onLoomUpdate(result.loom);
    toast.success('Episode woven');
    onClose();
  }, { errorMessage: 'Weave failed' });

  const requestWeave = () => {
    if (hasScenes) {
      expansionConfirm.requestDelete(episode.id);
      return;
    }
    runWeave();
  };

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
            <Sparkles size={14} className="text-port-accent" /> Expand the episode
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
            Start with the beat outline below, review the whole arc, then expand it into one-camera-cut teleplay scenes.
          </p>
          <LoomEpisodeOutlinePlanner
            open={open}
            loom={loom}
            episode={episode}
            guidance={form.guidance}
            disabled={metaSaving > 0 || feedbackRunning || weaving}
            onLoomUpdate={onLoomUpdate}
            onExpand={requestWeave}
            expanding={weaving}
          />
          {expansionConfirm.isConfirming(episode.id) && (
            <ConfirmButtonPair
              prompt={`Replace ${episode.nodes.length} existing scene${episode.nodes.length === 1 ? '' : 's'} and remove their rendered stills and video clips?`}
              confirmText="Replace scenes"
              tone="error"
              ariaLabel="Confirm replacing episode scenes"
              onConfirm={() => expansionConfirm.confirmDelete(runWeave)}
              onCancel={expansionConfirm.cancelDelete}
              largeTouchTargets
            />
          )}
          {hasScenes && (
            <p className="text-xs text-port-warning">
              Expansion replaces this episode's {episode.nodes.length} existing scene{episode.nodes.length === 1 ? '' : 's'} and drops their rendered stills and video clips.
            </p>
          )}
          <LoomAiRunStatus run={aiRun} />
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
