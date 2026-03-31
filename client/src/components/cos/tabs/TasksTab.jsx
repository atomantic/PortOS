import { useState, useEffect, useMemo } from 'react';
import { Play, ChevronDown, ChevronRight } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import * as api from '../../../services/api';
import TaskItem from './TaskItem';
import SortableTaskItem from './SortableTaskItem';
import TaskAddForm from '../TaskAddForm';

export default function TasksTab({ tasks, onRefresh, providers, apps }) {
  const [userTasksLocal, setUserTasksLocal] = useState([]);
  const [durations, setDurations] = useState(null);
  const [showCompletedUserTasks, setShowCompletedUserTasks] = useState(false);
  const [showCompletedSystemTasks, setShowCompletedSystemTasks] = useState(false);

  // Fetch task duration estimates
  useEffect(() => {
    api.getCosLearningDurations()
      .then(setDurations)
      .catch(() => setDurations(null));
  }, []);

  // Memoize task arrays to prevent unnecessary re-renders
  const userTasks = useMemo(() => tasks.user?.tasks || [], [tasks.user?.tasks]);
  const cosTasks = useMemo(() => tasks.cos?.tasks || [], [tasks.cos?.tasks]);
  const awaitingApproval = useMemo(() => tasks.cos?.awaitingApproval || [], [tasks.cos?.awaitingApproval]);

  // Split tasks by status for system tasks
  const pendingSystemTasks = useMemo(() =>
    cosTasks.filter(t => t.status === 'pending'),
    [cosTasks]
  );
  const activeSystemTasks = useMemo(() =>
    cosTasks.filter(t => t.status === 'in_progress'),
    [cosTasks]
  );
  const blockedSystemTasks = useMemo(() =>
    cosTasks.filter(t => t.status === 'blocked'),
    [cosTasks]
  );
  const completedSystemTasks = useMemo(() =>
    cosTasks.filter(t => t.status === 'completed'),
    [cosTasks]
  );

  // Split user tasks by status (only pending tasks are sortable)
  const pendingUserTasksLocal = useMemo(() =>
    userTasksLocal.filter(t => t.status === 'pending'),
    [userTasksLocal]
  );
  const activeUserTasksLocal = useMemo(() =>
    userTasksLocal.filter(t => t.status === 'in_progress'),
    [userTasksLocal]
  );
  const blockedUserTasksLocal = useMemo(() =>
    userTasksLocal.filter(t => t.status === 'blocked'),
    [userTasksLocal]
  );
  const completedUserTasksLocal = useMemo(() =>
    userTasksLocal.filter(t => t.status === 'completed'),
    [userTasksLocal]
  );

  // Memoize sortable item IDs for DndContext (only pending tasks)
  const sortableIds = useMemo(() =>
    pendingUserTasksLocal.map(t => t.id),
    [pendingUserTasksLocal]
  );

  // Keep local state in sync with server state
  useEffect(() => {
    setUserTasksLocal(userTasks);
  }, [userTasks]);

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = userTasksLocal.findIndex(t => t.id === active.id);
    const newIndex = userTasksLocal.findIndex(t => t.id === over.id);

    // Optimistically update local state
    const newOrder = arrayMove(userTasksLocal, oldIndex, newIndex);
    setUserTasksLocal(newOrder);

    // Persist to server
    const taskIds = newOrder.map(t => t.id);
    const result = await api.reorderCosTasks(taskIds).catch(err => {
      toast.error(err.message);
      setUserTasksLocal(userTasks); // Revert on error
      return null;
    });
    if (result?.success) {
      toast.success('Tasks reordered');
      onRefresh();
    }
  };

  return (
    <div className="space-y-6">
      {/* User Tasks */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-white">User Tasks (TASKS.md)</h3>
          <button
            onClick={async () => {
              await api.forceCosEvaluate().catch(err => toast.error(err.message));
              toast.success('Evaluation triggered');
            }}
            className="flex items-center gap-1 text-sm bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 px-3 py-1.5 rounded-lg transition-colors"
            aria-label="Run tasks now"
          >
            <Play size={16} aria-hidden="true" />
            Run Now
          </button>
        </div>

        {/* Add Task Form */}
        <TaskAddForm providers={providers} apps={apps} onTaskAdded={onRefresh} />

        {/* User Tasks Sections */}
        {pendingUserTasksLocal.length === 0 && activeUserTasksLocal.length === 0 && blockedUserTasksLocal.length === 0 && completedUserTasksLocal.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No user tasks. Add one above or edit TASKS.md directly.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Pending Section */}
            {pendingUserTasksLocal.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-yellow-500/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-yellow-500">
                    Pending ({pendingUserTasksLocal.length})
                  </span>
                </div>
                <div className="p-2">
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={sortableIds}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-1.5">
                        {pendingUserTasksLocal.map(task => (
                          <SortableTaskItem key={task.id} task={task} onRefresh={onRefresh} providers={providers} durations={durations} apps={apps} />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </div>
              </div>
            )}

            {/* Active Section */}
            {activeUserTasksLocal.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-port-accent/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-port-accent">
                    Active ({activeUserTasksLocal.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {activeUserTasksLocal.map(task => (
                    <TaskItem key={task.id} task={task} onRefresh={onRefresh} providers={providers} durations={durations} apps={apps} />
                  ))}
                </div>
              </div>
            )}

            {/* Blocked Section */}
            {blockedUserTasksLocal.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-port-error/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-port-error">
                    Blocked ({blockedUserTasksLocal.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {blockedUserTasksLocal.map(task => (
                    <TaskItem key={task.id} task={task} onRefresh={onRefresh} providers={providers} durations={durations} apps={apps} />
                  ))}
                </div>
              </div>
            )}

            {/* Completed Section - Collapsible */}
            {completedUserTasksLocal.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <button
                  onClick={() => setShowCompletedUserTasks(!showCompletedUserTasks)}
                  className="w-full px-3 py-2 bg-port-success/10 border-b border-port-border flex items-center justify-between hover:bg-port-success/20 transition-colors"
                  aria-expanded={showCompletedUserTasks}
                >
                  <span className="text-sm font-medium text-port-success flex items-center gap-2">
                    {showCompletedUserTasks ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                    Completed ({completedUserTasksLocal.length})
                  </span>
                </button>
                {showCompletedUserTasks && (
                  <div className="p-2 space-y-1.5">
                    {completedUserTasksLocal.map(task => (
                      <TaskItem key={task.id} task={task} onRefresh={onRefresh} providers={providers} durations={durations} apps={apps} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* System Tasks */}
      <div>
        <h3 className="text-lg font-semibold text-white mb-3">System Tasks (COS-TASKS.md)</h3>

        {/* System Tasks Sections */}
        {pendingSystemTasks.length === 0 && activeSystemTasks.length === 0 && blockedSystemTasks.length === 0 && completedSystemTasks.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No system tasks.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Pending Section */}
            {pendingSystemTasks.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-yellow-500/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-yellow-500">
                    Pending ({pendingSystemTasks.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {pendingSystemTasks.map(task => (
                    <TaskItem key={task.id} task={task} isSystem onRefresh={onRefresh} providers={providers} durations={durations} apps={apps} />
                  ))}
                </div>
              </div>
            )}

            {/* Active Section */}
            {activeSystemTasks.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-port-accent/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-port-accent">
                    Active ({activeSystemTasks.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {activeSystemTasks.map(task => (
                    <TaskItem key={task.id} task={task} isSystem onRefresh={onRefresh} providers={providers} durations={durations} apps={apps} />
                  ))}
                </div>
              </div>
            )}

            {/* Blocked Section */}
            {blockedSystemTasks.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-port-error/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-port-error">
                    Blocked ({blockedSystemTasks.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {blockedSystemTasks.map(task => (
                    <TaskItem key={task.id} task={task} isSystem onRefresh={onRefresh} providers={providers} durations={durations} apps={apps} />
                  ))}
                </div>
              </div>
            )}

            {/* Completed Section - Collapsible */}
            {completedSystemTasks.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <button
                  onClick={() => setShowCompletedSystemTasks(!showCompletedSystemTasks)}
                  className="w-full px-3 py-2 bg-port-success/10 border-b border-port-border flex items-center justify-between hover:bg-port-success/20 transition-colors"
                  aria-expanded={showCompletedSystemTasks}
                >
                  <span className="text-sm font-medium text-port-success flex items-center gap-2">
                    {showCompletedSystemTasks ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                    Completed ({completedSystemTasks.length})
                  </span>
                </button>
                {showCompletedSystemTasks && (
                  <div className="p-2 space-y-1.5">
                    {completedSystemTasks.map(task => (
                      <TaskItem key={task.id} task={task} isSystem onRefresh={onRefresh} providers={providers} durations={durations} apps={apps} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Awaiting Approval */}
      {awaitingApproval.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-yellow-500 mb-3">Awaiting Approval</h3>
          <div className="space-y-2">
            {awaitingApproval.map(task => (
              <TaskItem key={task.id} task={task} awaitingApproval onRefresh={onRefresh} providers={providers} durations={durations} apps={apps} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
