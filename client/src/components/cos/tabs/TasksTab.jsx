import { usePagedCollection } from '../../../hooks/usePagedCollection';
import InfiniteScrollFooter from '../../ui/InfiniteScrollFooter';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
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
import { formatCount } from '../../../utils/formatters';
import { runningAgentsByTaskId, isSpawningTask } from '../../../lib/cosSpawnWindow';
import { retryHoldOwnerId } from '../../../../../server/lib/taskRetryHold.js';
import { isTruthyMeta } from '../../../../../server/lib/metadataFlags.js';
import BrailleSpinner from '../../BrailleSpinner';

// Maps a task-section status → micrographic glyph spec. Animation only on
// states where motion communicates real work happening (running tasks).
const SECTION_GLYPH = {
  pending:    { variant: 'pulse-dot',   state: 'warn',    animated: false },
  active:     { variant: 'scan',        state: 'accent',  animated: true  },
  unconfirmed:{ variant: 'warning-tri', state: 'warn',    animated: false },
  blocked:    { variant: 'warning-tri', state: 'error',   animated: false },
  completed:  { variant: 'check-tick',  state: 'success', animated: false },
};

function SectionGlyph({ status }) {
  const spec = SECTION_GLYPH[status];
  if (!spec) return null;
  return <MicroGlyph variant={spec.variant} state={spec.state} animated={spec.animated} size={13} />;
}

const SECTION_LABELS = { pending: 'Pending', active: 'Active', unconfirmed: 'Activity unconfirmed', blocked: 'Blocked', completed: 'Completed' };
const SECTION_STYLES = {
  pending: { text: 'text-port-warning', background: 'bg-port-warning/10' },
  active: { text: 'text-port-accent', background: 'bg-port-accent/10' },
  unconfirmed: { text: 'text-port-warning', background: 'bg-port-warning/10' },
  blocked: { text: 'text-port-error', background: 'bg-port-error/10' },
  completed: { text: 'text-port-success', background: 'bg-port-success/10' },
};

function QueueSectionHeader({ section, count, expanded, onToggle }) {
  const style = SECTION_STYLES[section];
  const label = <span className={`text-sm font-medium ${style.text} flex items-center gap-2`}>
    {section === 'completed' && (expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />)}
    <SectionGlyph status={section} />
    {SECTION_LABELS[section]} ({count})
  </span>;
  return <div className={`bg-port-card border border-port-border rounded-lg ${style.background}`}>
    {section === 'completed' ? <button type="button" onClick={onToggle} aria-expanded={expanded}
      className="w-full px-3 py-2 flex items-center justify-between">{label}</button>
      : <div className="px-3 py-2 flex items-center justify-between">{label}</div>}
  </div>;
}

export default function TasksTab({ completedRevision = 0, tasks, agents = [], agentsLoaded = true, agentsError = null, liveOutputs = {}, onRefresh, onTaskAdded, onTaskUnblocked, onTaskDeleted, providers, providersLoaded, apps }) {
  const [searchParams] = useSearchParams();
  const [userTasksLocal, setUserTasksLocal] = useState([]);
  const [durations, setDurations] = useState(null);
  const [showCompletedUserTasks, setShowCompletedUserTasks] = useState(false);
  const [showCompletedSystemTasks, setShowCompletedSystemTasks] = useState(false);
  const fetchUserHistory = useCallback(({ cursor, signal }) => api.getCosTasks({ view: 'completed', source: 'user', limit: 25, cursor, signal, silent: true }), []);
  const fetchSystemHistory = useCallback(({ cursor, signal }) => api.getCosTasks({ view: 'completed', source: 'internal', limit: 25, cursor, signal, silent: true }), []);
  const userHistory = usePagedCollection(fetchUserHistory, { enabled: showCompletedUserTasks && tasks.user?.completedCount != null });
  const systemHistory = usePagedCollection(fetchSystemHistory, { enabled: showCompletedSystemTasks && tasks.cos?.completedCount != null });
  const refreshHistory = () => { userHistory.reload(); systemHistory.reload(); onRefresh(); };

  const handleTaskDeleted = useCallback((taskId, taskSource) => {
    if (taskSource === 'user') {
      setUserTasksLocal(prev => prev.filter(t => t.id !== taskId));
      userHistory.setItems(prev => prev.filter(t => t.id !== taskId));
    } else if (taskSource === 'internal' || taskSource === 'cos') {
      systemHistory.setItems(prev => prev.filter(t => t.id !== taskId));
    } else {
      setUserTasksLocal(prev => prev.filter(t => t.id !== taskId));
      userHistory.setItems(prev => prev.filter(t => t.id !== taskId));
      systemHistory.setItems(prev => prev.filter(t => t.id !== taskId));
    }
    onTaskDeleted?.(taskId, taskSource);
  }, [onTaskDeleted, userHistory.setItems, systemHistory.setItems]);
  const historyVersion = useRef({ user: tasks.user?.completedCount, internal: tasks.cos?.completedCount, revision: completedRevision });
  useEffect(() => {
    const previous = historyVersion.current;
    const revisionChanged = previous.revision !== completedRevision;
    if (revisionChanged || previous.user !== tasks.user?.completedCount) userHistory.reload();
    if (revisionChanged || previous.internal !== tasks.cos?.completedCount) systemHistory.reload();
    historyVersion.current = { user: tasks.user?.completedCount, internal: tasks.cos?.completedCount, revision: completedRevision };
  }, [completedRevision, tasks.user?.completedCount, tasks.cos?.completedCount, userHistory.reload, systemHistory.reload]);

  // Fetched once for the whole list (#4520) — every row renders its instance pin
  // from this, so a long backlog never issues one request per task.
  const { instances: assignableInstances, loading: instancesLoading, error: instancesError, refresh: refreshInstances } = useAssignableInstances();

  // Fetch task duration estimates
  useEffect(() => {
    api.getCosLearningDurations()
      .then(setDurations)
      .catch(() => setDurations(null));
  }, []);

  // Memoize task arrays to prevent unnecessary re-renders
  const userTasks = useMemo(() => [...new Map([...userHistory.items, ...(tasks.user?.tasks || [])].map(task => [task.id, task])).values()], [tasks.user?.tasks, userHistory.items]);
  const cosTasks = useMemo(() => [...new Map([...systemHistory.items, ...(tasks.cos?.tasks || [])].map(task => [task.id, task])).values()], [tasks.cos?.tasks, systemHistory.items]);
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

  // The live agent working each task, keyed by task id — mid-spawn tasks are
  // active, not queued (lib/cosSpawnWindow.js). Settled client-side here rather
  // than trusting the route's `spawning` stamp because this tab also has the
  // socket agent feed, which lands ~400ms ahead of the next task refetch; the
  // map is what lets an Active row offer relaunch without its own agent fetch.
  const runningAgentByTaskId = useMemo(() => runningAgentsByTaskId(agents), [agents]);
  const agentById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);

  const isSpawning = useCallback(
    (task) => isSpawningTask(task, runningAgentByTaskId),
    [runningAgentByTaskId]
  );

  const taskAgent = useCallback((task) => {
    const running = runningAgentByTaskId.get(task.id);
    if (running) return running;
    const owners = [task.metadata?.deliveryRecoveryAgentId, retryHoldOwnerId(task.metadata)]
      .map(ownerId => agentById.get(ownerId)).filter(owner => owner?.taskId === task.id);
    return owners.find(owner => owner.deliveryActivity) || owners[0] || null;
  }, [runningAgentByTaskId, agentById]);
  const isWorking = useCallback((task) => {
    if (agentsLoaded && !agentsError && isSpawning(task)) return true;
    if (task.status !== 'in_progress') return false;
    if (task.preflightActive === true) return true;
    if (!agentsLoaded || agentsError) return false;
    const agent = taskAgent(task);
    return agent?.status === 'running' || Boolean(agent?.taskId === task.id && agent?.deliveryActivity);
  }, [agentsError, agentsLoaded, isSpawning, taskAgent]);
  const selfInstanceId = assignableInstances?.find(instance => instance.isSelf)?.instanceId;
  const unconfirmedReason = useCallback((task) => {
    if (task.status !== 'in_progress' || isWorking(task)) return null;
    if (task.metadata?.preflight?.requestId) {
      if (isTruthyMeta(task.metadata.machineLocal) && task.preflightActive === false) return null;
      return 'This shared pre-agent card may be running on another instance; current activity is unconfirmed.';
    }
    if (agentsError) return 'Agent status could not be loaded; current activity is unconfirmed.';
    if (!agentsLoaded) return 'Agent status is loading; current activity is unconfirmed.';
    if (task.metadata?.claimedBy && task.metadata.claimedBy !== selfInstanceId) {
      return selfInstanceId ? 'A different instance claimed this task; its current activity is unconfirmed here.'
        : assignableInstances === null && !instancesError ? 'This instance’s identity is loading; current activity is unconfirmed.'
          : 'The owner instance could not be identified; current activity is unconfirmed.';
    }
    return null;
  }, [agentsError, agentsLoaded, assignableInstances, instancesError, isWorking, selfInstanceId]);
  const isWaiting = useCallback((task) => ['pending', 'in_progress'].includes(task.status)
    && !isWorking(task) && !unconfirmedReason(task), [isWorking, unconfirmedReason]);

  // Split tasks by status for system tasks
  const pendingSystemTasks = useMemo(() =>
    cosTasks.filter(isWaiting),
    [cosTasks, isWaiting]
  );
  const activeSystemTasks = useMemo(() =>
    cosTasks.filter(isWorking),
    [cosTasks, isWorking]
  );
  const unconfirmedSystemTasks = useMemo(() => cosTasks.filter(unconfirmedReason), [cosTasks, unconfirmedReason]);
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
    userTasksLocal.filter(isWaiting),
    [userTasksLocal, isWaiting]
  );
  const activeUserTasksLocal = useMemo(() =>
    userTasksLocal.filter(isWorking),
    [userTasksLocal, isWorking]
  );
  const unconfirmedUserTasksLocal = useMemo(() => userTasksLocal.filter(unconfirmedReason), [userTasksLocal, unconfirmedReason]);
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
    pendingUserTasksLocal.filter(t => t.status === 'pending').map(t => t.id),
    [pendingUserTasksLocal]
  );

  // Keep local state in sync with server state
  useEffect(() => {
    setUserTasksLocal(userTasks);
  }, [userTasks]);

  const focusedSelection = useRef(false);
  useEffect(() => {
    focusedSelection.current = false;
  }, [selectedTaskId, selectedTaskSource]);

  // Queue summary links identify one concrete task. Completed sections are
  // collapsed by default, so open the relevant one before attempting to focus
  // and center the row.
  useEffect(() => {
    if (!selectedTaskId || !selectedTaskSource || focusedSelection.current) return;
    const selected = (selectedTaskSource === 'user' ? userTasks : cosTasks)
      .find((task) => task.id === selectedTaskId);
    if (selected?.status !== 'completed') return;
    if (selectedTaskSource === 'user') setShowCompletedUserTasks(true);
    else setShowCompletedSystemTasks(true);
  }, [cosTasks, selectedTaskId, selectedTaskSource, userTasks]);

  useEffect(() => {
    if (!selectedTaskId || !selectedTaskSource || focusedSelection.current) return;
    const row = document.getElementById(taskRowId(selectedTaskId, selectedTaskSource));
    if (!row) return;
    row.scrollIntoView?.({ block: 'center' });
    row.focus({ preventScroll: true });
    focusedSelection.current = true;
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

  const isUserLoading = tasks?.user == null;
  const isCosLoading = tasks?.cos == null;
  const isQueueLoading = isUserLoading || isCosLoading;

  // Keep every row under one keyed parent while its section changes. A
  // cleanup heartbeat can otherwise unmount the editor and discard a draft.
  const renderQueueRows = (isSystem) => {
    const source = isSystem ? 'internal' : 'user';
    const completedCount = isSystem ? tasks.cos?.completedCount : tasks.user?.completedCount;
    const completed = isSystem ? completedSystemTasks : completedUserTasksLocal;
    const expanded = isSystem ? showCompletedSystemTasks : showCompletedUserTasks;
    const history = isSystem ? systemHistory : userHistory;
    const toggleCompleted = isSystem ? () => setShowCompletedSystemTasks(!expanded) : () => setShowCompletedUserTasks(!expanded);
    const sections = [
      ['pending', isSystem ? pendingSystemTasks : pendingUserTasksLocal],
      ['active', isSystem ? activeSystemTasks : activeUserTasksLocal],
      ['unconfirmed', isSystem ? unconfirmedSystemTasks : unconfirmedUserTasksLocal],
      ['blocked', isSystem ? blockedSystemTasks : blockedUserTasksLocal],
      ['completed', completed],
    ];
    const entries = sections.flatMap(([section, rows]) => {
      const count = section === 'completed' ? completedCount ?? rows.length : rows.length;
      if (!count) return [];
      return [{ kind: 'header', section, count }, ...rows.map(task => ({ kind: 'task', section, task })),
        ...(section === 'completed' && expanded && completedCount != null ? [{ kind: 'footer', section }] : [])];
    });
    return <div className="space-y-1.5">{entries.map(entry => {
      if (entry.kind === 'header') return <QueueSectionHeader key={`section:${entry.section}`} section={entry.section}
        count={entry.count} expanded={expanded} onToggle={toggleCompleted} />;
      if (entry.kind === 'footer') return <InfiniteScrollFooter key="history-footer" hasMore={history.hasMore} loading={history.loading}
        error={history.error} onLoadMore={history.loadMore} />;
      const { task, section } = entry;
      const spawning = agentsLoaded && !agentsError && isSpawning(task);
      const agent = section !== 'unconfirmed' && (task.status === 'in_progress' || spawning) ? taskAgent(task) : null;
      const props = { task, agent, spawning, liveOutput: liveOutputs[runningAgentByTaskId.get(task.id)?.id],
        waiting: section === 'pending' && task.status === 'in_progress',
        unconfirmed: section === 'unconfirmed' ? unconfirmedReason(task) : null,
        retryIdentity: section === 'unconfirmed' && agentsLoaded && !agentsError && !selfInstanceId
          && (assignableInstances !== null || instancesError) && task.metadata?.claimedBy && !task.metadata?.preflight?.requestId ? refreshInstances : null,
        retryIdentityLoading: instancesLoading,
        selected: isTaskSelected(task, source), onRefresh: section === 'completed' ? refreshHistory : onRefresh,
        onTaskUnblocked, onTaskDeleted: handleTaskDeleted, providers, providersLoaded, durations, apps, instances: assignableInstances };
      const hidden = section === 'completed' && !expanded;
      return isSystem
        ? <div key={`task:${task.id}`} data-task-group={section} hidden={hidden}><TaskItem {...props} isSystem /></div>
        : <SortableTaskItem key={`task:${task.id}`} {...props} group={section} hidden={hidden}
          sortable={section === 'pending' && task.status === 'pending'} />;
    })}</div>;
  };


  return (
    <div className="space-y-6">
      {/* User Tasks */}
      <div>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-white">Task queue</h2>
        </div>

        <p className="mb-3 text-sm text-gray-400" aria-label="Queue status">
          {isQueueLoading ? (
            <BrailleSpinner text="Loading task queue…" />
          ) : (
            <>
              {formatCount(pendingUserTasksLocal.length + pendingSystemTasks.length)} pending
              {' · '}{formatCount(activeUserTasksLocal.length + activeSystemTasks.length)} active
              {(unconfirmedUserTasksLocal.length + unconfirmedSystemTasks.length) > 0 && <> · {formatCount(unconfirmedUserTasksLocal.length + unconfirmedSystemTasks.length)} activity unconfirmed</>}
              {' · '}{formatCount(blockedUserTasksLocal.length + blockedSystemTasks.length)} blocked
            </>
          )}
        </p>
        {/* Compact capture keeps the queue above detailed configuration. */}
        <TaskAddForm queueFirst providers={providers} providersLoaded={providersLoaded} apps={apps} onTaskAdded={handleTaskAdded} />

        {/* User Tasks Sections */}
        {isUserLoading ? (
          <div className="relative bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-400">
            <BrailleSpinner text="Loading task queue…" />
          </div>
        ) : pendingUserTasksLocal.length === 0 && activeUserTasksLocal.length === 0 && unconfirmedUserTasksLocal.length === 0 && blockedUserTasksLocal.length === 0 && (tasks.user?.completedCount ?? completedUserTasksLocal.length) === 0 ? (
          <div className="relative bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            <SchematicLabel module="USER" status="EMPTY" glyph="bracket-pair" state="idle" variant="tab" />
            No user tasks. Add one above.
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              {renderQueueRows(false)}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* System Tasks */}
      <div>
        <h3 className="text-lg font-semibold text-white mb-3">System Tasks</h3>

        {/* System Tasks Sections */}
        {isCosLoading ? (
          <div className="relative bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-400">
            <BrailleSpinner text="Loading system tasks…" />
          </div>
        ) : pendingSystemTasks.length === 0 && activeSystemTasks.length === 0 && unconfirmedSystemTasks.length === 0 && blockedSystemTasks.length === 0 && (tasks.cos?.completedCount ?? completedSystemTasks.length) === 0 ? (
          <div className="relative bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            <SchematicLabel module="COS" status="EMPTY" glyph="bracket-pair" state="idle" variant="tab" />
            No system tasks.
          </div>
        ) : renderQueueRows(true)}
      </div>

    </div>
  );
}
