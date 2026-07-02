import { useState } from 'react';
import Drawer from '../../../Drawer';
import useDrawerTab from '../../../../hooks/useDrawerTab';
import TaskHeader from './TaskHeader';
import PipelineStageConfig from './PipelineStageConfig';
import GlobalConfigControls from './GlobalConfigControls';
import PerAppOverrideList from './PerAppOverrideList';

// Slide-over panel holding the full configuration for a single task.
// Receives the live config object so it re-renders against the freshest
// schedule after each onUpdate refetch.
//
// The (formerly page-length) config is split into deep-linkable tabs so no
// single section runs off the bottom of the drawer:
//   - Stage config      — per-stage provider/model (only when the task has a
//                         pipeline; count = number of stages)
//   - Global defaults   — schedule/provider/prompt controls (always present)
//   - Per-app overrides — per-app enablement (only when there are active apps;
//                         count = number of active apps)
// The active tab lives in the `taskTab` URL param so it survives reload and is
// shareable. TaskHeader (identity + badges) stays at the top of every tab.
export default function TaskConfigDrawer({
  open,
  taskType,
  config,
  onClose,
  onUpdate,
  onTrigger,
  onReset,
  providers,
  apps,
  onUpdateOverride,
  onBulkToggleOverride,
  allTaskTypes,
  improvementDisabled,
}) {
  const [updating, setUpdating] = useState(false);

  const stages = config?.taskMetadata?.pipeline?.stages || [];
  const hasStages = stages.length > 0;
  const activeApps = apps?.filter(app => !app.archived) || [];
  const hasOverrides = activeApps.length > 0;

  // Tabs are dynamic: a task without a pipeline hides Stage config, and an
  // install with no active apps hides Per-app overrides — never an empty tab.
  const tabs = [
    hasStages && { id: 'stages', label: 'Stage config', count: stages.length },
    { id: 'global', label: 'Global defaults' },
    hasOverrides && { id: 'overrides', label: 'Per-app overrides', count: activeApps.length },
  ].filter(Boolean);
  const tabIds = tabs.map(t => t.id);
  const defaultTab = hasStages ? 'stages' : 'global';
  const [activeTab, setActiveTab] = useDrawerTab('taskTab', defaultTab, tabIds);

  return (
    <Drawer
      open={open && !!config}
      onClose={onClose}
      title={taskType || 'Task'}
      size="md"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      // Don't allow an Esc keystroke to discard a config change mid-save.
      closeOnEsc={!updating}
    >
      {config && (
        <div className="space-y-6">
          <TaskHeader taskType={taskType} config={config} />

          {activeTab === 'stages' && hasStages && (
            <PipelineStageConfig
              taskType={taskType}
              config={config}
              providers={providers}
              onUpdate={onUpdate}
              updating={updating}
              setUpdating={setUpdating}
            />
          )}

          {activeTab === 'global' && (
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
          )}

          {activeTab === 'overrides' && hasOverrides && (
            <PerAppOverrideList
              taskType={taskType}
              config={config}
              apps={apps}
              onUpdateOverride={onUpdateOverride}
              onBulkToggleOverride={onBulkToggleOverride}
            />
          )}
        </div>
      )}
    </Drawer>
  );
}
