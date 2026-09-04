import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
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
import TaskItem, { taskRowId } from './TaskItem';
import SortableTaskItem from './SortableTaskItem';
import TaskAddForm from '../TaskAddForm';
import { MicroGlyph, SchematicLabel } from '../../micrographics';
import useAssignableInstances from '../../../hooks/useAssignableInstances';

// Maps a task-section status → micrographic glyph spec. Animation only on
// states where motion communicates real work happening (running tasks).
const SECTION_GLYPH = {
  pending:    { variant: 'pulse-dot',   state: 'warn',    animated: false },
  active:     { variant: 'scan',        state: 'accent',  animated: true  },
  blocked:    { variant: 'warning-tri', state: 'error',   animated: false },
  completed:  { variant: 'check-tick',  state: 'success', animated: false },
};

function SectionGlyph({ status }) {
  const spec = SECTION_GLYPH[status];
  if (!spec) return null;
  return <MicroGlyph variant={spec.variant} state={spec.state} animated={spec.animated} size={13} />;
}

export default function TasksTab({ tasks, agents = [], onRefresh, onTaskAdded, onTaskUnblocked, providers, providersLoaded, apps }) {
  const [searchParams] = useSearchParams();
  const [userTasksLocal, setUserTasksLocal] = useState([]);
  const [durations, setDurations] = useState(null);
  const [showCompletedUserTasks, setShowCompletedUserTasks] = useState(false);
  const [showCompletedSystemTasks, setShowCompletedSystemTasks] = useState(false);
  // Fetched once for the whole list (#4520) — every row renders its instance pin
  // from this, so a long backlog never issues one request per task.
  const { instances: assignableInstances } = useAssignableInstances();

  // Fetch task duration estimates
  useEffect(() => {
    api.getCosLearningDurations()
      .then(setDurations)
      .catch(() => setDurations(null));
  }, []);

  // Memoize task arrays to prevent unnecessary re-renders
  const userTasks = useMemo(() => tasks.user?.tasks || [], [tasks.user?.tasks]);
  const cosTasks = useMemo(() => tasks.cos?.tasks || [], [tasks.cos?.tasks]);
  const selectedTaskId = searchParams.get('task');
  const requestedSource = searchParams.get('source');
  const selectedTaskSource = useMemo(() => {
    if (!selectedTaskId) return null;
    if (requestedSource === 'user' || requestedSource === 'internal') return requestedSource;
    if (userTasks.some((task) => task.id === selectedTaskId)) return 'user';
    if (cosTasks.some((task) => task.id === selectedTaskId)) return 'internal';
    return null;
  }, [cosTasks, requestedSource, selectedTaskId, userTasks]);
  const isTaskSelected = (task, source) => (
    task.id === selectedTaskId && source === selectedTaskSource
  );

  // The live agent working each task, keyed by task id. spawnAgentForTask registers its
  // agent as running BEFORE flipping the task off 'pending', so between those
  // two writes a task reads 'pending' on the task list and 'running' on the
  // agent list — and the row showed up under Pending AND as an active agent.
  // Defense in depth, not the whole fix: ChiefOfStaff now subscribes to the
  // store's task events so the flip lands in ~400ms instead of a 30s poll. This
  // settles the render from whichever of the two signals arrived first, so the
  // split is right even when an event is delayed or dropped.
  // The map (rather than a Set of ids) is what lets an Active row offer a relaunch
  // onto a different provider/model without fetching the agent list of its own.
  const runningAgentByTaskId = useMemo(() => new Map(
    agents.filter(a => a.status === 'running' && a.taskId).map(a => [a.taskId, a])
  ), [agents]);

  const isSpawning = useCallback(
    (task) => task.status === 'pending' && runningAgentByTaskId.has(task.id),
    [runningAgentByTaskId]
  );

  // Split tasks by status for system tasks
  const pendingSystemTasks = useMemo(() =>
    cosTasks.filter(t => t.status === 'pending' && !isSpawning(t)),
    [cosTasks, isSpawning]
  );
  const activeSystemTasks = useMemo(() =>
    cosTasks.filter(t => t.status === 'in_progress' || isSpawning(t)),
    [cosTasks, isSpawning]
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
    userTasksLocal.filter(t => t.status === 'pending' && !isSpawning(t)),
    [userTasksLocal, isSpawning]
  );
  const activeUserTasksLocal = useMemo(() =>
    userTasksLocal.filter(t => t.status === 'in_progress' || isSpawning(t)),
    [userTasksLocal, isSpawning]
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

  // Queue summary links identify one concrete task. Completed sections are
  // collapsed by default, so open the relevant one before attempting to focus
  // and center the row.
  useEffect(() => {
    if (!selectedTaskId || !selectedTaskSource) return;
    const selected = (selectedTaskSource === 'user' ? userTasks : cosTasks)
      .find((task) => task.id === selectedTaskId);
    if (selected?.status !== 'completed') return;
    if (selectedTaskSource === 'user') setShowCompletedUserTasks(true);
    else setShowCompletedSystemTasks(true);
  }, [cosTasks, selectedTaskId, selectedTaskSource, userTasks]);

  useEffect(() => {
    if (!selectedTaskId || !selectedTaskSource) return;
    const row = document.getElementById(taskRowId(selectedTaskId, selectedTaskSource));
    if (!row) return;
    row.scrollIntoView?.({ block: 'center' });
    row.focus({ preventScroll: true });
  }, [
    cosTasks,
    selectedTaskId,
    selectedTaskSource,
    showCompletedSystemTasks,
    showCompletedUserTasks,
    userTasksLocal,
  ]);

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
    const result = await api.reorderCosTasks(taskIds, { silent: true }).catch(err => {
      toast.error(err.message);
      setUserTasksLocal(userTasks); // Revert on error
      return null;
    });
    if (result?.success) {
      toast.success('Tasks reordered');
      onRefresh();
    }
  };

  const handleTaskAdded = useCallback((task, options) => {
    onTaskAdded?.(task, options);
    // Keep the established authoritative refresh for agent/status data. The
    // parent has already inserted the task above, so this can never make a
    // successful submission appear to disappear while the refresh is pending.
    onRefresh();
  }, [onRefresh, onTaskAdded]);

  return (
    <div className="space-y-6">
      {/* User Tasks */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-white">User Tasks (TASKS.md)</h3>
          <button
            onClick={async () => {
              // Only toast success after the evaluate request resolves.
              try {
                await api.forceCosEvaluate({ silent: true });
                toast.success('Evaluation triggered');
              } catch (err) {
                toast.error(err.message);
              }
            }}
            className="flex items-center gap-1 text-sm bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 px-3 py-1.5 rounded-lg transition-colors"
            aria-label="Run tasks now"
          >
            <Play size={16} aria-hidden="true" />
            Run Now
          </button>
        </div>

        {/* Add Task Form */}
        <TaskAddForm providers={providers} providersLoaded={providersLoaded} apps={apps} onTaskAdded={handleTaskAdded} />

        {/* User Tasks Sections */}
        {pendingUserTasksLocal.length === 0 && activeUserTasksLocal.length === 0 && blockedUserTasksLocal.length === 0 && completedUserTasksLocal.length === 0 ? (
          <div className="relative bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            <SchematicLabel module="USER" status="EMPTY" glyph="bracket-pair" state="idle" variant="tab" />
            No user tasks. Add one above or edit TASKS.md directly.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Pending Section */}
            {pendingUserTasksLocal.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-yellow-500/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-yellow-500 flex items-center gap-2">
                    <SectionGlyph status="pending" />
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
                          <SortableTaskItem key={task.id} task={task} selected={isTaskSelected(task, 'user')} onRefresh={onRefresh} providers={providers} providersLoaded={providersLoaded} durations={durations} apps={apps} instances={assignableInstances} />
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
                  <span className="text-sm font-medium text-port-accent flex items-center gap-2">
                    <SectionGlyph status="active" />
                    Active ({activeUserTasksLocal.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {activeUserTasksLocal.map(task => (
                    <TaskItem key={task.id} task={task} agent={runningAgentByTaskId.get(task.id)} spawning={isSpawning(task)} selected={isTaskSelected(task, 'user')} onRefresh={onRefresh} onTaskUnblocked={onTaskUnblocked} providers={providers} providersLoaded={providersLoaded} durations={durations} apps={apps} instances={assignableInstances} />
                  ))}
                </div>
              </div>
            )}

            {/* Blocked Section */}
            {blockedUserTasksLocal.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-port-error/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-port-error flex items-center gap-2">
                    <SectionGlyph status="blocked" />
                    Blocked ({blockedUserTasksLocal.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {blockedUserTasksLocal.map(task => (
                    <TaskItem key={task.id} task={task} selected={isTaskSelected(task, 'user')} onRefresh={onRefresh} onTaskUnblocked={onTaskUnblocked} providers={providers} providersLoaded={providersLoaded} durations={durations} apps={apps} instances={assignableInstances} />
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
                    <SectionGlyph status="completed" />
                    Completed ({completedUserTasksLocal.length})
                  </span>
                </button>
                {showCompletedUserTasks && (
                  <div className="p-2 space-y-1.5">
                    {completedUserTasksLocal.map(task => (
                      <TaskItem key={task.id} task={task} selected={isTaskSelected(task, 'user')} onRefresh={onRefresh} onTaskUnblocked={onTaskUnblocked} providers={providers} providersLoaded={providersLoaded} durations={durations} apps={apps} instances={assignableInstances} />
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
          <div className="relative bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            <SchematicLabel module="COS" status="EMPTY" glyph="bracket-pair" state="idle" variant="tab" />
            No system tasks.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Pending Section */}
            {pendingSystemTasks.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-yellow-500/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-yellow-500 flex items-center gap-2">
                    <SectionGlyph status="pending" />
                    Pending ({pendingSystemTasks.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {pendingSystemTasks.map(task => (
                    <TaskItem key={task.id} task={task} isSystem selected={isTaskSelected(task, 'internal')} onRefresh={onRefresh} onTaskUnblocked={onTaskUnblocked} providers={providers} providersLoaded={providersLoaded} durations={durations} apps={apps} instances={assignableInstances} />
                  ))}
                </div>
              </div>
            )}

            {/* Active Section */}
            {activeSystemTasks.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-port-accent/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-port-accent flex items-center gap-2">
                    <SectionGlyph status="active" />
                    Active ({activeSystemTasks.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {activeSystemTasks.map(task => (
                    <TaskItem key={task.id} task={task} isSystem agent={runningAgentByTaskId.get(task.id)} spawning={isSpawning(task)} selected={isTaskSelected(task, 'internal')} onRefresh={onRefresh} onTaskUnblocked={onTaskUnblocked} providers={providers} providersLoaded={providersLoaded} durations={durations} apps={apps} instances={assignableInstances} />
                  ))}
                </div>
              </div>
            )}

            {/* Blocked Section */}
            {blockedSystemTasks.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-port-error/10 border-b border-port-border flex items-center justify-between">
                  <span className="text-sm font-medium text-port-error flex items-center gap-2">
                    <SectionGlyph status="blocked" />
                    Blocked ({blockedSystemTasks.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {blockedSystemTasks.map(task => (
                    <TaskItem key={task.id} task={task} isSystem selected={isTaskSelected(task, 'internal')} onRefresh={onRefresh} onTaskUnblocked={onTaskUnblocked} providers={providers} providersLoaded={providersLoaded} durations={durations} apps={apps} instances={assignableInstances} />
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
                    <SectionGlyph status="completed" />
                    Completed ({completedSystemTasks.length})
                  </span>
                </button>
                {showCompletedSystemTasks && (
                  <div className="p-2 space-y-1.5">
                    {completedSystemTasks.map(task => (
                      <TaskItem key={task.id} task={task} isSystem selected={isTaskSelected(task, 'internal')} onRefresh={onRefresh} onTaskUnblocked={onTaskUnblocked} providers={providers} providersLoaded={providersLoaded} durations={durations} apps={apps} instances={assignableInstances} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
