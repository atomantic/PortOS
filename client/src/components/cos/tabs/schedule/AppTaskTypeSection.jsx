import AppTaskTypeRow from './AppTaskTypeRow';
import { TASK_FILTERS, DEFAULT_FILTER_ID } from './scheduleConstants';

export default function AppTaskTypeSection({ tasks, onUpdate, onTrigger, onReset, providers, apps, onUpdateOverride, onBulkToggleOverride, improvementDisabled, filter, onFilterChange }) {
  const taskEntries = Object.entries(tasks || {});
  if (taskEntries.length === 0) return null;

  const activeFilter = TASK_FILTERS.find(f => f.id === filter) || TASK_FILTERS[0];
  const allTaskTypes = taskEntries.map(([taskType]) => taskType);
  const visibleEntries = taskEntries.filter(activeFilter.match);
  const counts = Object.fromEntries(TASK_FILTERS.map(f => [f.id, taskEntries.filter(f.match).length]));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-lg font-semibold text-white">Improvement Tasks</h3>
        <div className="flex items-center gap-1 ml-auto">
          {TASK_FILTERS.map(f => {
            const active = activeFilter.id === f.id;
            return (
              <button
                key={f.id}
                onClick={() => onFilterChange(f.id)}
                aria-pressed={active}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors font-medium min-h-[40px] ${
                  active
                    ? 'bg-port-accent/10 text-port-accent'
                    : 'text-gray-400 hover:text-white hover:bg-port-border/50'
                }`}
              >
                {f.label} ({counts[f.id]})
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-sm text-gray-400">
        Tasks that analyze and improve PortOS and managed apps. Expand a task to configure per-app overrides.
      </p>
      {visibleEntries.length === 0 ? (
        <div className="text-center py-8 text-gray-500 border border-dashed border-port-border rounded-lg">
          {activeFilter.emptyMessage}{' '}
          {activeFilter.id !== DEFAULT_FILTER_ID && (
            <button onClick={() => onFilterChange(DEFAULT_FILTER_ID)} className="text-port-accent hover:underline">Show all</button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {visibleEntries.map(([taskType, config]) => (
            <AppTaskTypeRow
              key={taskType}
              taskType={taskType}
              config={config}
              onUpdate={onUpdate}
              onTrigger={onTrigger}
              onReset={onReset}
              providers={providers}
              apps={apps}
              onUpdateOverride={onUpdateOverride}
              onBulkToggleOverride={onBulkToggleOverride}
              allTaskTypes={allTaskTypes}
              improvementDisabled={improvementDisabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}
