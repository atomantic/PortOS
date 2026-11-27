import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Shield, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Link } from 'react-router';
import ConfirmButtonPair from '../../../ui/ConfirmButtonPair';
import { runsLabel } from './learningPresentation';

function ResolveAllButton({ resettingType, resettingAll, onResetAll }) {
  const [confirming, setConfirming] = useState(false);

  return confirming ? (
    <ConfirmButtonPair
      prompt="Re-enable auto-approval?"
      confirmText="Reset and resolve all"
      tone="warning"
      busy={resettingAll || !!resettingType}
      busyText={resettingAll ? 'Resolving all…' : undefined}
      onCancel={() => setConfirming(false)}
      onConfirm={async () => {
        await onResetAll();
        setConfirming(false);
      }}
      className="flex-wrap self-start sm:self-auto"
    />
  ) : (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      disabled={resettingAll || !!resettingType}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-port-success/10 hover:bg-port-success/20 text-port-success border border-port-success/30 rounded transition-colors disabled:opacity-50 shrink-0 self-start sm:self-auto min-h-[32px] pointer-coarse:min-h-11"
      title="Mark all resolved — reset learning data to re-enable auto-approval"
    >
      <Check size={12} aria-hidden="true" />
      Mark all resolved
    </button>
  );
}

export default function LearningConfidenceSection({ confidence, expanded, onToggle, resettingType, resettingAll, onResetTaskType, onResetAll }) {
  if (!confidence?.summary) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left mb-3"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <Shield size={16} className="text-port-accent" />
        <span className="font-medium text-white">Confidence & Autonomy</span>
        <span className="text-xs text-gray-500">
          ({confidence.summary.total} task types)
        </span>
        {confidence.summary.requireApproval > 0 && (
          <span className="text-xs bg-port-warning/20 text-port-warning px-1.5 py-0.5 rounded ml-auto">
            {confidence.summary.requireApproval} require approval
          </span>
        )}
      </button>
      {expanded && (
        <div className="space-y-3">
          {/* Confidence Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="bg-port-card border border-port-success/30 rounded-lg p-3 text-center">
              <ShieldCheck size={16} className="text-port-success mx-auto mb-1" />
              <div className="text-lg font-bold text-port-success">{confidence.summary.high}</div>
              <div className="text-xs text-gray-500">High Confidence</div>
            </div>
            <div className="bg-port-card border border-port-accent/30 rounded-lg p-3 text-center">
              <Shield size={16} className="text-port-accent mx-auto mb-1" />
              <div className="text-lg font-bold text-port-accent">{confidence.summary.medium}</div>
              <div className="text-xs text-gray-500">Medium</div>
            </div>
            <div className="bg-port-card border border-port-warning/30 rounded-lg p-3 text-center">
              <ShieldAlert size={16} className="text-port-warning mx-auto mb-1" />
              <div className="text-lg font-bold text-port-warning">{confidence.summary.low}</div>
              <div className="text-xs text-gray-500">Low (Approval)</div>
            </div>
            <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
              <ShieldQuestion size={16} className="text-gray-400 mx-auto mb-1" />
              <div className="text-lg font-bold text-gray-400">{confidence.summary.new}</div>
              <div className="text-xs text-gray-500">New (No Data)</div>
            </div>
          </div>

          {/* Thresholds Info */}
          <div className="text-xs text-gray-500 bg-port-card border border-port-border rounded-lg px-3 py-2">
            Thresholds: High &ge; {confidence.thresholds.highThreshold}% &middot; Low &lt; {confidence.thresholds.lowThreshold}% &middot; Min samples: {confidence.thresholds.minSamples}
          </div>

          {[
            { items: confidence.levels.low, borderClass: 'border-port-warning/30', bgClass: 'bg-port-warning/10', textClass: 'text-port-warning', Icon: ShieldAlert, title: 'Requires Approval', desc: 'These task types have low success rates and will require human approval before spawning. Reset metrics to mark resolved and re-enable auto-approval.' },
            { items: confidence.levels.high, borderClass: 'border-port-success/30', bgClass: 'bg-port-success/10', textClass: 'text-port-success', Icon: ShieldCheck, title: 'High Confidence', desc: 'Consistently successful — auto-approved without hesitation' }
          ].filter(g => g.items?.length > 0).map(({ items, borderClass, bgClass, textClass, Icon, title, desc }) => (
            <div key={title} className={`bg-port-card border ${borderClass} rounded-lg overflow-hidden`}>
              <div className={`px-4 py-2 ${bgClass} border-b border-port-border flex flex-col sm:flex-row sm:items-center justify-between gap-2`}>
                <div>
                  <span className={`text-sm font-medium ${textClass} flex items-center gap-2`}>
                    <Icon size={14} />
                    {title} ({items.length})
                  </span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {desc}
                    {title === 'Requires Approval' && (
                      <> &middot; Review pending tasks on the <Link to="/cos/tasks" className="text-port-accent hover:underline">Tasks tab</Link>.</>
                    )}
                  </p>
                </div>
                {title === 'Requires Approval' && items.length > 1 && (
                  <ResolveAllButton resettingType={resettingType} resettingAll={resettingAll} onResetAll={onResetAll} />
                )}
              </div>
              <div className="divide-y divide-port-border">
                {items.map((t) => (
                  <div key={t.taskType} className="px-4 py-2 flex items-center justify-between">
                    <span className="text-sm text-gray-300 font-mono">{t.taskType}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500">{runsLabel(t)}</span>
                      <span className={`text-sm ${textClass} font-medium`}>{t.successRate}%</span>
                      {title === 'Requires Approval' && (
                        <button
                          type="button"
                          onClick={() => onResetTaskType(t.taskType)}
                          disabled={resettingType === t.taskType || resettingAll}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-port-success/10 hover:bg-port-success/20 text-port-success border border-port-success/30 rounded transition-colors disabled:opacity-50 min-h-[32px]"
                          title={`Mark ${t.taskType} resolved — reset learning metrics to restore auto-approval`}
                          aria-label={`Mark ${t.taskType} resolved`}
                        >
                          <Check size={12} className={resettingType === t.taskType ? 'animate-spin' : ''} />
                          {resettingType === t.taskType ? 'Resolving…' : 'Mark resolved'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
