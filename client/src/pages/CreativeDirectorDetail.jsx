import { useEffect, useState, useCallback } from 'react';
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

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'treatment', label: 'Treatment' },
  { id: 'segments', label: 'Segments' },
  { id: 'runs', label: 'Runs' },
];

const VALID_TAB_IDS = new Set(TABS.map((t) => t.id));

export default function CreativeDirectorDetail() {
  const { id, tab } = useParams();
  const navigate = useNavigate();
  const activeTab = VALID_TAB_IDS.has(tab) ? tab : 'overview';
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeAgents, setActiveAgents] = useState([]);

  const fetchProject = useCallback(() => {
    getCreativeDirectorProject(id)
      .then((p) => { setProject(p); setLoading(false); })
      .catch(() => { setProject(null); setLoading(false); });
  }, [id]);

  // Reset state ONLY when the route id changes, so navigating between
  // projects (or hitting an error fetch) clears the prior project — but
  // the 5s poll interval below doesn't keep nulling-and-re-setting the
  // same project (which previously coupled with the `project?.status`
  // dep on the polling effect to produce a tight refetch loop).
  useEffect(() => {
    setLoading(true);
    setProject(null);
  }, [id]);

  // Poll CoS agents in parallel so the Segments tab can flag the scene that's
  // currently being worked on, even before the agent PATCHes its status.
  // Filter by `taskId` prefix `cd-<projectId>-` (agentBridge's id scheme).
  const fetchAgents = useCallback(() => {
    getCosAgents()
      .then((data) => {
        const prefix = `cd-${id}-`;
        const mine = (data || []).filter((a) => a.status === 'running' && (a.taskId || '').startsWith(prefix));
        setActiveAgents(mine);
      })
      .catch(() => setActiveAgents([]));
  }, [id]);

  useEffect(() => {
    fetchProject();
    fetchAgents();
    // Only poll while the agent could still mutate the project. Once the
    // status reaches a terminal state, skip the interval entirely so we're
    // not constantly tearing down and rebuilding it on every refetch.
    const status = project?.status;
    if (status && ['complete', 'failed', 'paused', 'draft'].includes(status)) return;
    const interval = setInterval(() => { fetchProject(); fetchAgents(); }, 5000);
    return () => clearInterval(interval);
  }, [fetchProject, fetchAgents, project?.status]);

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
        {activeTab === 'overview' && <OverviewTab project={project} />}
        {activeTab === 'treatment' && <TreatmentTab project={project} />}
        {activeTab === 'segments' && <SegmentsTab project={project} activeAgents={activeAgents} />}
        {activeTab === 'runs' && <RunsTab project={project} />}
      </div>
    </div>
  );
}
