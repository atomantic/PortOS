import { useState, useEffect } from 'react';
import * as api from '../services/api';
import { MAX_TAGS, MAX_TAG_LENGTH } from '../components/goals/goalConstants';

// State + handlers backing GoalDetailPanel. Extracted so the panel can stay a
// thin composition shell; behavior is identical to the prior inline logic.
export function useGoalDetail({ goal, allGoals, onClose, onRefresh }) {
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
  // Plan & scheduling state
  const [planOpen, setPlanOpen] = useState(false);
  const [generatingPhases, setGeneratingPhases] = useState(false);
  const [proposedPhases, setProposedPhases] = useState(null);
  const [schedulingBusy, setSchedulingBusy] = useState(false);
  const [checkInsOpen, setCheckInsOpen] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);

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

  const startEdit = () => {
    setForm({
      title: goal.title,
      description: goal.description || '',
      horizon: goal.horizon,
      category: goal.category,
      goalType: goal.goalType || 'standard',
      parentId: goal.parentId || '',
      tags: [...(goal.tags || [])],
      targetDate: goal.targetDate || '',
      timeBlockConfig: goal.timeBlockConfig || null
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    await api.updateGoal(goal.id, {
      ...form,
      parentId: form.parentId || null,
      targetDate: form.targetDate || null,
      timeBlockConfig: form.timeBlockConfig || null
    });
    setEditing(false);
    onRefresh();
  };

  const handleGeneratePhases = async () => {
    setGeneratingPhases(true);
    const phases = await api.generateGoalPhases(goal.id).catch(() => null);
    setGeneratingPhases(false);
    if (phases) setProposedPhases(phases);
  };

  const handleAcceptPhases = async () => {
    if (!proposedPhases?.length) return;
    await api.acceptGoalPhases(goal.id, proposedPhases);
    setProposedPhases(null);
    onRefresh();
  };

  const handleCheckIn = async () => {
    setCheckingIn(true);
    await api.checkInGoal(goal.id).catch(() => null);
    setCheckingIn(false);
    setCheckInsOpen(true);
    onRefresh();
  };

  const handleSchedule = async () => {
    setSchedulingBusy(true);
    await api.scheduleGoalTimeBlocks(goal.id);
    setSchedulingBusy(false);
    onRefresh();
  };

  const handleRemoveSchedule = async () => {
    setSchedulingBusy(true);
    await api.removeGoalSchedule(goal.id);
    setSchedulingBusy(false);
    onRefresh();
  };

  const handleReschedule = async () => {
    setSchedulingBusy(true);
    await api.rescheduleGoalTimeBlocks(goal.id);
    setSchedulingBusy(false);
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

  return {
    editing, setEditing,
    form, setForm,
    tagInput, setTagInput,
    newMilestone, setNewMilestone,
    activities,
    selectedActivity, setSelectedActivity,
    showProgressForm, setShowProgressForm,
    progressForm, setProgressForm,
    subcalendars,
    selectedCalendar, setSelectedCalendar,
    calendarMatchPattern, setCalendarMatchPattern,
    newTodoTitle, setNewTodoTitle,
    newTodoPriority, setNewTodoPriority,
    newTodoEstimate, setNewTodoEstimate,
    planOpen, setPlanOpen,
    generatingPhases,
    proposedPhases, setProposedPhases,
    schedulingBusy,
    checkInsOpen, setCheckInsOpen,
    checkingIn,
    startEdit, saveEdit,
    handleGeneratePhases, handleAcceptPhases,
    handleCheckIn, handleSchedule, handleRemoveSchedule, handleReschedule,
    handleDelete, handleComplete,
    handleAddMilestone, handleCompleteMilestone,
    handleLinkActivity, handleAddProgress, resetProgressForm, handleDeleteProgress,
    handleUnlinkActivity, handleLinkCalendar, handleUnlinkCalendar,
    handleProgressChange, handleAddTodo, handleToggleTodo, handleDeleteTodo,
    addTag, removeTag, getDescendantIds
  };
}
