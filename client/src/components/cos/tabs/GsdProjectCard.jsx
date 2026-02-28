import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import GsdConcernsPanel from './GsdConcernsPanel';
import PhaseTimeline from '../../gsd/PhaseTimeline';

export default function GsdProjectCard({ project, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadDetail = async () => {
    if (detail) return;
    setLoading(true);
    const data = await api.getGsdProject(project.appId).catch(err => {
      toast.error(err.message);
      return null;
    });
    setLoading(false);
    if (data) setDetail(data);
  };

  const handleExpand = () => {
    if (!expanded) loadDetail();
    setExpanded(!expanded);
  };

  const phaseCount = detail?.phases?.length || 0;
  const completedPhases = detail?.phases?.filter(p => p.status === 'completed').length || 0;

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
      <button
        onClick={handleExpand}
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold text-white truncate">{project.appName}</span>
          {project.hasRoadmap && (
            <span className="text-xs text-gray-500 font-mono shrink-0">
              {completedPhases}/{phaseCount} phases
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/apps/${project.appId}/gsd`}
            onClick={e => e.stopPropagation()}
            className="text-[10px] px-1.5 py-0.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 flex items-center gap-1"
          >
            Dashboard <ExternalLink size={10} />
          </Link>
          {project.hasConcerns && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-port-warning/20 text-port-warning">concerns</span>
          )}
          {expanded ? <ChevronUp size={16} className="text-gray-500" /> : <ChevronDown size={16} className="text-gray-500" />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-port-border/50 pt-3 space-y-4">
          {loading ? (
            <p className="text-xs text-gray-500">Loading project details...</p>
          ) : detail ? (
            <>
              {/* Phase Timeline */}
              {detail.phases && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">Phases</h4>
                  <PhaseTimeline phases={detail.phases} />
                </div>
              )}

              {/* Concerns */}
              {detail.concerns && (
                <GsdConcernsPanel
                  appId={project.appId}
                  concerns={detail.concerns}
                  onTaskCreated={onRefresh}
                />
              )}

              {/* State Info */}
              {detail.state?.frontmatter && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">State</h4>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {Object.entries(detail.state.frontmatter).map(([key, value]) => (
                      <div key={key} className="bg-port-bg rounded px-2 py-1">
                        <span className="text-gray-500">{key}:</span>{' '}
                        <span className="text-gray-300">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-gray-500">Failed to load project details</p>
          )}
        </div>
      )}
    </div>
  );
}
