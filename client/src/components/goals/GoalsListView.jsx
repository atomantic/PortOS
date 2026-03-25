import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ChevronRight, ChevronDown, Plus, GripVertical, Search, Tag, Link2, Crown, Star, Wand2
} from 'lucide-react';
import toast from 'react-hot-toast';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core';
import * as api from '../../services/api';
import GoalDetailPanel, { CATEGORY_CONFIG, HORIZON_OPTIONS, GOAL_TYPE_CONFIG, DEFAULT_NEW_GOAL } from './GoalDetailPanel';
import { applyOrganizationSuggestion } from './applyOrganization';
import useProviderModels from '../../hooks/useProviderModels';
import ProviderModelSelector from '../ProviderModelSelector';

const API_PROVIDER_FILTER = p => p.enabled && p.type === 'api';

function urgencyIndicator(urgency) {
  if (urgency == null) return null;
  const color = urgency >= 0.7 ? 'bg-red-400' : urgency >= 0.4 ? 'bg-yellow-400' : 'bg-green-400';
  return <div className={`w-2 h-2 rounded-full ${color}`} title={`${Math.round(urgency * 100)}% urgency`} />;
}

function GoalRowContent({ goal, isDragOverlay }) {
  const cat = CATEGORY_CONFIG[goal.category] || CATEGORY_CONFIG.mastery;
  const CatIcon = cat.icon;
  return (
    <div className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 ${
      isDragOverlay ? 'bg-port-card border border-port-accent/50 rounded-lg shadow-lg' : ''
    }`}>
      <div className={`p-1 rounded ${cat.bg} shrink-0`}>
        <CatIcon className={`w-3.5 h-3.5 ${cat.color}`} />
      </div>
      <span className="text-sm text-white truncate flex-1 min-w-0">{goal.title}</span>
      {goal.goalType && goal.goalType !== 'standard' && (
        <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${GOAL_TYPE_CONFIG[goal.goalType]?.bg} ${GOAL_TYPE_CONFIG[goal.goalType]?.color}`}>
          {goal.goalType === 'apex' ? <Crown className="w-3 h-3 inline mr-0.5" /> : <Star className="w-3 h-3 inline mr-0.5" />}
          <span className="hidden sm:inline">{GOAL_TYPE_CONFIG[goal.goalType]?.label}</span>
        </span>
      )}
      <span className="text-xs text-gray-500 shrink-0 px-1 sm:px-1.5 py-0.5 rounded bg-gray-800">
        {HORIZON_OPTIONS.find(h => h.value === goal.horizon)?.label}
      </span>
    </div>
  );
}

function GoalRow({ goal, depth, expandedIds, onToggle, onSelect, selectedId, onAddChild, draggedId }) {
  const cat = CATEGORY_CONFIG[goal.category] || CATEGORY_CONFIG.mastery;
  const CatIcon = cat.icon;
  const expanded = expandedIds.has(goal.id);
  const hasChildren = goal.children?.length > 0;
  const isSelected = selectedId === goal.id;
  const isDragging = draggedId === goal.id;

  const { attributes, listeners, setNodeRef: setDragRef } = useDraggable({
    id: `drag-${goal.id}`,
    data: { goal }
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${goal.id}`,
    data: { goal }
  });

  return (
    <>
      <div
        ref={(node) => { setDragRef(node); setDropRef(node); }}
        className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 cursor-pointer transition-colors border-b border-port-border/50 ${
          isSelected ? 'bg-port-accent/10' : ''
        } ${isOver && !isDragging ? 'bg-port-accent/20 border-port-accent' : 'hover:bg-port-border/30'} ${
          isDragging ? 'opacity-30' : ''
        }`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => onSelect(goal)}
      >
        <div
          className="shrink-0 cursor-grab active:cursor-grabbing touch-none hidden sm:block"
          {...attributes}
          {...listeners}
          onClick={e => e.stopPropagation()}
        >
          <GripVertical className="w-3.5 h-3.5 text-gray-600 hover:text-gray-400" />
        </div>

        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(goal.id); }}
            className="p-0.5 text-gray-500 hover:text-white shrink-0"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <div className="w-4.5 shrink-0" />
        )}

        <div className={`p-1 rounded ${cat.bg} shrink-0`}>
          <CatIcon className={`w-3.5 h-3.5 ${cat.color}`} />
        </div>

        <span className="text-sm text-white truncate flex-1 min-w-0">{goal.title}</span>

        {goal.goalType && goal.goalType !== 'standard' && (
          <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${GOAL_TYPE_CONFIG[goal.goalType]?.bg} ${GOAL_TYPE_CONFIG[goal.goalType]?.color}`}>
            {goal.goalType === 'apex' ? <Crown className="w-3 h-3 inline mr-0.5" /> : <Star className="w-3 h-3 inline mr-0.5" />}
            <span className="hidden sm:inline">{GOAL_TYPE_CONFIG[goal.goalType]?.label}</span>
          </span>
        )}

        {(goal.progress > 0 || goal.todos?.length > 0) && (
          <span className="shrink-0 flex items-center gap-1 text-xs text-gray-500 hidden sm:flex">
            <div className="w-12 h-1.5 rounded-full bg-gray-700 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  goal.progress >= 100 ? 'bg-port-success' : goal.progress >= 50 ? 'bg-port-accent' : 'bg-port-warning'
                }`}
                style={{ width: `${goal.progress ?? 0}%` }}
              />
            </div>
            <span className="w-7 text-right">{goal.progress ?? 0}%</span>
          </span>
        )}

        <span className="text-xs text-gray-500 shrink-0 px-1 sm:px-1.5 py-0.5 rounded bg-gray-800">
          {HORIZON_OPTIONS.find(h => h.value === goal.horizon)?.label}
        </span>

        {urgencyIndicator(goal.urgency)}

        {goal.linkedActivities?.length > 0 && (
          <span className="hidden sm:flex items-center gap-0.5 text-xs text-gray-500 shrink-0" title={`${goal.linkedActivities.length} linked ${goal.linkedActivities.length === 1 ? 'activity' : 'activities'}`}>
            <Link2 className="w-3 h-3" />
            {goal.linkedActivities.length}
          </span>
        )}

        {goal.tags?.length > 0 && (
          <div className="hidden md:flex items-center gap-1 shrink-0">
            {goal.tags.slice(0, 3).map(tag => (
              <span key={tag} className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-port-accent/10 text-port-accent text-xs">
                <Tag className="w-2.5 h-2.5" />
                {tag}
              </span>
            ))}
            {goal.tags.length > 3 && (
              <span className="text-xs text-gray-500">+{goal.tags.length - 3}</span>
            )}
          </div>
        )}

        <button
          onClick={(e) => { e.stopPropagation(); onAddChild(goal.id); }}
          className="p-1 text-gray-600 hover:text-port-accent shrink-0"
          title="Add sub-goal"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {hasChildren && expanded && goal.children.map(child => (
        <GoalRow
          key={child.id}
          goal={child}
          depth={depth + 1}
          expandedIds={expandedIds}
          onToggle={onToggle}
          onSelect={onSelect}
          selectedId={selectedId}
          onAddChild={onAddChild}
          draggedId={draggedId}
        />
      ))}
    </>
  );
}

function RootDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: 'drop-root', data: { root: true } });
  return (
    <div
      ref={setNodeRef}
      className={`px-4 py-2 text-xs text-center transition-colors ${
        isOver ? 'bg-port-accent/20 text-port-accent' : 'text-gray-600'
      }`}
    >
      {isOver ? 'Drop here to make root goal' : 'Drag goals to reparent them'}
    </div>
  );
}

export default function GoalsListView({ data, onRefresh }) {
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [selectedGoal, setSelectedGoal] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewGoal, setShowNewGoal] = useState(false);
  const [newGoal, setNewGoal] = useState({ ...DEFAULT_NEW_GOAL });
  const [organizing, setOrganizing] = useState(false);
  const [draggedGoal, setDraggedGoal] = useState(null);
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading
  } = useProviderModels({ filter: API_PROVIDER_FILTER });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => {
    if (!data?.roots) return;
    const allIds = new Set();
    const collect = (goals) => {
      for (const g of goals) {
        if (g.children?.length) { allIds.add(g.id); collect(g.children); }
      }
    };
    collect(data.roots);
    setExpandedIds(allIds);
  }, [data]);

  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const filteredRoots = useMemo(() => {
    if (!data?.roots) return [];
    if (!searchQuery) return data.roots;
    const query = searchQuery.toLowerCase();
    const matchesSearch = (goal) => {
      if (goal.title.toLowerCase().includes(query)) return true;
      if (goal.description?.toLowerCase().includes(query)) return true;
      if (goal.tags?.some(t => t.toLowerCase().includes(query))) return true;
      return goal.children?.some(matchesSearch) || false;
    };
    return data.roots.filter(matchesSearch);
  }, [data, searchQuery]);

  const handleSelect = (goal) => {
    const full = data?.flat?.find(g => g.id === goal.id);
    setSelectedGoal(prev => prev?.id === goal.id ? null : full || goal);
  };

  const handleAddChild = (parentId) => {
    setNewGoal({ ...DEFAULT_NEW_GOAL, parentId });
    setShowNewGoal(true);
  };

  const handleCreateGoal = async () => {
    if (!newGoal.title.trim()) return;
    await api.createGoal(newGoal);
    setNewGoal({ ...DEFAULT_NEW_GOAL });
    setShowNewGoal(false);
    onRefresh();
  };

  const handleOrganize = async () => {
    if (!selectedProviderId) { toast.error('No API provider available'); return; }
    setOrganizing(true);
    const result = await api.organizeGoals({ providerId: selectedProviderId, model: selectedModel }).catch(() => null);
    setOrganizing(false);
    if (!result) { toast.error('Failed to organize goals'); return; }
    await applyOrganizationSuggestion(result);
    toast.success('Goal hierarchy applied');
    onRefresh();
  };

  const handleDragStart = useCallback((event) => {
    setDraggedGoal(event.active.data.current?.goal || null);
  }, []);

  const handleDragEnd = useCallback(async (event) => {
    const { active, over } = event;
    setDraggedGoal(null);
    if (!over || !active) return;

    const dragGoal = active.data.current?.goal;
    if (!dragGoal) return;

    const isRoot = over.data.current?.root;
    const dropGoal = over.data.current?.goal;

    // Determine new parentId
    let newParentId = null;
    if (!isRoot && dropGoal) {
      if (dropGoal.id === dragGoal.id) return; // dropped on self
      if (dropGoal.id === dragGoal.parentId) return; // already a child of this parent
      newParentId = dropGoal.id;
    } else {
      if (!dragGoal.parentId) return; // already a root goal
    }

    const result = await api.updateGoal(dragGoal.id, { parentId: newParentId }).catch(err => {
      toast.error(err?.message || 'Failed to move goal');
      return null;
    });
    if (!result) return;
    toast.success(`Moved "${dragGoal.title}" ${newParentId ? `under "${dropGoal.title}"` : 'to root'}`);
    onRefresh();
  }, [onRefresh]);

  const handleDragCancel = useCallback(() => setDraggedGoal(null), []);

  return (
    <div className="h-full flex flex-col sm:flex-row relative">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 sm:py-3 border-b border-port-border bg-port-card/50">
          <div className="relative flex-1 min-w-[140px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search goals..."
              className="w-full bg-port-bg border border-port-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-white"
            />
          </div>
          <button
            onClick={() => {
              setNewGoal({ ...DEFAULT_NEW_GOAL });
              setShowNewGoal(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-port-accent text-white hover:bg-blue-600 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Add Root Goal</span>
            <span className="sm:hidden">Add</span>
          </button>
          {(data?.flat?.length ?? 0) >= 2 && (
            <div className="flex items-center gap-2">
              <div className="hidden sm:block">
                <ProviderModelSelector
                  providers={providers}
                  selectedProviderId={selectedProviderId}
                  selectedModel={selectedModel}
                  availableModels={availableModels}
                  onProviderChange={setSelectedProviderId}
                  onModelChange={setSelectedModel}
                  label="AI Provider"
                  disabled={organizing || providersLoading}
                  compact
                />
              </div>
              <button
                onClick={handleOrganize}
                disabled={organizing || !selectedProviderId}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-50 min-h-[40px] whitespace-nowrap"
                title="AI analyzes your goals, suggests an apex north-star goal, and organizes everything into a hierarchy"
              >
                <Wand2 className={`w-4 h-4 ${organizing ? 'animate-spin' : ''}`} />
                {organizing ? 'Analyzing...' : 'Organize'}
              </button>
            </div>
          )}
          <button
            onClick={() => {
              if (expandedIds.size > 0) {
                setExpandedIds(new Set());
              } else {
                const allIds = new Set();
                const collect = (goals) => {
                  for (const g of goals) {
                    if (g.children?.length) { allIds.add(g.id); collect(g.children); }
                  }
                };
                collect(data?.roots || []);
                setExpandedIds(allIds);
              }
            }}
            className="px-3 py-1.5 text-sm rounded-lg bg-port-border text-gray-300 hover:bg-gray-600 whitespace-nowrap"
          >
            {expandedIds.size > 0 ? 'Collapse' : 'Expand'}
          </button>
        </div>

        {/* New goal form */}
        {showNewGoal && (
          <div className="bg-port-card border-b border-port-border px-3 sm:px-4 py-3 space-y-2">
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Plus className="w-4 h-4 shrink-0" />
              <span className="truncate">
                {newGoal.parentId
                  ? `New sub-goal under "${data?.flat?.find(g => g.id === newGoal.parentId)?.title}"`
                  : 'New root goal'}
              </span>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={newGoal.title}
                onChange={e => setNewGoal({ ...newGoal, title: e.target.value })}
                placeholder="Goal title..."
                className="flex-1 bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
                onKeyDown={e => e.key === 'Enter' && handleCreateGoal()}
                autoFocus
              />
              <div className="flex gap-2">
                <select
                  value={newGoal.horizon}
                  onChange={e => setNewGoal({ ...newGoal, horizon: e.target.value })}
                  className="flex-1 sm:flex-none bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
                >
                  {HORIZON_OPTIONS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
                </select>
                <select
                  value={newGoal.category}
                  onChange={e => setNewGoal({ ...newGoal, category: e.target.value })}
                  className="flex-1 sm:flex-none bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
                >
                  {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
                <button
                  onClick={handleCreateGoal}
                  disabled={!newGoal.title.trim()}
                  className="px-3 py-1.5 text-sm rounded bg-port-accent text-white disabled:opacity-50"
                >
                  Create
                </button>
                <button
                  onClick={() => setShowNewGoal(false)}
                  className="px-3 py-1.5 text-sm rounded bg-port-border text-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tree list with drag-and-drop */}
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div className="flex-1 overflow-y-auto">
            <RootDropZone />
            {filteredRoots.length === 0 ? (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                {searchQuery ? 'No matching goals found.' : 'No goals yet. Add a root goal to get started.'}
              </div>
            ) : (
              filteredRoots.map(root => (
                <GoalRow
                  key={root.id}
                  goal={root}
                  depth={0}
                  expandedIds={expandedIds}
                  onToggle={toggleExpand}
                  onSelect={handleSelect}
                  selectedId={selectedGoal?.id}
                  onAddChild={handleAddChild}
                  draggedId={draggedGoal?.id}
                />
              ))
            )}
          </div>
          <DragOverlay>
            {draggedGoal && <GoalRowContent goal={draggedGoal} isDragOverlay />}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Detail panel — full overlay on mobile, side panel on desktop */}
      {selectedGoal && (
        <div className="absolute inset-0 sm:relative sm:inset-auto z-20 sm:z-auto">
          <GoalDetailPanel
            goal={selectedGoal}
            allGoals={data?.flat}
            onClose={() => setSelectedGoal(null)}
            onRefresh={() => {
              setSelectedGoal(null);
              onRefresh();
            }}
          />
        </div>
      )}
    </div>
  );
}
