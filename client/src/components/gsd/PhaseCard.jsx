import { useState } from 'react';
import { ChevronDown, ChevronRight, Play, CheckCircle, Circle, Clock, FileText, Search, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import MarkdownOutput from '../cos/MarkdownOutput';
import * as api from '../../services/api';

const STATUS_CONFIG = {
  completed: { color: 'bg-port-success', icon: CheckCircle, label: 'Completed' },
  executed: { color: 'bg-port-accent', icon: Clock, label: 'Executed' },
  planned: { color: 'bg-port-warning', icon: FileText, label: 'Planned' },
  unplanned: { color: 'bg-gray-600', icon: Circle, label: 'Pending' },
};

const ACTION_CONFIG = {
  plan: { label: 'Plan', icon: FileText, style: 'bg-port-warning/20 text-port-warning border-port-warning/30 hover:bg-port-warning/30' },
  execute: { label: 'Execute', icon: Play, style: 'bg-port-accent/20 text-port-accent border-port-accent/30 hover:bg-port-accent/30' },
  verify: { label: 'Verify', icon: ShieldCheck, style: 'bg-purple-600/20 text-purple-400 border-purple-600/30 hover:bg-purple-600/30' },
};

function getPhaseStatus(phase, pendingAction) {
  if (!pendingAction) return 'completed';
  return pendingAction.currentStep;
}

function formatPhaseName(id) {
  // "03-apple-health-integration" → "Apple Health Integration"
  const parts = id.split('-');
  const num = parts[0];
  const name = parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { num, name };
}

export default function PhaseCard({ phase, pendingAction, appId, expanded, onToggle }) {
  const [triggeringAction, setTriggeringAction] = useState(false);
  const [expandedPlan, setExpandedPlan] = useState(null);
  const [showResearch, setShowResearch] = useState(false);

  const status = getPhaseStatus(phase, pendingAction);
  const statusCfg = STATUS_CONFIG[status] || STATUS_CONFIG.unplanned;
  const StatusIcon = statusCfg.icon;
  const { num, name } = formatPhaseName(phase.id);
  const actionCfg = pendingAction ? ACTION_CONFIG[pendingAction.nextAction] : null;
  const progressPct = phase.totalTasks > 0 ? (phase.completedTasks / phase.totalTasks) * 100 : 0;

  const handleTriggerAction = async (e) => {
    e.stopPropagation();
    if (!pendingAction) return;
    setTriggeringAction(true);
    const result = await api.triggerGsdPhaseAction(appId, phase.id, pendingAction.nextAction).catch(() => null);
    setTriggeringAction(false);
    if (result) {
      toast.success(`${pendingAction.nextAction} task created for phase ${num}`);
    }
  };

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
      {/* Collapsed row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-3 hover:bg-port-border/20 transition-colors text-left"
      >
        {expanded ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />}
        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusCfg.color}`} title={statusCfg.label} />
        <span className="text-xs text-gray-500 font-mono w-6 shrink-0">{num}</span>
        <span className="text-sm text-gray-200 truncate flex-1">{name || phase.id}</span>

        {/* Progress bar */}
        {phase.totalTasks > 0 && (
          <div className="w-20 flex items-center gap-1.5 shrink-0">
            <div className="flex-1 h-1 bg-port-bg rounded-full overflow-hidden">
              <div className="h-full bg-port-success rounded-full" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="text-xs text-gray-500 w-8 text-right">{phase.completedTasks}/{phase.totalTasks}</span>
          </div>
        )}

        {/* Plan count badge */}
        {phase.plans?.length > 0 && (
          <span className="px-1.5 py-0.5 bg-port-bg border border-port-border rounded text-xs text-gray-400 shrink-0">
            {phase.plans.length} plan{phase.plans.length > 1 ? 's' : ''}
          </span>
        )}

        {/* Verification badge */}
        {phase.verification && (
          <span className={`px-1.5 py-0.5 rounded text-xs shrink-0 ${
            phase.verification.status === 'passed'
              ? 'bg-port-success/20 text-port-success'
              : 'bg-port-warning/20 text-port-warning'
          }`}>
            {phase.verification.score != null ? `${phase.verification.score}/10` : phase.verification.status}
          </span>
        )}

        {/* Next action button */}
        {actionCfg && (
          <button
            onClick={handleTriggerAction}
            disabled={triggeringAction}
            className={`px-2.5 py-1 rounded-lg text-xs flex items-center gap-1 border shrink-0 disabled:opacity-50 ${actionCfg.style}`}
          >
            <actionCfg.icon size={12} /> {triggeringAction ? 'Creating...' : actionCfg.label}
          </button>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-port-border p-4 space-y-4">
          {/* Sub-plans */}
          {phase.plans?.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Plans</h5>
              <div className="space-y-2">
                {phase.plans.map((plan, idx) => {
                  const isExpanded = expandedPlan === idx;
                  const planCompleted = plan.tasks.filter(t => t.completed).length;
                  return (
                    <div key={plan.filename} className="bg-port-bg border border-port-border rounded-lg overflow-hidden">
                      <button
                        onClick={() => setExpandedPlan(isExpanded ? null : idx)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-port-border/20"
                      >
                        {isExpanded ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
                        <span className="text-xs font-mono text-gray-400">{plan.filename}</span>
                        {plan.frontmatter?.phase && (
                          <span className="text-xs text-gray-500 truncate">{plan.frontmatter.phase}</span>
                        )}
                        <span className="ml-auto text-xs text-gray-500">{planCompleted}/{plan.tasks.length} tasks</span>
                      </button>
                      {isExpanded && (
                        <div className="px-3 pb-3 space-y-2">
                          {/* Frontmatter summary */}
                          {Object.keys(plan.frontmatter).length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {Object.entries(plan.frontmatter).slice(0, 6).map(([key, val]) => (
                                <span key={key} className="px-1.5 py-0.5 bg-port-card border border-port-border rounded text-xs text-gray-500">
                                  {key}: <span className="text-gray-300">{String(val).slice(0, 40)}</span>
                                </span>
                              ))}
                            </div>
                          )}
                          {/* Task checklist */}
                          {plan.tasks.length > 0 && (
                            <div className="space-y-1">
                              {plan.tasks.map((task, ti) => (
                                <div key={ti} className="flex items-start gap-2 text-xs">
                                  <span className={`mt-0.5 shrink-0 ${task.completed ? 'text-port-success' : 'text-gray-600'}`}>
                                    {task.completed ? '\u2611' : '\u2610'}
                                  </span>
                                  <span className={task.completed ? 'text-gray-500 line-through' : 'text-gray-300'}>{task.text}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Summaries */}
          {phase.summaries?.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Summaries</h5>
              <div className="space-y-2">
                {phase.summaries.map(summary => {
                  const metrics = summary.frontmatter;
                  return (
                    <div key={summary.filename} className="bg-port-bg border border-port-border rounded-lg px-3 py-2">
                      <span className="text-xs font-mono text-gray-400">{summary.filename}</span>
                      {metrics.duration && <span className="text-xs text-gray-500 ml-2">{metrics.duration}</span>}
                      {metrics.completed && <span className="text-xs text-gray-500 ml-2">{metrics.completed}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Verification */}
          {phase.verification && (
            <div>
              <h5 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Verification</h5>
              <div className="bg-port-bg border border-port-border rounded-lg px-3 py-2 flex items-center gap-3">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  phase.verification.status === 'passed' ? 'bg-port-success/20 text-port-success' : 'bg-port-warning/20 text-port-warning'
                }`}>
                  {phase.verification.status}
                </span>
                {phase.verification.score != null && (
                  <span className="text-xs text-gray-400">Score: {phase.verification.score}/10</span>
                )}
              </div>
            </div>
          )}

          {/* Research */}
          {phase.research && (
            <div>
              <button
                onClick={() => setShowResearch(!showResearch)}
                className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 hover:text-gray-300"
              >
                <Search size={12} />
                Research
                {showResearch ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              {showResearch && (
                <div className="bg-port-bg border border-port-border rounded-lg p-3 max-h-96 overflow-y-auto">
                  <MarkdownOutput content={phase.research.raw} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
