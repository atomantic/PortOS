import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Play, Pause, RefreshCw } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getCreativeDirectorProject,
  startCreativeDirectorProject,
  pauseCreativeDirectorProject,
  resumeCreativeDirectorProject,
} from '../services/apiCreativeDirector.js';
import OverviewTab from '../components/creative-director/OverviewTab.jsx';
import TreatmentTab from '../components/creative-director/TreatmentTab.jsx';
import SegmentsTab from '../components/creative-director/SegmentsTab.jsx';
import RunsTab from '../components/creative-director/RunsTab.jsx';
import ActiveAgentsBanner from '../components/creative-director/ActiveAgentsBanner.jsx';
import { getCosAgents } from '../services/apiAgents.js';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { useValidTab } from '../hooks/useValidTab';

const TERMINAL_PROJECT_STATUSES = new Set(['complete', 'failed', 'paused', 'draft']);

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'treatment', label: 'Treatment' },
  { id: 'segments', label: 'Segments' },
  { id: 'runs', label: 'Runs' },
];

export default function CreativeDirectorDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'overview');
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeAgents, setActiveAgents] = useState([]);
  // Extends polling past the terminal-status gate below for a bounded window
  // after the Overview tab queues a first-pass portrait/music-bed render
  // (#1818/#1928) — those attach asynchronously to a catalog ingredient or
  // `project.musicBed` without changing the project's lifecycle status, so a
  // still-'draft' project (no compose flip to escape TERMINAL_PROJECT_STATUSES)
  // would otherwise never pick up the result without a manual Refresh.
  const [pendingAsyncWork, setPendingAsyncWork] = useState(false);
  const pendingAsyncWorkTimerRef = useRef(null);
  const extendPollingForAsyncWork = useCallback(() => {
    setPendingAsyncWork(true);
    clearTimeout(pendingAsyncWorkTimerRef.current);
    // 3 minutes covers a cold model load + render for the local image/audio
    // gen backends in the common case; if it runs longer the user can still
    // hit the manual Refresh button. Not tied to a job-completion signal —
    // this component has no socket/SSE channel into the media job queue.
    pendingAsyncWorkTimerRef.current = setTimeout(() => setPendingAsyncWork(false), 3 * 60 * 1000);
  }, []);
  useEffect(() => () => clearTimeout(pendingAsyncWorkTimerRef.current), []);

  const fetchProject = useCallback(async () => {
    const p = await getCreativeDirectorProject(id).catch(() => null);
    setProject(p);
    setLoading(false);
    return null;
  }, [id]);

  // Poll CoS agents in parallel so the Segments tab can flag the scene that's
  // currently being worked on, even before the agent PATCHes its status.
  // Filter by `taskId` prefix `cd-<projectId>-` (agentBridge's id scheme).
  const fetchAgents = useCallback(async () => {
    const data = await getCosAgents().catch(() => []);
    const prefix = `cd-${id}-`;
    const mine = (data || []).filter((a) => a.status === 'running' && (a.taskId || '').startsWith(prefix));
    setActiveAgents(mine);
    return null;
  }, [id]);

  // Only poll while the agent could still mutate the project. Once the
  // status reaches a terminal state, the visibility-paused hook stops firing
  // — except during the bounded `pendingAsyncWork` window above, which
  // overrides the terminal gate so a queued first-pass render still surfaces.
  const pollEnabled = !project?.status || !TERMINAL_PROJECT_STATUSES.has(project.status) || pendingAsyncWork;
  const poll = useCallback(async () => {
    await Promise.all([fetchProject(), fetchAgents()]);
    return null;
  }, [fetchProject, fetchAgents]);
  const { refetch: refetchPoll } = useAutoRefetch(poll, 5000, { enabled: pollEnabled });

  // Reset state ONLY when the route id changes, so navigating between
  // projects (or hitting an error fetch) clears the prior project — but
  // the 5s poll interval below doesn't keep nulling-and-re-setting the
  // same project (which previously coupled with the `project?.status`
  // dep on the polling effect to produce a tight refetch loop). Refetch
  // immediately on id change so a project swap doesn't leave the previous
  // project on screen for up to one tick.
  useEffect(() => {
    setLoading(true);
    setProject(null);
    // A pending-async-work window is per-project intent — don't carry it
    // across a route swap (the new project has its own poll-gate state).
    setPendingAsyncWork(false);
    clearTimeout(pendingAsyncWorkTimerRef.current);
    refetchPoll();
  }, [id, refetchPoll]);

  const handleAction = async (kind) => {
    // Map action → past-tense label and optimistic status up-front.
    const successMessages = { start: 'Started', pause: 'Paused', resume: 'Resumed' };
    // Optimistic status: start kicks off planning or rendering depending on
    // whether a treatment exists; the 5s poll will correct it if the server
    // resolves to a different status (e.g. planning → rendering).
    const optimisticStatus = kind === 'pause' ? 'paused'
      : kind === 'resume' ? (project?.treatment ? 'rendering' : 'planning')
      : kind === 'start' ? (project?.treatment ? 'rendering' : 'planning')
      : null;
    try {
      if (kind === 'start') await startCreativeDirectorProject(id);
      else if (kind === 'pause') await pauseCreativeDirectorProject(id);
      else if (kind === 'resume') await resumeCreativeDirectorProject(id);
      toast.success(successMessages[kind] || kind);
      if (optimisticStatus) setProject((p) => p ? { ...p, status: optimisticStatus } : p);
    } catch (err) {
      toast.error(err.message || `Failed to ${kind}`);
    }
  };

  if (loading) return <div className="p-6 text-port-text-muted">Loading…</div>;
  if (!project) return <div className="p-6 text-port-error">Project not found.</div>;

  const goTo = (tabId) => navigate(`/media/creative-director/${id}/${tabId}`);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-6 pt-6 pb-3 border-b border-port-border">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link to="/media/creative-director" className="text-port-text-muted hover:text-port-text"><ArrowLeft className="w-4 h-4" /></Link>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold truncate">{project.name}</h1>
              <div className="text-xs text-port-text-muted truncate">
                {project.id} • status: <span className="text-port-text">{project.status}</span>
              </div>
            </div>
          </div>
          <div className="flex gap-1">
            <button onClick={fetchProject} className="flex items-center gap-1 px-2 py-1 bg-port-card border border-port-border rounded text-xs">
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
            {(project.status === 'draft' || project.status === 'failed') && (
              <button onClick={() => handleAction('start')} className="flex items-center gap-1 px-2 py-1 bg-port-accent/30 text-port-accent rounded text-xs">
                <Play className="w-3 h-3" /> Start
              </button>
            )}
            {project.status === 'paused' && (
              <button onClick={() => handleAction('resume')} className="flex items-center gap-1 px-2 py-1 bg-port-accent/30 text-port-accent rounded text-xs">
                <Play className="w-3 h-3" /> Resume
              </button>
            )}
            {!['paused', 'complete', 'failed', 'draft'].includes(project.status) && (
              <button onClick={() => handleAction('pause')} className="flex items-center gap-1 px-2 py-1 bg-port-card border border-port-border rounded text-xs">
                <Pause className="w-3 h-3" /> Pause
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-1 mt-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => goTo(t.id)}
              className={`px-3 py-1.5 text-sm rounded ${activeTab === t.id ? 'bg-port-accent/30 text-port-accent' : 'text-port-text-muted hover:text-port-text'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <ActiveAgentsBanner agents={activeAgents} />
        {activeTab === 'overview' && (
          <OverviewTab
            project={project}
            onProjectUpdate={(updates) => setProject((p) => p ? { ...p, ...updates } : p)}
            onAsyncWorkQueued={extendPollingForAsyncWork}
          />
        )}
        {activeTab === 'treatment' && <TreatmentTab project={project} />}
        {activeTab === 'segments' && <SegmentsTab project={project} activeAgents={activeAgents} />}
        {activeTab === 'runs' && <RunsTab project={project} />}
      </div>
    </div>
  );
}
