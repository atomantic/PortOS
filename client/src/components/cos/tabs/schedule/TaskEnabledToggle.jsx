import { AlertCircle } from 'lucide-react';
import ToggleSwitch from '../../../ToggleSwitch';
import Banner from '../../../ui/Banner';
import InfoTooltip from '../../../ui/InfoTooltip';

// Global Pause row: the switch is on while the task is paused.
export default function TaskEnabledToggle({ edit, updating }) {
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-gray-400">Global Pause</span>
          <InfoTooltip label="What does Global Pause do?">
            When paused, no scheduled runs will execute for this task — even if individual apps are enabled.
          </InfoTooltip>
        </div>
        <ToggleSwitch
          enabled={edit.isPaused}
          onChange={edit.handleToggleEnabled}
          disabled={updating}
          ariaLabel={edit.isPaused ? 'Resume runs' : 'Pause all runs'}
        />
      </div>
      {edit.isPaused && (
        <Banner icon={AlertCircle} align="center">
          All scheduled runs are paused for this task
        </Banner>
      )}
    </>
  );
}
