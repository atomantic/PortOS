import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router';
import { ArrowLeft, Clapperboard, ClipboardList, Eye, Film, FileText, LayoutList, Package, Pause, ScrollText, SlidersHorizontal, Square, Trash2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import RecordStatusLine from '../components/ui/RecordStatusLine.jsx';
import TabPills from '../components/ui/TabPills.jsx';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import {
  getCreativeDirectorProject,
  deleteCreativeDirectorProject,
  startCreativeDirectorProject,
  pauseCreativeDirectorProject,
  stopCreativeDirectorProject,
  resumeCreativeDirectorProject,
} from '../services/apiCreativeDirector.js';
import VideoCutPanel from '../components/creative-director/VideoCutPanel.jsx';
import VideoExecutionPanel from '../components/creative-director/VideoExecutionPanel.jsx';
import VideoReviewPanel from '../components/creative-director/VideoReviewPanel.jsx';
import VideoDraftDrawer from '../components/creative-director/VideoDraftDrawer.jsx';
import OverviewTab from '../components/creative-director/OverviewTab.jsx';
import TreatmentTab from '../components/creative-director/TreatmentTab.jsx';
import VideoArtifactsTab from '../components/creative-director/VideoArtifactsTab.jsx';
import SegmentsTab from '../components/creative-director/SegmentsTab.jsx';
import PlanTab from '../components/creative-director/PlanTab.jsx';
import RunsTab from '../components/creative-director/RunsTab.jsx';
import ActiveAgentsBanner from '../components/creative-director/ActiveAgentsBanner.jsx';
import CreativeDirectorModelsDrawer from '../components/creative-director/CreativeDirectorModelsDrawer.jsx';
import { getCosAgents } from '../services/apiAgents.js';
import { useSocketResource } from '../hooks/useSocketResource';
import { useValidTab } from '../hooks/useValidTab';
import useMediaJobProgress from '../hooks/useMediaJobProgress';
import { describeCreativeDirectorStatus } from '../lib/creativeDirectorStatus.js';

const PROJECT_EVENTS = ['creative-director:project:changed'];
const AGENT_EVENTS = ['cos:agent:spawned', 'cos:agent:completed', 'cos:agent:updated'];

const VIDEO_DRAFT_TABS = [{ id: 'overview', label: 'Overview', icon: LayoutList }, { id: 'review', label: 'Review', icon: Eye }, { id: 'artifacts', label: 'Artifacts', icon: Package }, { id: 'segments', label: 'Shots', icon: Film }, { id: 'runs', label: 'Runs', icon: ScrollText }];

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutList },
  { id: 'plan', label: 'Plan', icon: ClipboardList },
  { id: 'treatment', label: 'Treatment', icon: FileText },
  { id: 'segments', label: 'Segments', icon: Film },
  { id: 'runs', label: 'Runs', icon: ScrollText },
];

export default function CreativeDirectorDetail({ basePath = '/creative-director' } = {}) {
  const { id } = useParams();
  // Give each route identity its own state and callbacks, including confirmations
  // and child saves. A late callback from a prior visit cannot update this visit.
  return <CreativeDirectorProject key={id} id={id} basePath={basePath} />;
}

function CreativeDirectorProject({ id, basePath }) {
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const editingDraft = searchParams.get('draft') === '1';
  const setEditingDraft = open => setSearchParams(prev => { const next = new URLSearchParams(prev); if (open) next.set('draft', '1'); else next.delete('draft'); return next; }, { replace: true });
  const { data: project, loading, refetch: fetchProject, updateData: setProject } = useSocketResource(
    () => getCreativeDirectorProject(id, { silent: true }),
    { events: PROJECT_EVENTS, resourceKey: id, matchesEvent: event => event?.id === id },
  );
  const tabs = project?.workspace === 'video' ? VIDEO_DRAFT_TABS : TABS;
  const activeTab = useValidTab(tabs, 'overview');
  // Deep-linkable open state for the per-project AI models drawer (URL is the
  // source of truth for what's open, per the project convention).
  const modelsOpen = searchParams.get('models') === '1';
  const setModelsOpen = useCallback((next) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next) params.set('models', '1');
      else params.delete('models');
      return params;
    }, { replace: !next });
  }, [setSearchParams]);
  const { data: agents } = useSocketResource(
    async () => {
      const data = await getCosAgents();
      return (data || []).filter(a => a.status === 'running' && (a.taskId || '').startsWith(`cd-${id}-`));
    },
    { namespace: 'cos', events: AGENT_EVENTS, resourceKey: id,
      matchesEvent: event => (event?.taskId || '').startsWith(`cd-${id}-`) },
  );
  const activeAgents = agents || [];
  const [musicBedJobId, setMusicBedJobId] = useState(null);
  const musicBedToastedRef = useRef(null);
  const watchAsyncWork = useCallback(opts => {
    if (opts?.musicBedJobId) {
      musicBedToastedRef.current = null;
      setMusicBedJobId(opts.musicBedJobId);
    }
  }, []);

  // Toast the music-bed render's terminal state exactly once. Success is mostly
  // cosmetic (project events update the Music bed field), but confirms the
  // background render the user opted into actually landed; failure is the whole
  // point of #1933 — otherwise a crashed render is silently invisible.
  const musicBed = useMediaJobProgress(musicBedJobId, { kind: 'audio' });
  useEffect(() => {
    if (!musicBedJobId || musicBedToastedRef.current === musicBedJobId) return;
    if (musicBed.status === 'failed') {
      musicBedToastedRef.current = musicBedJobId;
      toast.error(`Music-bed render failed: ${musicBed.error || 'unknown error'}`);
      setMusicBedJobId(null);
    } else if (musicBed.status === 'completed') {
      musicBedToastedRef.current = musicBedJobId;
      toast.success('First-pass music bed ready');
      setMusicBedJobId(null);
    } else if (musicBed.status === 'canceled') {
      musicBedToastedRef.current = musicBedJobId;
      setMusicBedJobId(null);
    }
  }, [musicBedJobId, musicBed.status, musicBed.error]);

  // Stop is destructive and irreversible (SIGKILLs a live agent, cancels queued
  // GPU renders) and sits beside Pause, so it takes the same two-step confirm
  // every other destructive action in the app uses.
  const {
    isConfirming: isConfirmingStop,
    requestDelete: requestStop,
    cancelDelete: cancelStop,
    confirmDelete: confirmStop,
  } = useConfirmDelete();
  const {
    isConfirming: isConfirmingDelete,
    requestDelete,
    cancelDelete,
    confirmDelete,
  } = useConfirmDelete();
  const [deleting, setDeleting] = useState(false);

  const handleAction = async (kind) => {
    if (!active.current || project?.id !== id) return;
    // Map action → past-tense label and optimistic status up-front.
    const successMessages = {
      start: 'Started', pause: 'Paused', resume: 'Resumed',
      stop: 'Stopped — agent, tasks and queued renders torn down',
    };
    try {
      const actions = { start: startCreativeDirectorProject, pause: pauseCreativeDirectorProject,
        resume: resumeCreativeDirectorProject, stop: stopCreativeDirectorProject };
      const result = await actions[kind](id, { silent: true });
      if (!active.current) return;
      toast.success(successMessages[kind] || kind);
      if (result?.id === id) setProject(result);
      else if (result?.project?.id === id) setProject(result.project);
      else await fetchProject();
    } catch (err) {
      if (active.current) toast.error(err.message || `Failed to ${kind}`);
    }
  };

  const handleDelete = async () => {
    if (!active.current || project?.id !== id) return;
    setDeleting(true);
    try {
      await deleteCreativeDirectorProject(id, { silent: true });
      if (!active.current) return;
      toast.success('Creative Director project deleted');
      navigate(basePath);
    } catch (err) {
      if (!active.current) return;
      toast.error(err.message || 'Failed to delete project');
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <PageSkeleton
        header="bar"
        label="Loading creative director project"
        barClassName="px-6 pt-6 pb-3"
        titleWidthClass="w-56"
        showSubtitle
        subtitleOnMobile
        tabs={TABS.length}
        tabsInBar
        fullHeight
        padded
        bodyClassName="p-6"
        cards={3}
        sidebar={false}
      />
    );
  }
  if (!project || project.id !== id) return <div className="p-6 text-port-error">Project not found.</div>;

  const goTo = (tabId) => navigate(`${basePath}/${id}/${tabId}`);
  const status = describeCreativeDirectorStatus(project, { activeAgents: activeAgents.length, activeTab });
  const runNext = () => {
    switch (status.next?.id) {
      case 'start': case 'resume': return handleAction(status.next.id);
      case 'edit-draft': return setEditingDraft(true);
      case 'goto': return goTo(status.next.tab);
      case 'open-final': return navigate(`/media/history?selected=${encodeURIComponent(project.finalVideoId)}`);
      default: return undefined;
    }
  };
  // Every tab keeps the assembled cut in view once there is one; the Overview
  // renders it itself (with the "final assembly" placeholder before then).
  const showCutAbove = project.workspace === 'video' && activeTab !== 'overview' && !!(project.videoFinalCut || project.videoRoughCut)?.filename;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={Clapperboard}
        title={project.name}
        actions={<>
          <button onClick={() => setModelsOpen(true)} title="AI provider + model for this project's treatment, plan, and scene evaluation" className="flex items-center gap-1 px-2 py-1 bg-port-card border border-port-border rounded text-xs">
            <SlidersHorizontal className="w-3 h-3" /> Models
          </button>
          {!['paused', 'complete', 'failed', 'draft'].includes(project.status) && (
            <button onClick={() => handleAction('pause')} className="flex items-center gap-1 px-2 py-1 bg-port-card border border-port-border rounded text-xs">
              <Pause className="w-3 h-3" /> Pause
            </button>
          )}
          {!['complete', 'failed', 'draft'].includes(project.status) && (
            isConfirmingStop(project.id) ? (
              <ConfirmButtonPair
                prompt="Stop?"
                confirmText="Stop"
                ariaLabel={`Confirm stop project ${project.name}`}
                onConfirm={() => confirmStop(() => handleAction('stop'))}
                onCancel={cancelStop}
              />
            ) : (
              <button
                type="button"
                onClick={() => requestStop(project.id)}
                title="Stop: kill the running agent, retire its queued tasks, and cancel pending renders. Pause only stops NEW work being queued."
                aria-label={`Stop project ${project.name}`}
                className="flex items-center gap-1 px-2 py-1 bg-port-card border border-port-border rounded text-xs hover:text-port-error"
              >
                <Square className="w-3 h-3" /> Stop
              </button>
            )
          )}
          {isConfirmingDelete(project.id) ? (
            <ConfirmButtonPair
              prompt="Delete?"
              confirmText="Delete"
              ariaLabel={`Confirm delete project ${project.name}`}
              onConfirm={() => confirmDelete(handleDelete)}
              onCancel={cancelDelete}
            />
          ) : (
            <button
              type="button"
              onClick={() => requestDelete(project.id)}
              disabled={deleting}
              title={deleting ? 'Deleting Creative Director project…' : 'Delete this Creative Director project'}
              aria-label={`${deleting ? 'Deleting' : 'Delete'} project ${project.name}`}
              aria-busy={deleting}
              className="flex items-center gap-1 px-2 py-1 bg-port-card border border-port-border rounded text-xs hover:bg-port-error/20 hover:text-port-error disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" /> {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </>}
      />
      <div className="shrink-0 space-y-2 border-b border-port-border px-3 py-2 sm:px-4">
        <RecordStatusLine
          status={status}
          nextAction={status.next}
          onNextAction={runNext}
          leading={<Link to={basePath} aria-label="Back to projects" className="text-port-text-muted hover:text-port-text"><ArrowLeft className="w-4 h-4" /></Link>}
        />
        <TabPills tabs={tabs} activeTab={activeTab} onChange={goTo} mobileCompact ariaLabel="Video project sections" />
      </div>

      <div className="flex-1 overflow-auto p-6">
        {showCutAbove && <div className="mb-4"><VideoCutPanel project={project} /></div>}
        {project.workspace === 'video' && activeTab === 'review' && <VideoReviewPanel key={project.id} project={project} onChange={fetchProject} />}

        <ActiveAgentsBanner agents={activeAgents} />
        {project.workspace === 'video' && activeTab === 'overview' && <section className="space-y-4">
          <h2 className="text-lg font-medium">Video production</h2>
          <p className="text-port-text-muted">Start authorizes the saved choices within your limits. Enabled review checkpoints pause for your approval.</p>
          <p className="whitespace-pre-wrap">{project.userStory || 'Add a brief to describe this video.'}</p>
          <p className="text-sm">Exact target: {project.targetDurationSeconds} seconds (requested: {project.videoDraft?.durationRange?.min}–{project.videoDraft?.durationRange?.max} seconds) · {project.aspectRatio} · {project.quality}</p>
          <p className="text-sm">Review: {project.videoDraft?.reviewPolicy || 'review'} · Checkpoints: {(project.videoDraft?.checkpoints || []).join(', ')}</p>
          <VideoCutPanel project={project} />
          <VideoExecutionPanel key={project.id} project={project} onChange={fetchProject} basePath={basePath} />
        </section>}
        {project.workspace !== 'video' && activeTab === 'overview' && (
          <OverviewTab
            project={project}
            onProjectUpdate={(updates) => setProject((p) => p ? { ...p, ...updates } : p)}
            onAsyncWorkQueued={watchAsyncWork}
          />
        )}
        {project.workspace !== 'video' && activeTab === 'plan' && (
          <PlanTab
            project={project}
            onProjectUpdate={(updated) => setProject((p) => (p ? { ...p, ...updated } : updated))}
          />
        )}
        {project.workspace !== 'video' && activeTab === 'treatment' && <TreatmentTab project={project} />}
        {project.workspace === 'video' && activeTab === 'artifacts' && <VideoArtifactsTab project={project} basePath={basePath} />}
        {activeTab === 'segments' && <SegmentsTab project={project} activeAgents={activeAgents} basePath={basePath} onChange={fetchProject} />}
        {activeTab === 'runs' && <RunsTab project={project} />}
      </div>

      {/* Page-level, not inside the Overview: the status line's "Edit draft" opens it from any tab. */}
      {project.workspace === 'video' && <VideoDraftDrawer open={editingDraft} onClose={() => setEditingDraft(false)} project={project} onSaved={saved => setProject(prev => ({ ...prev, ...saved }))} />}

      <CreativeDirectorModelsDrawer
        open={modelsOpen}
        onClose={() => setModelsOpen(false)}
        project={project}
        onSaved={(modelOverrides) => setProject((p) => (p ? { ...p, modelOverrides } : p))}
      />
    </div>
  );
}
