import { useState } from 'react';
import Drawer from '../../../Drawer';
import TaskHeader from './TaskHeader';
import PipelineStageConfig from './PipelineStageConfig';
import GlobalConfigControls from './GlobalConfigControls';
import PerAppOverrideList from './PerAppOverrideList';

// Slide-over panel holding the full configuration for a single task.
// Receives the live config object so it re-renders against the freshest
// schedule after each onUpdate refetch.
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

  return (
    <Drawer
      open={open && !!config}
      onClose={onClose}
      title={taskType || 'Task'}
      widthClass="sm:w-[560px]"
      closeOnEsc={!updating}
    >
      {config && (
        <div className="space-y-6">
          <TaskHeader taskType={taskType} config={config} />

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
    </Drawer>
  );
}
