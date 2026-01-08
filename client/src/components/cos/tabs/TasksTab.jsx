import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Plus, RefreshCw, Image, X } from 'lucide-react';
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
import TaskItem from './TaskItem';
import SortableTaskItem from './SortableTaskItem';

export default function TasksTab({ tasks, onRefresh, providers, apps }) {
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTask, setNewTask] = useState({ id: '', description: '', context: '', model: '', provider: '', app: '' });
  const [userTasksLocal, setUserTasksLocal] = useState([]);
  const [screenshots, setScreenshots] = useState([]);
  const fileInputRef = useRef(null);

  // Memoize task arrays to prevent unnecessary re-renders
  const userTasks = useMemo(() => tasks.user?.tasks || [], [tasks.user?.tasks]);
  const cosTasks = useMemo(() => tasks.cos?.tasks || [], [tasks.cos?.tasks]);
  const awaitingApproval = useMemo(() => tasks.cos?.awaitingApproval || [], [tasks.cos?.awaitingApproval]);

  // Memoize enabled providers for dropdown
  const enabledProviders = useMemo(() =>
    providers?.filter(p => p.enabled) || [],
    [providers]
  );

  // Memoize sortable item IDs for DndContext
  const sortableIds = useMemo(() =>
    userTasksLocal.map(t => t.id),
    [userTasksLocal]
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

  // Screenshot handling - limit to 10MB per file
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`File "${file.name}" exceeds 10MB limit`);
        continue;
      }

      const reader = new FileReader();
      reader.onload = async (ev) => {
        const result = ev?.target?.result;
        if (typeof result !== 'string') {
          console.error('❌ Failed to read file: unexpected FileReader result type');
          return;
        }

        const parts = result.split(',');
        if (parts.length < 2) {
          console.error('❌ Failed to read file: unexpected data URL format');
          return;
        }

        const base64 = parts[1];
        const uploaded = await api.uploadScreenshot(base64, file.name, file.type).catch((err) => {
          console.error(`❌ Failed to upload screenshot: ${err.message}`);
          return null;
        });
        if (uploaded) {
          setScreenshots(prev => [...prev, {
            id: uploaded.id,
            filename: uploaded.filename,
            preview: result,
            path: uploaded.path
          }]);
        }
      };
      reader.onerror = (err) => {
        console.error(`❌ FileReader failed to read file: ${err.message}`);
      };
      reader.readAsDataURL(file);
    }
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
            >
              <Plus size={16} />
              Add Task
            </button>
            <button
              onClick={onRefresh}
              className="text-gray-500 hover:text-white transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        {/* Add Task Form */}
        {showAddTask && (
          <div className="bg-port-card border border-port-accent/50 rounded-lg p-4 mb-4">
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Task ID (auto-generated if empty)"
                value={newTask.id}
                onChange={e => setNewTask(t => ({ ...t, id: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <input
                type="text"
                placeholder="Task description *"
                value={newTask.description}
                onChange={e => setNewTask(t => ({ ...t, description: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <input
                type="text"
                placeholder="Context (optional)"
                value={newTask.context}
                onChange={e => setNewTask(t => ({ ...t, context: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <div className="flex gap-3">
                <select
                  value={newTask.app}
                  onChange={e => setNewTask(t => ({ ...t, app: e.target.value }))}
                  className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  <option value="">PortOS (default)</option>
                  {apps?.map(app => (
                    <option key={app.id} value={app.id}>{app.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3">
                <select
                  value={newTask.provider}
                  onChange={e => setNewTask(t => ({ ...t, provider: e.target.value, model: '' }))}
                  className="w-40 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  <option value="">Auto (default)</option>
                  {enabledProviders.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <select
                  value={newTask.model}
                  onChange={e => setNewTask(t => ({ ...t, model: e.target.value }))}
                  className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  disabled={!newTask.provider}
                >
                  <option value="">{newTask.provider ? 'Select model...' : 'Select provider first'}</option>
                  {availableModels.map(m => (
                    <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                  ))}
                </select>
              </div>
              {/* Screenshot Upload */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white text-sm transition-colors"
                >
                  <Image size={16} />
                  Add Screenshot
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
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
                      >
                        <X size={12} />
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
                  <Plus size={14} />
                  Add
                </button>
              </div>
            </div>
          </div>
        )}

        {userTasksLocal.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No user tasks. Click "Add Task" or edit TASKS.md directly.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sortableIds}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {userTasksLocal.map(task => (
                  <SortableTaskItem key={task.id} task={task} onRefresh={onRefresh} providers={providers} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* System Tasks */}
      <div>
        <h3 className="text-lg font-semibold text-white mb-3">System Tasks (COS-TASKS.md)</h3>

        {cosTasks.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No system tasks.
          </div>
        ) : (
          <div className="space-y-2">
            {cosTasks.map(task => (
              <TaskItem key={task.id} task={task} isSystem onRefresh={onRefresh} providers={providers} />
            ))}
          </div>
        )}
      </div>

      {/* Awaiting Approval */}
      {awaitingApproval.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-yellow-500 mb-3">Awaiting Approval</h3>
          <div className="space-y-2">
            {awaitingApproval.map(task => (
              <TaskItem key={task.id} task={task} awaitingApproval onRefresh={onRefresh} providers={providers} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
