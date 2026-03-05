import { Play, Pause, Square, Zap, Clock, Target, GitBranch, AlertTriangle } from 'lucide-react';
import { STATUS_COLORS, STATUS_BG, PRIORITY_COLORS, SCHEDULE_LABELS, AUTONOMY_LABELS } from './constants';

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function OverviewTab({ agent, onStart, onPause, onResume, onStop, onTrigger }) {
  const statusColor = STATUS_COLORS[agent.status] || 'text-gray-400';
  const statusBg = STATUS_BG[agent.status] || 'bg-gray-400/10';

  return (
    <div className="space-y-6">
      {/* Status + Actions */}
      <div className="bg-port-card border border-port-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1 text-sm px-3 py-1 rounded-full font-medium ${statusColor} ${statusBg}`}>
              {agent.status}
            </span>
            <span className={`text-sm ${PRIORITY_COLORS[agent.priority]}`}>{agent.priority} priority</span>
            <span className="text-sm text-gray-500">{AUTONOMY_LABELS[agent.autonomyLevel] || agent.autonomyLevel}</span>
          </div>
          <div className="flex items-center gap-2">
            {agent.status === 'draft' && (
              <button onClick={() => onStart(agent.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-port-success bg-port-success/10 hover:bg-port-success/20 rounded-lg transition-colors">
                <Play size={14} /> Activate
              </button>
            )}
            {agent.status === 'active' && (
              <>
                <button onClick={() => onTrigger(agent.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-port-accent bg-port-accent/10 hover:bg-port-accent/20 rounded-lg transition-colors">
                  <Zap size={14} /> Trigger Run
                </button>
                <button onClick={() => onPause(agent.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-port-warning bg-port-warning/10 hover:bg-port-warning/20 rounded-lg transition-colors">
                  <Pause size={14} /> Pause
                </button>
              </>
            )}
            {agent.status === 'paused' && (
              <button onClick={() => onResume(agent.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-port-success bg-port-success/10 hover:bg-port-success/20 rounded-lg transition-colors">
                <Play size={14} /> Resume
              </button>
            )}
            {(agent.status === 'active' || agent.status === 'paused') && (
              <button onClick={() => onStop(agent.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:bg-port-border/50 rounded-lg transition-colors">
                <Square size={14} /> Stop
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-gray-500 mb-1">Total Runs</div>
            <div className="text-lg font-bold text-white">{agent.runCount || 0}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">Last Run</div>
            <div className="text-sm text-white">{timeAgo(agent.lastRunAt)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">Schedule</div>
            <div className="text-sm text-white">{SCHEDULE_LABELS[agent.schedule?.mode] || 'Continuous'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">Created</div>
            <div className="text-sm text-white">{timeAgo(agent.createdAt)}</div>
          </div>
        </div>

        {agent.backoff && (
          <div className="mt-4 flex items-center gap-2 text-sm text-port-warning bg-port-warning/10 rounded-lg px-3 py-2">
            <AlertTriangle size={14} />
            <span>Backoff active: {Math.round(agent.backoff.currentDelayMs / 60000)}min delay ({agent.backoff.consecutiveIdles} consecutive idle runs)</span>
          </div>
        )}
      </div>

      {/* Persona */}
      {agent.persona && (
        <div className="bg-port-card border border-port-border rounded-xl p-5">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Persona</h3>
          <p className="text-sm text-gray-300 whitespace-pre-wrap">{agent.persona}</p>
        </div>
      )}

      {/* Goals */}
      <div className="bg-port-card border border-port-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Target size={16} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Goals</h3>
        </div>
        {agent.goals?.length > 0 ? (
          <ul className="space-y-2">
            {agent.goals.map((goal, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                <span className="text-port-accent mt-0.5">-</span>
                <span>{goal}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-600">No goals defined</p>
        )}
      </div>

      {/* Feature Scope + Git */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-port-card border border-port-border rounded-xl p-5">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Feature Scope</h3>
          <div className="space-y-2 text-sm">
            {agent.featureScope?.directories?.length > 0 && (
              <div>
                <span className="text-gray-500">Directories: </span>
                <span className="text-gray-300">{agent.featureScope.directories.join(', ')}</span>
              </div>
            )}
            {agent.featureScope?.filePatterns?.length > 0 && (
              <div>
                <span className="text-gray-500">Patterns: </span>
                <span className="text-gray-300">{agent.featureScope.filePatterns.join(', ')}</span>
              </div>
            )}
            {agent.featureScope?.excludePatterns?.length > 0 && (
              <div>
                <span className="text-gray-500">Exclude: </span>
                <span className="text-gray-300">{agent.featureScope.excludePatterns.join(', ')}</span>
              </div>
            )}
            {!agent.featureScope?.directories?.length && !agent.featureScope?.filePatterns?.length && (
              <p className="text-gray-600">No scope restrictions (full repo)</p>
            )}
          </div>
        </div>

        <div className="bg-port-card border border-port-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <GitBranch size={16} className="text-port-accent" />
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Git</h3>
          </div>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-gray-500">Branch: </span>
              <span className="text-gray-300 font-mono">{agent.git?.branchName}</span>
            </div>
            <div>
              <span className="text-gray-500">Base: </span>
              <span className="text-gray-300 font-mono">{agent.git?.baseBranch || 'main'}</span>
            </div>
            <div>
              <span className="text-gray-500">Auto merge base: </span>
              <span className="text-gray-300">{agent.git?.autoMergeBase !== false ? 'yes' : 'no'}</span>
            </div>
            <div>
              <span className="text-gray-500">Auto PR: </span>
              <span className="text-gray-300">{agent.git?.autoPR !== false ? 'yes' : 'no'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Runs */}
      {agent.recentRuns?.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={16} className="text-port-accent" />
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Recent Runs</h3>
          </div>
          <div className="space-y-2">
            {agent.recentRuns.map((run, i) => (
              <div key={i} className="flex items-center gap-3 text-sm py-1.5 border-b border-port-border last:border-0">
                <span className={`text-xs px-2 py-0.5 rounded ${
                  run.status === 'working' ? 'bg-port-success/10 text-port-success' :
                  run.status === 'idle-no-work' ? 'bg-port-warning/10 text-port-warning' :
                  'bg-port-error/10 text-port-error'
                }`}>
                  {run.status}
                </span>
                <span className="text-gray-400 flex-1 truncate">{run.summary || 'No summary'}</span>
                <span className="text-gray-600 shrink-0">{timeAgo(run.completedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
