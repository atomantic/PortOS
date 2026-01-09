import { useState, useEffect, useRef, useMemo } from 'react';
import { Plus, RefreshCw, Image, X, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
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
import { processScreenshotUploads } from '../../../utils/fileUpload';
import TaskItem from './TaskItem';
import SortableTaskItem from './SortableTaskItem';

export default function TasksTab({ tasks, onRefresh, providers, apps }) {
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTask, setNewTask] = useState({ id: '', description: '', context: '', model: '', provider: '', app: '' });
  const [userTasksLocal, setUserTasksLocal] = useState([]);
  const [screenshots, setScreenshots] = useState([]);
  const [durations, setDurations] = useState(null);
  const [showCompletedUserTasks, setShowCompletedUserTasks] = useState(false);
  const [showCompletedSystemTasks, setShowCompletedSystemTasks] = useState(false);
  const fileInputRef = useRef(null);

  // Fetch task duration estimates from learning data
  useEffect(() => {
    api.getCosLearningDurations()
      .then(setDurations)
      .catch(() => setDurations(null));
  }, []);

  // Memoize task arrays to prevent unnecessary re-renders
  const userTasks = useMemo(() => tasks.user?.tasks || [], [tasks.user?.tasks]);
  const cosTasks = useMemo(() => tasks.cos?.tasks || [], [tasks.cos?.tasks]);
  const awaitingApproval = useMemo(() => tasks.cos?.awaitingApproval || [], [tasks.cos?.awaitingApproval]);

  // Split tasks into pending (includes in_progress, blocked) and completed
  const pendingSystemTasks = useMemo(() =>
    cosTasks.filter(t => t.status !== 'completed'),
    [cosTasks]
  );
  const completedSystemTasks = useMemo(() =>
    cosTasks.filter(t => t.status === 'completed'),
    [cosTasks]
  );

  // Memoize enabled providers for dropdown
  const enabledProviders = useMemo(() =>
    providers?.filter(p => p.enabled) || [],
    [providers]
  );

  // Memoize pending tasks from local state for drag-and-drop (only pending tasks are sortable)
  const pendingUserTasksLocal = useMemo(() =>
    userTasksLocal.filter(t => t.status !== 'completed'),
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

  // Screenshot handling using shared utility
  const handleFileSelect = async (e) => {
    await processScreenshotUploads(e.target.files, {
      onSuccess: (fileInfo) => setScreenshots(prev => [...prev, fileInfo]),
      onError: (msg) => toast.error(msg)
    });
    e.target.value = '';
  };

  const removeScreenshot = (id) => {
    setScreenshots(prev => prev.filter(s => s.id !== id));
  };

  // Get models for selected provider
  const selectedProvider = providers?.find(p => p.id === newTask.provider);
  const availableModels = selectedProvider?.models || [];

  const handleAddTask = async () => {
    if (!newTask.description.trim()) {
      toast.error('Description is required');
      return;
    }

    const taskId = newTask.id.trim() || `task-${Date.now()}`;
    await api.addCosTask({
      id: taskId,
      description: newTask.description,
      context: newTask.context,
      model: newTask.model || undefined,
      provider: newTask.provider || undefined,
      app: newTask.app || undefined,
      screenshots: screenshots.length > 0 ? screenshots.map(s => s.path) : undefined
    }).catch(err => {
      toast.error(err.message);
      return;
    });

    toast.success('Task added');
    setNewTask({ id: '', description: '', context: '', model: '', provider: '', app: '' });
    setScreenshots([]);
    setShowAddTask(false);
    onRefresh();
  };

  return (
    <div className="space-y-6">
      {/* User Tasks */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-white">User Tasks (TASKS.md)</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddTask(!showAddTask)}
              className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors"
              aria-expanded={showAddTask}
            >
              <Plus size={16} aria-hidden="true" />
              Add Task
            </button>
            <button
              onClick={onRefresh}
              className="text-gray-500 hover:text-white transition-colors"
              aria-label="Refresh tasks"
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Add Task Form */}
        {showAddTask && (
          <div className="bg-port-card border border-port-accent/50 rounded-lg p-4 mb-4" role="form" aria-label="Add new task">
            <div className="space-y-3">
              <div>
                <label htmlFor="task-id" className="sr-only">Task ID</label>
                <input
                  id="task-id"
                  type="text"
                  placeholder="Task ID (auto-generated if empty)"
                  value={newTask.id}
                  onChange={e => setNewTask(t => ({ ...t, id: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                />
              </div>
              <div>
                <label htmlFor="task-description" className="sr-only">Task description (required)</label>
                <input
                  id="task-description"
                  type="text"
                  placeholder="Task description *"
                  value={newTask.description}
                  onChange={e => setNewTask(t => ({ ...t, description: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  aria-required="true"
                />
              </div>
              <div>
                <label htmlFor="task-context" className="sr-only">Context</label>
                <input
                  id="task-context"
                  type="text"
                  placeholder="Context (optional)"
                  value={newTask.context}
                  onChange={e => setNewTask(t => ({ ...t, context: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label htmlFor="task-app" className="sr-only">Target application</label>
                  <select
                    id="task-app"
                    value={newTask.app}
                    onChange={e => setNewTask(t => ({ ...t, app: e.target.value }))}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  >
                    <option value="">PortOS (default)</option>
                    {apps?.map(app => (
                      <option key={app.id} value={app.id}>{app.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex gap-3">
                <div>
                  <label htmlFor="task-provider" className="sr-only">AI provider</label>
                  <select
                    id="task-provider"
                    value={newTask.provider}
                    onChange={e => setNewTask(t => ({ ...t, provider: e.target.value, model: '' }))}
                    className="w-40 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  >
                    <option value="">Auto (default)</option>
                    {enabledProviders.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label htmlFor="task-model" className="sr-only">AI model</label>
                  <select
                    id="task-model"
                    value={newTask.model}
                    onChange={e => setNewTask(t => ({ ...t, model: e.target.value }))}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                    disabled={!newTask.provider}
                    aria-disabled={!newTask.provider}
                  >
                    <option value="">{newTask.provider ? 'Select model...' : 'Select provider first'}</option>
                    {availableModels.map(m => (
                      <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* Screenshot Upload */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white text-sm transition-colors"
                >
                  <Image size={16} aria-hidden="true" />
                  Add Screenshot
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                  aria-label="Upload screenshot files"
                />
                {screenshots.length > 0 && (
                  <span className="text-xs text-gray-500">{screenshots.length} screenshot{screenshots.length > 1 ? 's' : ''} attached</span>
                )}
              </div>
              {/* Screenshot Previews */}
              {screenshots.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {screenshots.map(s => (
                    <div key={s.id} className="relative group">
                      <img
                        src={s.preview}
                        alt={s.filename}
                        className="w-20 h-20 object-cover rounded-lg border border-port-border"
                      />
                      <button
                        type="button"
                        onClick={() => removeScreenshot(s.id)}
                        className="absolute -top-2 -right-2 w-5 h-5 bg-port-error rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label={`Remove screenshot ${s.filename}`}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => {
                    setShowAddTask(false);
                    setScreenshots([]);
                  }}
                  className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddTask}
                  className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors"
                >
                  <Plus size={14} aria-hidden="true" />
                  Add
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Pending User Tasks */}
        {pendingUserTasksLocal.length === 0 && completedUserTasksLocal.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No user tasks. Click "Add Task" or edit TASKS.md directly.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Pending Section */}
            <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-port-accent/10 border-b border-port-border flex items-center justify-between">
                <span className="text-sm font-medium text-port-accent">
                  Pending ({pendingUserTasksLocal.length})
                </span>
              </div>
              {pendingUserTasksLocal.length === 0 ? (
                <div className="p-4 text-center text-gray-500 text-sm">
                  No pending tasks
                </div>
              ) : (
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
                          <SortableTaskItem key={task.id} task={task} onRefresh={onRefresh} providers={providers} durations={durations} />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </div>
              )}
            </div>

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
                      <TaskItem key={task.id} task={task} onRefresh={onRefresh} providers={providers} durations={durations} />
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

        {/* Pending System Tasks */}
        {pendingSystemTasks.length === 0 && completedSystemTasks.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No system tasks.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Pending Section */}
            <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-port-accent/10 border-b border-port-border flex items-center justify-between">
                <span className="text-sm font-medium text-port-accent">
                  Pending ({pendingSystemTasks.length})
                </span>
              </div>
              {pendingSystemTasks.length === 0 ? (
                <div className="p-4 text-center text-gray-500 text-sm">
                  No pending tasks
                </div>
              ) : (
                <div className="p-2 space-y-1.5">
                  {pendingSystemTasks.map(task => (
                    <TaskItem key={task.id} task={task} isSystem onRefresh={onRefresh} providers={providers} durations={durations} />
                  ))}
                </div>
              )}
            </div>

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
                      <TaskItem key={task.id} task={task} isSystem onRefresh={onRefresh} providers={providers} durations={durations} />
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
              <TaskItem key={task.id} task={task} awaitingApproval onRefresh={onRefresh} providers={providers} durations={durations} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
