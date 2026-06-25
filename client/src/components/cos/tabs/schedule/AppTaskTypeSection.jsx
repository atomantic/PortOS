import { useState } from 'react';
import { Search, X } from 'lucide-react';
import AppTaskCard from './AppTaskCard';
import { TASK_FILTERS, DEFAULT_FILTER_ID, taskSortKey } from './scheduleConstants';

export default function AppTaskTypeSection({ tasks, apps, onTrigger, onSelectTask, improvementDisabled, filter, onFilterChange }) {
  const [search, setSearch] = useState('');
  const taskEntries = Object.entries(tasks || {});

  const activeFilter = TASK_FILTERS.find(f => f.id === filter) || TASK_FILTERS[0];
  const counts = Object.fromEntries(TASK_FILTERS.map(f => [f.id, taskEntries.filter(f.match).length]));

  const query = search.trim().toLowerCase();
  const visibleEntries = taskEntries
    .filter(activeFilter.match)
    .filter(([taskType]) => !query || taskType.toLowerCase().includes(query))
    .sort(([aType, aConfig], [bType, bConfig]) => {
      const a = taskSortKey(aType, aConfig);
      const b = taskSortKey(bType, bConfig);
      return a.order - b.order || a.next - b.next || a.taskType.localeCompare(b.taskType);
    });

  if (taskEntries.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-lg font-semibold text-white">Improvement Tasks</h3>
        <div className="flex items-center gap-1 ml-auto flex-wrap">
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
        Tasks that analyze and improve PortOS and managed apps. Click a card to configure schedule and per-app overrides.
      </p>

      <div className="relative max-w-sm">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter tasks by name…"
          aria-label="Filter tasks by name"
          className="w-full bg-port-card border border-port-border rounded-lg pl-9 pr-9 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent/50"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label="Clear filter"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-white"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {visibleEntries.length === 0 ? (
        <div className="text-center py-8 text-gray-500 border border-dashed border-port-border rounded-lg">
          {query
            ? <>No tasks match “{search.trim()}”. <button onClick={() => setSearch('')} className="text-port-accent hover:underline">Clear filter</button></>
            : <>{activeFilter.emptyMessage}{' '}
                {activeFilter.id !== DEFAULT_FILTER_ID && (
                  <button onClick={() => onFilterChange(DEFAULT_FILTER_ID)} className="text-port-accent hover:underline">Show all</button>
                )}</>}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {visibleEntries.map(([taskType, config]) => (
            <AppTaskCard
              key={taskType}
              taskType={taskType}
              config={config}
              apps={apps}
              onTrigger={onTrigger}
              onConfigure={onSelectTask}
              improvementDisabled={improvementDisabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}
