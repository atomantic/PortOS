import { useState } from 'react';
import { ChevronDown, ChevronRight, GitMerge } from 'lucide-react';
import { badge } from './scheduleConstants';
import IntervalBadge from './IntervalBadge';
import PipelineStageConfig from './PipelineStageConfig';
import GlobalConfigControls from './GlobalConfigControls';
import PerAppOverrideList from './PerAppOverrideList';

export default function AppTaskTypeRow({ taskType, config, onUpdate, onTrigger, onReset, providers, apps, onUpdateOverride, onBulkToggleOverride, allTaskTypes, improvementDisabled }) {
  const [expanded, setExpanded] = useState(false);
  const [updating, setUpdating] = useState(false);

  const enabledCount = config.enabledAppCount ?? 0;
  const totalCount = config.totalAppCount ?? 0;

  return (
    <div className="border border-port-border rounded-lg">
      <div
        className={`flex items-center gap-3 p-3 bg-port-card hover:bg-port-card/80 cursor-pointer ${expanded ? 'rounded-t-lg' : 'rounded-lg'}`}
        onClick={() => setExpanded(!expanded)}
      >
        <button
          className="text-gray-500 hover:text-white"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-white">{taskType}</span>
            {!config.enabled && (
              <span className={badge('gray')}>Disabled</span>
            )}
            {config.status?.reason === 'waiting-on-dependencies' && (
              <span className={badge('warning')} title={`Waiting for: ${config.status.pendingDeps?.join(', ')}`}>
                Waiting on deps
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
            {config.globalLastRun && (
              <span>Last run: {new Date(config.globalLastRun).toLocaleDateString()} ({config.globalRunCount || 0} total)</span>
            )}
            {config.runAfter?.length > 0 && (
              <span className="text-gray-500">after: {config.runAfter.join(', ')}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {config.taskMetadata?.pipeline?.stages?.length > 0 && (
            <span className={badge('purple')} title={config.taskMetadata.pipeline.stages.map(s => s.name).join(' → ')}>
              <GitMerge size={11} className="inline mr-1" />
              {config.taskMetadata.pipeline.stages.length}-stage
            </span>
          )}
          {totalCount > 0 && (
            <span className={badge(
              enabledCount === totalCount ? 'success' :
              enabledCount === 0 ? 'error' : 'warning'
            )}>
              {enabledCount}/{totalCount} apps
            </span>
          )}
          <IntervalBadge type={config.type} cronExpression={config.cronExpression} />
        </div>
      </div>

      {expanded && (
        <div className="p-4 border-t border-port-border bg-port-bg/50 space-y-6">
          {config.taskMetadata?.pipeline?.stages?.length > 0 && (
            <PipelineStageConfig
              taskType={taskType}
              config={config}
              providers={providers}
              onUpdate={onUpdate}
              updating={updating}
              setUpdating={setUpdating}
            />
          )}

          <div>
            <h4 className="text-sm font-medium text-gray-400 mb-3">Global Defaults</h4>
            <GlobalConfigControls
              taskType={taskType}
              config={config}
              onUpdate={onUpdate}
              onTrigger={onTrigger}
              onReset={onReset}
              category="appImprovement"
              providers={providers}
              apps={apps}
              updating={updating}
              setUpdating={setUpdating}
              allTaskTypes={allTaskTypes}
              improvementDisabled={improvementDisabled}
            />
          </div>

          <PerAppOverrideList
            taskType={taskType}
            config={config}
            apps={apps}
            onUpdateOverride={onUpdateOverride}
            onBulkToggleOverride={onBulkToggleOverride}
          />
        </div>
      )}
    </div>
  );
}
