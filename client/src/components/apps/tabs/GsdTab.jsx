import { useState, useEffect } from 'react';
import { RefreshCw, Compass } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../../BrailleSpinner';
import PhaseTimeline from '../../gsd/PhaseTimeline';
import GsdConcernsPanel from '../../cos/tabs/GsdConcernsPanel';
import * as api from '../../../services/api';

export default function GsdTab({ appId }) {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const fetchProject = async () => {
    setLoading(true);
    // Use silent fetch to avoid toast errors on 404
    const resp = await fetch(`/api/cos/gsd/projects/${appId}`).catch(() => null);
    if (resp?.ok) {
      const data = await resp.json().catch(() => null);
      setProject(data);
      setNotFound(!data);
    } else {
      setNotFound(true);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchProject();
  }, [appId]);

  if (loading) {
    return <BrailleSpinner text="Loading GSD project" />;
  }

  if (notFound) {
    return (
      <div className="max-w-5xl">
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <Compass size={32} className="text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 mb-2">No GSD project initialized</p>
          <p className="text-sm text-gray-500 mb-4">
            This app does not have a <code className="text-cyan-400">.planning/</code> directory yet.
          </p>
          <p className="text-xs text-gray-500">
            Run <code className="text-cyan-400">/gsd:new-project</code> in Claude Code from the app's repo to initialize GSD project tracking.
          </p>
        </div>
      </div>
    );
  }

  const phaseCount = project?.phases?.length || 0;
  const completedPhases = project?.phases?.filter(p => p.status === 'completed').length || 0;

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">GSD Project</h3>
          <p className="text-sm text-gray-500">{completedPhases}/{phaseCount} phases completed</p>
        </div>
        <button
          onClick={fetchProject}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Phase Timeline */}
      {project?.phases && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Phases</h4>
          <PhaseTimeline phases={project.phases} />
        </div>
      )}

      {/* Concerns */}
      {project?.concerns && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <GsdConcernsPanel
            appId={appId}
            concerns={project.concerns}
            onTaskCreated={fetchProject}
          />
        </div>
      )}

      {/* State Frontmatter */}
      {project?.state?.frontmatter && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">State</h4>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {Object.entries(project.state.frontmatter).map(([key, value]) => (
              <div key={key} className="bg-port-bg rounded px-2 py-1">
                <span className="text-gray-500">{key}:</span>{' '}
                <span className="text-gray-300">{String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
