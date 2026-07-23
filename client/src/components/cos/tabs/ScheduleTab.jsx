import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, RefreshCw } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import { formatDateTime } from '../../../utils/formatters';
import Banner from '../../ui/Banner';
import { CodeReviewDefaultsProvider } from '../../../hooks/useCodeReviewDefaults';
import { useAppOverrideActions } from '../../../hooks/useAppOverrideActions';
import AppTaskTypeSection from './schedule/AppTaskTypeSection';
import TaskConfigDrawer from './schedule/TaskConfigDrawer';
import { TASK_FILTERS, DEFAULT_FILTER_ID } from './schedule/scheduleConstants';

// `providers` is owned by ChiefOfStaff (30s poll, see useAutoRefetch there) and
// passed down — same convention as TasksTab/AgentsTab — so this tab's provider/
// model pickers stay live without standing up a second independent poll of the
// same data.
export default function ScheduleTab({ apps, providers }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);

  const filterParam = searchParams.get('filter');
  const filter = TASK_FILTERS.some(f => f.id === filterParam) ? filterParam : DEFAULT_FILTER_ID;
  const setFilter = useCallback((next) => {
    const params = new URLSearchParams(searchParams);
    if (next === DEFAULT_FILTER_ID) params.delete('filter');
    else params.set('filter', next);
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  // The open config drawer is deep-linkable via ?task= per the URL-param convention.
  const selectedTask = searchParams.get('task');
  const setSelectedTask = useCallback((next) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('task', next);
    else params.delete('task');
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const fetchSchedule = useCallback(async () => {
    const data = await api.getCosSchedule().catch(() => null);
    setSchedule(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  const handleUpdateTask = async (taskType, settings) => {
    const result = await api.updateCosTaskInterval(taskType, settings, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Updated ${taskType} interval`);
      fetchSchedule();
    }
  };

  const handleTriggerTask = async (taskType, appId = null) => {
    const result = await api.triggerCosOnDemandTask(taskType, appId, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Triggered ${taskType} task${appId ? ' for app' : ''} - will run on next evaluation`);
      fetchSchedule();
    }
  };

  const handleResetTask = async (taskType) => {
    const result = await api.resetCosTaskHistory(taskType, null, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Reset execution history for ${taskType}`);
      fetchSchedule();
    }
  };

  const handleTriggerAppImprovement = (taskType, appId) => handleTriggerTask(taskType, appId);

  const { handleUpdateOverride, handleBulkToggleOverride } = useAppOverrideActions(apps, fetchSchedule);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading schedule...</div>
      </div>
    );
  }

  if (!schedule) {
    return (
      <div className="text-center py-8 text-gray-500">
        <AlertCircle className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>Failed to load task schedule</p>
      </div>
    );
  }

  const improvementDisabled = schedule.improvementEnabled === false;
  const tasks = schedule.tasks || schedule.appImprovement || schedule.selfImprovement || {};
  const allTaskTypes = Object.keys(tasks);
  const selectedConfig = selectedTask ? tasks[selectedTask] : null;

  return (
    <CodeReviewDefaultsProvider>
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Task Schedule</h2>
          <p className="text-sm text-gray-400 mt-1">
            Configure how often each task type runs.
          </p>
        </div>
        <button
          onClick={fetchSchedule}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
          title="Refresh schedule"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {improvementDisabled && (
        <Banner size="md" icon={AlertCircle} title="Improvement is disabled">
          <div className="text-xs text-port-warning/80 mt-1">
            No scheduled or on-demand improvement tasks will run. Enable the <span className="font-mono">Improve</span> toggle in
            {' '}<a href="/cos/config" className="underline hover:text-port-warning">CoS → Config</a> to use this page.
          </div>
        </Banner>
      )}

      {schedule.onDemandRequests?.length > 0 && (
        <Banner tone="info" size="lg" title="Pending On-Demand Tasks">
          <div className="space-y-1 mt-2">
            {schedule.onDemandRequests.map(req => (
              <div key={req.id} className="text-sm text-gray-300">
                {req.taskType}{req.appId ? ` (${req.appId})` : ''} - requested {new Date(req.requestedAt).toLocaleTimeString()}
              </div>
            ))}
          </div>
        </Banner>
      )}

      <AppTaskTypeSection
        tasks={tasks}
        apps={apps}
        onTrigger={handleTriggerAppImprovement}
        onSelectTask={setSelectedTask}
        improvementDisabled={improvementDisabled}
        filter={filter}
        onFilterChange={setFilter}
      />

      {schedule.lastUpdated && (
        <div className="text-xs text-gray-500 text-right">
          Schedule last updated: {formatDateTime(schedule.lastUpdated)}
        </div>
      )}

      <TaskConfigDrawer
        open={!!selectedConfig}
        taskType={selectedTask}
        config={selectedConfig}
        onClose={() => setSelectedTask(null)}
        onUpdate={handleUpdateTask}
        onTrigger={handleTriggerAppImprovement}
        onReset={handleResetTask}
        providers={providers}
        apps={apps}
        onUpdateOverride={handleUpdateOverride}
        onBulkToggleOverride={handleBulkToggleOverride}
        allTaskTypes={allTaskTypes}
        improvementDisabled={improvementDisabled}
      />
    </div>
    </CodeReviewDefaultsProvider>
  );
}
