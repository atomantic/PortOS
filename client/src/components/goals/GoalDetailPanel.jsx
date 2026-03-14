import { useState, useEffect } from 'react';
import {
  Target, X, Check, Trash2, Milestone, Calendar, CalendarDays, Clock,
  Heart, DollarSign, Lightbulb, Users, Flame, AlertTriangle, Tag,
  Link2, Unlink, Activity, Plus, NotebookPen, ListTodo, TrendingUp,
  TrendingDown, Minus, CircleDot
} from 'lucide-react';
import * as api from '../../services/api';

const CATEGORY_CONFIG = {
  creative: { label: 'Creative', icon: Lightbulb, color: 'text-purple-400', bg: 'bg-purple-500/20', hex: '#a855f7' },
  family: { label: 'Family', icon: Users, color: 'text-pink-400', bg: 'bg-pink-500/20', hex: '#ec4899' },
  health: { label: 'Health', icon: Heart, color: 'text-green-400', bg: 'bg-green-500/20', hex: '#22c55e' },
  financial: { label: 'Financial', icon: DollarSign, color: 'text-yellow-400', bg: 'bg-yellow-500/20', hex: '#eab308' },
  legacy: { label: 'Legacy', icon: Flame, color: 'text-orange-400', bg: 'bg-orange-500/20', hex: '#f97316' },
  mastery: { label: 'Mastery', icon: Target, color: 'text-blue-400', bg: 'bg-blue-500/20', hex: '#3b82f6' }
};

const HORIZON_OPTIONS = [
  { value: '1-year', label: '1 Year' },
  { value: '3-year', label: '3 Years' },
  { value: '5-year', label: '5 Years' },
  { value: '10-year', label: '10 Years' },
  { value: '20-year', label: '20 Years' },
  { value: 'lifetime', label: 'Lifetime' }
];

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;

export { CATEGORY_CONFIG, HORIZON_OPTIONS };

function ProgressSlider({ goal, onCommit }) {
  const [draft, setDraft] = useState(goal.progress ?? 0);
  const [dragging, setDragging] = useState(false);

  // Sync draft when goal changes externally (not during drag)
  useEffect(() => {
    if (!dragging) setDraft(goal.progress ?? 0);
  }, [goal.progress, dragging]);

  const commit = () => {
    setDragging(false);
    if (draft !== (goal.progress ?? 0)) onCommit(draft);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-gray-400">Progress</span>
        <span className="text-xs text-gray-300 font-mono">{draft}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={draft}
        onChange={e => { setDragging(true); setDraft(parseInt(e.target.value, 10)); }}
        onMouseUp={commit}
        onTouchEnd={commit}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-port-border accent-port-accent"
      />
      {goal.velocity && (
        <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-500">
          <div className="flex items-center gap-1">
            {goal.velocity.trend === 'increasing' && <TrendingUp className="w-3 h-3 text-green-400" />}
            {goal.velocity.trend === 'decreasing' && <TrendingDown className="w-3 h-3 text-red-400" />}
            {goal.velocity.trend === 'stable' && <Minus className="w-3 h-3 text-gray-400" />}
            <span>{goal.velocity.percentPerMonth}%/mo</span>
          </div>
          {goal.velocity.projectedCompletion && (
            <span className="text-gray-600">
              ETA {new Date(goal.velocity.projectedCompletion + 'T00:00:00').toLocaleDateString()}
            </span>
          )}
        </div>
      )}
      {goal.timeTracking?.totalMinutes > 0 && (
        <div className="flex items-center gap-1 mt-1 text-xs text-gray-600">
          <Clock className="w-3 h-3" />
          {goal.timeTracking.totalMinutes >= 60
            ? `${Math.floor(goal.timeTracking.totalMinutes / 60)}h${goal.timeTracking.totalMinutes % 60 ? ` ${goal.timeTracking.totalMinutes % 60}m` : ''}`
            : `${goal.timeTracking.totalMinutes}m`}
          {' total'}
          {goal.timeTracking.weeklyAverage > 0 && ` · ${goal.timeTracking.weeklyAverage}m/wk`}
        </div>
      )}
    </div>
  );
}

export default function GoalDetailPanel({ goal, allGoals, onClose, onRefresh }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [tagInput, setTagInput] = useState('');
  const [newMilestone, setNewMilestone] = useState({ title: '', targetDate: '' });
  const [activities, setActivities] = useState([]);
  const [selectedActivity, setSelectedActivity] = useState('');
  const [showProgressForm, setShowProgressForm] = useState(false);
  const todayISO = new Date().toISOString().slice(0, 10);
  const [progressForm, setProgressForm] = useState({ date: todayISO, note: '', durationMinutes: '' });
  const [subcalendars, setSubcalendars] = useState([]);
  const [selectedCalendar, setSelectedCalendar] = useState('');
  const [calendarMatchPattern, setCalendarMatchPattern] = useState('');
  const [newTodoTitle, setNewTodoTitle] = useState('');
  const [newTodoPriority, setNewTodoPriority] = useState('medium');
  const [newTodoEstimate, setNewTodoEstimate] = useState('');

  useEffect(() => {
    api.getActivities().then(setActivities).catch(() => {});
  }, []);

  useEffect(() => {
    api.getCalendarAccounts().then(accounts => {
      const scs = [];
      for (const account of (accounts || [])) {
        for (const sc of (account.subcalendars || [])) {
          if (sc.enabled && !sc.dormant) {
            scs.push({ ...sc, accountName: account.name });
          }
        }
      }
      setSubcalendars(scs);
    }).catch(() => {});
  }, []);

  if (!goal) return null;

  const cat = CATEGORY_CONFIG[goal.category] || CATEGORY_CONFIG.mastery;
  const CatIcon = cat.icon;
  const parent = goal.parentId ? allGoals?.find(g => g.id === goal.parentId) : null;
  const children = allGoals?.filter(g => g.parentId === goal.id) || [];

  const startEdit = () => {
    setForm({
      title: goal.title,
      description: goal.description || '',
      horizon: goal.horizon,
      category: goal.category,
      parentId: goal.parentId || '',
      tags: [...(goal.tags || [])]
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    await api.updateGoal(goal.id, {
      ...form,
      parentId: form.parentId || null
    });
    setEditing(false);
    onRefresh();
  };

  const handleDelete = async () => {
    await api.deleteGoal(goal.id);
    onClose();
    onRefresh();
  };

  const handleComplete = async () => {
    await api.updateGoal(goal.id, { status: 'completed' });
    onRefresh();
  };

  const handleAddMilestone = async () => {
    if (!newMilestone.title.trim()) return;
    await api.addGoalMilestone(goal.id, {
      title: newMilestone.title,
      ...(newMilestone.targetDate ? { targetDate: newMilestone.targetDate } : {})
    });
    setNewMilestone({ title: '', targetDate: '' });
    onRefresh();
  };

  const handleCompleteMilestone = async (milestoneId) => {
    await api.completeGoalMilestone(goal.id, milestoneId);
    onRefresh();
  };

  const handleLinkActivity = async () => {
    if (!selectedActivity) return;
    await api.linkGoalActivity(goal.id, { activityName: selectedActivity });
    setSelectedActivity('');
    onRefresh();
  };

  const handleAddProgress = async () => {
    if (!progressForm.note.trim() || !progressForm.date) return;
    await api.addGoalProgress(goal.id, {
      date: progressForm.date,
      note: progressForm.note,
      ...(progressForm.durationMinutes ? { durationMinutes: parseInt(progressForm.durationMinutes, 10) } : {})
    });
    setProgressForm({ date: todayISO, note: '', durationMinutes: '' });
    setShowProgressForm(false);
    onRefresh();
  };

  const resetProgressForm = () => {
    setProgressForm({ date: todayISO, note: '', durationMinutes: '' });
    setShowProgressForm(false);
  };

  const handleDeleteProgress = async (entryId) => {
    await api.deleteGoalProgress(goal.id, entryId);
    onRefresh();
  };

  const handleUnlinkActivity = async (activityName) => {
    await api.unlinkGoalActivity(goal.id, activityName);
    onRefresh();
  };

  const handleLinkCalendar = async () => {
    if (!selectedCalendar) return;
    const sc = subcalendars.find(s => s.calendarId === selectedCalendar);
    if (!sc) return;
    await api.linkGoalCalendar(goal.id, {
      subcalendarId: sc.calendarId,
      subcalendarName: sc.name,
      matchPattern: calendarMatchPattern
    });
    setSelectedCalendar('');
    setCalendarMatchPattern('');
    onRefresh();
  };

  const handleUnlinkCalendar = async (subcalendarId) => {
    await api.unlinkGoalCalendar(goal.id, subcalendarId);
    onRefresh();
  };

  const handleProgressChange = async (value) => {
    await api.updateGoalProgress(goal.id, value);
    onRefresh();
  };

  const handleAddTodo = async () => {
    if (!newTodoTitle.trim()) return;
    await api.addGoalTodo(goal.id, {
      title: newTodoTitle,
      priority: newTodoPriority,
      ...(newTodoEstimate ? { estimateMinutes: parseInt(newTodoEstimate, 10) } : {})
    });
    setNewTodoTitle('');
    setNewTodoPriority('medium');
    setNewTodoEstimate('');
    onRefresh();
  };

  const handleToggleTodo = async (todo) => {
    const nextStatus = todo.status === 'done' ? 'pending' : 'done';
    await api.updateGoalTodo(goal.id, todo.id, { status: nextStatus });
    onRefresh();
  };

  const handleDeleteTodo = async (todoId) => {
    await api.deleteGoalTodo(goal.id, todoId);
    onRefresh();
  };

  const addTag = () => {
    const tag = tagInput.trim().slice(0, MAX_TAG_LENGTH);
    if (tag && form.tags.length < MAX_TAGS && !form.tags.includes(tag)) {
      setForm({ ...form, tags: [...form.tags, tag] });
    }
    setTagInput('');
  };

  const removeTag = (tag) => {
    setForm({ ...form, tags: form.tags.filter(t => t !== tag) });
  };

  const urgencyColor = (u) => {
    if (u == null) return 'text-gray-500';
    if (u >= 0.7) return 'text-red-400';
    if (u >= 0.4) return 'text-yellow-400';
    return 'text-green-400';
  };

  // Exclude self and descendants from parent options to prevent cycles
  const getDescendantIds = (id) => {
    const ids = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const current = queue.shift();
      for (const g of (allGoals || [])) {
        if (g.parentId === current && !ids.has(g.id)) {
          ids.add(g.id);
          queue.push(g.id);
        }
      }
    }
    return ids;
  };
  const excludedIds = getDescendantIds(goal.id);
  const parentOptions = (allGoals || []).filter(g => !excludedIds.has(g.id));

  return (
    <div className="w-80 bg-port-card border-l border-port-border h-full overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded ${cat.bg}`}>
            <CatIcon className={`w-4 h-4 ${cat.color}`} />
          </div>
          <span className="text-sm font-medium text-white truncate">{goal.title}</span>
        </div>
        <button onClick={onClose} className="p-1 text-gray-500 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      {editing ? (
        <div className="space-y-3">
          <input
            type="text"
            value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
          />
          <textarea
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            rows={3}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white resize-none"
          />
          <div>
            <label className="text-xs text-gray-500">Horizon</label>
            <select
              value={form.horizon}
              onChange={e => setForm({ ...form, horizon: e.target.value })}
              className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white mt-1"
            >
              {HORIZON_OPTIONS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">Category</label>
            <select
              value={form.category}
              onChange={e => setForm({ ...form, category: e.target.value })}
              className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white mt-1"
            >
              {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">Parent Goal</label>
            <select
              value={form.parentId}
              onChange={e => setForm({ ...form, parentId: e.target.value })}
              className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white mt-1"
            >
              <option value="">None (root)</option>
              {parentOptions.map(g => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">Tags</label>
            <div className="flex flex-wrap gap-1 mt-1 mb-2">
              {form.tags.map(tag => (
                <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-accent/20 text-port-accent text-xs">
                  {tag}
                  <button onClick={() => removeTag(tag)} className="hover:text-white">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTag())}
                placeholder="Add tag..."
                className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
              />
              <button
                onClick={addTag}
                disabled={form.tags.length >= MAX_TAGS}
                className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={saveEdit} className="px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-blue-600">
              Save
            </button>
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-sm rounded bg-port-border text-gray-300">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Info */}
          {goal.description && (
            <p className="text-sm text-gray-400">{goal.description}</p>
          )}

          <div className="flex flex-wrap gap-2 text-xs">
            <span className={`px-2 py-0.5 rounded ${cat.bg} ${cat.color}`}>{cat.label}</span>
            <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-300">
              {HORIZON_OPTIONS.find(h => h.value === goal.horizon)?.label}
            </span>
            {goal.urgency != null && (
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded bg-gray-700 ${urgencyColor(goal.urgency)}`}>
                {goal.urgency >= 0.7 && <AlertTriangle className="w-3 h-3" />}
                {Math.round(goal.urgency * 100)}% urgency
              </span>
            )}
            <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-400">
              {goal.status}
            </span>
          </div>

          {/* Progress Bar */}
          <ProgressSlider goal={goal} onCommit={handleProgressChange} />

          {/* Todos */}
          <div>
            <div className="flex items-center gap-1 mb-2">
              <ListTodo className="w-3.5 h-3.5 text-gray-500" />
              <span className="text-xs font-medium text-gray-400">
                Todos ({goal.todos?.filter(t => t.status === 'done').length || 0}/{goal.todos?.length || 0})
              </span>
            </div>
            {goal.todos?.length > 0 && (
              <div className="space-y-1 mb-2">
                {goal.todos.map(todo => (
                  <div key={todo.id} className="flex items-center gap-2 text-xs group">
                    <button
                      onClick={() => handleToggleTodo(todo)}
                      className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                        todo.status === 'done'
                          ? 'bg-green-500/20 border-green-500 text-green-400'
                          : todo.status === 'in-progress'
                            ? 'bg-port-accent/20 border-port-accent text-port-accent'
                            : 'border-gray-600 hover:border-port-accent'
                      }`}
                    >
                      {todo.status === 'done' && <Check className="w-3 h-3" />}
                      {todo.status === 'in-progress' && <CircleDot className="w-2.5 h-2.5" />}
                    </button>
                    <span className={`flex-1 ${todo.status === 'done' ? 'text-gray-500 line-through' : 'text-gray-300'}`}>
                      {todo.title}
                    </span>
                    <span className={`shrink-0 px-1 py-0.5 rounded text-[10px] ${
                      todo.priority === 'high' ? 'bg-red-500/20 text-red-400' :
                      todo.priority === 'low' ? 'bg-gray-700 text-gray-500' :
                      'bg-yellow-500/20 text-yellow-400'
                    }`}>
                      {todo.priority}
                    </span>
                    {todo.estimateMinutes && (
                      <span className="shrink-0 text-gray-600">{todo.estimateMinutes}m</span>
                    )}
                    <button
                      onClick={() => handleDeleteTodo(todo.id)}
                      className="p-0.5 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={newTodoTitle}
                  onChange={e => setNewTodoTitle(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddTodo()}
                  placeholder="Add todo..."
                  className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                />
                <button
                  onClick={handleAddTodo}
                  disabled={!newTodoTitle.trim()}
                  className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              {newTodoTitle.trim() && (
                <div className="flex gap-1">
                  <select
                    value={newTodoPriority}
                    onChange={e => setNewTodoPriority(e.target.value)}
                    className="bg-port-bg border border-port-border rounded px-1.5 py-0.5 text-xs text-white"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                  <input
                    type="number"
                    value={newTodoEstimate}
                    onChange={e => setNewTodoEstimate(e.target.value)}
                    placeholder="Est. min"
                    min="1"
                    className="w-20 bg-port-bg border border-port-border rounded px-1.5 py-0.5 text-xs text-white"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Feasibility */}
          {goal.feasibility && (
            <div className="text-xs space-y-1">
              <div className="flex items-center gap-1.5 text-gray-400">
                <Activity className="w-3.5 h-3.5" />
                <span className="font-medium">Activity Budget</span>
              </div>
              <div className="pl-5 space-y-0.5">
                <div className="text-gray-300">
                  {goal.feasibility.totalPerWeek}/week across {goal.feasibility.links.length} {goal.feasibility.links.length === 1 ? 'activity' : 'activities'}
                </div>
                {goal.feasibility.links.map(l => (
                  <div key={l.activityName} className="text-gray-500">
                    {l.activityName}: {l.perWeek}/wk ({l.totalOverHorizon.toLocaleString()} total)
                  </div>
                ))}
                <div className="text-gray-500">
                  {goal.feasibility.weeksAvailable.toLocaleString()} weeks available
                </div>
              </div>
            </div>
          )}

          {/* Tags */}
          {goal.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {goal.tags.map(tag => (
                <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-accent/20 text-port-accent text-xs">
                  <Tag className="w-3 h-3" />
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Parent */}
          {parent && (
            <div className="text-xs text-gray-500">
              Parent: <span className="text-gray-300">{parent.title}</span>
            </div>
          )}

          {/* Children */}
          {children.length > 0 && (
            <div className="text-xs text-gray-500">
              Sub-goals: {children.map(c => c.title).join(', ')}
            </div>
          )}

          {/* Milestones */}
          <div>
            <div className="flex items-center gap-1 mb-2">
              <Milestone className="w-3.5 h-3.5 text-gray-500" />
              <span className="text-xs font-medium text-gray-400">
                Milestones ({goal.milestones?.filter(m => m.completedAt).length || 0}/{goal.milestones?.length || 0})
              </span>
            </div>
            {goal.milestones?.length > 0 && (
              <div className="space-y-1 mb-2">
                {goal.milestones.map(ms => (
                  <div key={ms.id} className="flex items-center gap-2 text-sm">
                    <button
                      onClick={() => !ms.completedAt && handleCompleteMilestone(ms.id)}
                      className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                        ms.completedAt
                          ? 'bg-green-500/20 border-green-500 text-green-400'
                          : 'border-gray-600 hover:border-port-accent'
                      }`}
                    >
                      {ms.completedAt && <Check className="w-3 h-3" />}
                    </button>
                    <span className={`text-xs ${ms.completedAt ? 'text-gray-500 line-through' : 'text-gray-300'}`}>
                      {ms.title}
                    </span>
                    {ms.targetDate && (
                      <span className="text-xs text-gray-600 ml-auto flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(ms.targetDate).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-1">
              <input
                type="text"
                value={newMilestone.title}
                onChange={e => setNewMilestone({ ...newMilestone, title: e.target.value })}
                onKeyDown={e => e.key === 'Enter' && handleAddMilestone()}
                placeholder="Add milestone..."
                className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
              />
              <button
                onClick={handleAddMilestone}
                disabled={!newMilestone.title.trim()}
                className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>

          {/* Progress Log */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1">
                <NotebookPen className="w-3.5 h-3.5 text-gray-500" />
                <span className="text-xs font-medium text-gray-400">
                  Progress ({goal.progressLog?.length || 0})
                </span>
                {goal.progressLog?.length > 0 && (
                  <span className="text-xs text-gray-600 ml-1">
                    {goal.progressLog.reduce((sum, e) => sum + (e.durationMinutes || 0), 0)}min total
                  </span>
                )}
              </div>
              <button
                onClick={() => setShowProgressForm(!showProgressForm)}
                className="p-0.5 text-gray-500 hover:text-port-accent"
                title="Log progress"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            {showProgressForm && (
              <div className="space-y-1.5 mb-2 p-2 rounded bg-port-bg border border-port-border">
                <input
                  type="date"
                  value={progressForm.date}
                  onChange={e => setProgressForm({ ...progressForm, date: e.target.value })}
                  className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                />
                <textarea
                  value={progressForm.note}
                  onChange={e => setProgressForm({ ...progressForm, note: e.target.value })}
                  placeholder="What did you work on?"
                  rows={2}
                  className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white resize-none"
                />
                <div className="flex items-center gap-1">
                  <Clock className="w-3 h-3 text-gray-500" />
                  <input
                    type="number"
                    value={progressForm.durationMinutes}
                    onChange={e => setProgressForm({ ...progressForm, durationMinutes: e.target.value })}
                    placeholder="Minutes (optional)"
                    min="1"
                    max="1440"
                    className="flex-1 bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={handleAddProgress}
                    disabled={!progressForm.note.trim()}
                    className="px-2 py-1 text-xs rounded bg-port-accent text-white disabled:opacity-50"
                  >
                    Log
                  </button>
                  <button
                    onClick={resetProgressForm}
                    className="px-2 py-1 text-xs rounded bg-port-border text-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {goal.progressLog?.length > 0 && (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {[...goal.progressLog].reverse().map(entry => (
                  <div key={entry.id} className="flex items-start gap-2 text-xs group">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-gray-500">
                        <span>{new Date(entry.date + 'T00:00:00').toLocaleDateString()}</span>
                        {entry.durationMinutes && (
                          <span className="flex items-center gap-0.5">
                            <Clock className="w-3 h-3" />
                            {entry.durationMinutes >= 60
                              ? `${Math.floor(entry.durationMinutes / 60)}h${entry.durationMinutes % 60 ? ` ${entry.durationMinutes % 60}m` : ''}`
                              : `${entry.durationMinutes}m`}
                          </span>
                        )}
                      </div>
                      <p className="text-gray-300 mt-0.5">{entry.note}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteProgress(entry.id)}
                      className="p-0.5 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Linked Activities */}
          <div>
            <div className="flex items-center gap-1 mb-2">
              <Link2 className="w-3.5 h-3.5 text-gray-500" />
              <span className="text-xs font-medium text-gray-400">
                Activities ({goal.linkedActivities?.length || 0})
              </span>
            </div>
            {goal.linkedActivities?.length > 0 && (
              <div className="space-y-1 mb-2">
                {goal.linkedActivities.map(link => (
                  <div key={link.activityName} className="flex items-center gap-2 text-xs">
                    <span className="text-gray-300 flex-1">{link.activityName}</span>
                    {link.note && <span className="text-gray-600 truncate max-w-[100px]" title={link.note}>{link.note}</span>}
                    <button
                      onClick={() => handleUnlinkActivity(link.activityName)}
                      className="p-0.5 text-gray-600 hover:text-red-400"
                      title="Unlink"
                    >
                      <Unlink className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {activities.length > 0 && (
              <div className="flex gap-1">
                <select
                  value={selectedActivity}
                  onChange={e => setSelectedActivity(e.target.value)}
                  className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                >
                  <option value="">Link activity...</option>
                  {activities
                    .filter(a => !goal.linkedActivities?.some(l => l.activityName === a.name))
                    .map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
                </select>
                <button
                  onClick={handleLinkActivity}
                  disabled={!selectedActivity}
                  className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50"
                >
                  Link
                </button>
              </div>
            )}
          </div>

          {/* Linked Calendars */}
          <div>
            <div className="flex items-center gap-1 mb-2">
              <CalendarDays className="w-3.5 h-3.5 text-gray-500" />
              <span className="text-xs font-medium text-gray-400">
                Calendars ({goal.linkedCalendars?.length || 0})
              </span>
            </div>
            {goal.linkedCalendars?.length > 0 && (
              <div className="space-y-1 mb-2">
                {goal.linkedCalendars.map(lc => (
                  <div key={lc.subcalendarId} className="flex items-center gap-2 text-xs">
                    <span className="text-gray-300 flex-1 truncate">{lc.subcalendarName}</span>
                    {lc.matchPattern && (
                      <span className="text-gray-600 truncate max-w-[80px]" title={`Pattern: ${lc.matchPattern}`}>
                        /{lc.matchPattern}/
                      </span>
                    )}
                    <button
                      onClick={() => handleUnlinkCalendar(lc.subcalendarId)}
                      className="p-0.5 text-gray-600 hover:text-red-400"
                      title="Unlink"
                    >
                      <Unlink className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {subcalendars.length > 0 && (
              <div className="space-y-1">
                <div className="flex gap-1">
                  <select
                    value={selectedCalendar}
                    onChange={e => setSelectedCalendar(e.target.value)}
                    className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                  >
                    <option value="">Link calendar...</option>
                    {subcalendars
                      .filter(sc => !goal.linkedCalendars?.some(lc => lc.subcalendarId === sc.calendarId))
                      .map(sc => <option key={sc.calendarId} value={sc.calendarId}>{sc.name}</option>)}
                  </select>
                  <button
                    onClick={handleLinkCalendar}
                    disabled={!selectedCalendar}
                    className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50"
                  >
                    Link
                  </button>
                </div>
                {selectedCalendar && (
                  <input
                    type="text"
                    value={calendarMatchPattern}
                    onChange={e => setCalendarMatchPattern(e.target.value)}
                    placeholder="Match pattern (optional)"
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2 border-t border-port-border">
            <button
              onClick={startEdit}
              className="px-3 py-1.5 text-xs rounded bg-port-border text-gray-300 hover:bg-gray-600"
            >
              Edit
            </button>
            {goal.status === 'active' && (
              <button
                onClick={handleComplete}
                className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-green-500/20 text-green-400 hover:bg-green-500/30"
              >
                <Check className="w-3 h-3" />
                Complete
              </button>
            )}
            <button
              onClick={handleDelete}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
            >
              <Trash2 className="w-3 h-3" />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
