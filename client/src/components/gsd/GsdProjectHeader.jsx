import { RefreshCw, Terminal, Play, Settings } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';

const STATUS_COLORS = {
  active: 'bg-port-accent text-port-accent',
  completed: 'bg-port-success text-port-success',
  paused: 'bg-port-warning text-port-warning',
};

export default function GsdProjectHeader({ project, pendingActions, appId, repoPath, onRefresh }) {
  const state = project?.state?.frontmatter || {};
  const phases = project?.phases || [];
  const completedPhases = phases.filter(p => p.totalTasks > 0 && p.completedTasks === p.totalTasks && p.verification?.status === 'passed').length;
  const phasesWithPlans = phases.filter(p => p.plans?.length > 0).length;
  const milestoneStatus = state.milestone_status || state.status || 'active';
  const milestoneName = state.current_milestone || state.milestone || 'Current Milestone';
  const projectName = project?.app?.name || appId;
  const mode = project?.config?.mode || state.mode;
  const depth = project?.config?.depth || state.depth;

  const handleOpenClaude = async () => {
    toast('Opening Claude Code...');
    await api.openAppInClaude(appId).catch(() => null);
  };

  const handleNewMilestone = async () => {
    await api.addCosTask({
      description: 'Run /gsd:new-milestone to start a new milestone cycle',
      app: appId,
      priority: 'MEDIUM',
    }).catch(() => null);
    toast.success('New milestone task created');
  };

  const statusStyle = STATUS_COLORS[milestoneStatus] || STATUS_COLORS.active;
  const allPhasesComplete = completedPhases === phases.length && phases.length > 0;

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h3 className="text-lg font-semibold text-white truncate">{projectName}</h3>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium bg-opacity-20 ${statusStyle}`}>
              {milestoneStatus}
            </span>
          </div>
          {milestoneName && (
            <p className="text-sm text-gray-400 mb-3">{milestoneName}</p>
          )}

          {/* Progress bars */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>Phases</span>
                <span>{completedPhases}/{phases.length}</span>
              </div>
              <div className="h-1.5 bg-port-bg rounded-full overflow-hidden">
                <div
                  className="h-full bg-port-success rounded-full transition-all"
                  style={{ width: phases.length ? `${(completedPhases / phases.length) * 100}%` : '0%' }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>Planned</span>
                <span>{phasesWithPlans}/{phases.length}</span>
              </div>
              <div className="h-1.5 bg-port-bg rounded-full overflow-hidden">
                <div
                  className="h-full bg-port-accent rounded-full transition-all"
                  style={{ width: phases.length ? `${(phasesWithPlans / phases.length) * 100}%` : '0%' }}
                />
              </div>
            </div>
          </div>

          {/* Config badges */}
          {(mode || depth) && (
            <div className="flex gap-2 mt-3">
              {mode && (
                <span className="px-2 py-0.5 bg-port-bg border border-port-border rounded text-xs text-gray-400 flex items-center gap-1">
                  <Settings size={10} /> {mode}
                </span>
              )}
              {depth && (
                <span className="px-2 py-0.5 bg-port-bg border border-port-border rounded text-xs text-gray-400">
                  depth: {depth}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {allPhasesComplete && (
            <button
              onClick={handleNewMilestone}
              className="px-3 py-1.5 bg-port-success/20 hover:bg-port-success/30 text-port-success rounded-lg text-xs flex items-center gap-1 border border-port-success/30"
            >
              <Play size={14} /> New Milestone
            </button>
          )}
          {repoPath && (
            <button
              onClick={handleOpenClaude}
              className="px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 rounded-lg text-xs flex items-center gap-1 border border-purple-600/30"
            >
              <Terminal size={14} /> Claude Code
            </button>
          )}
          <button
            onClick={onRefresh}
            className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
