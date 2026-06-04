import { X, AlertTriangle, Calendar, Activity, Tag, Check, Trash2 } from 'lucide-react';
import Pill from '../ui/Pill';
import {
  CATEGORY_CONFIG, HORIZON_OPTIONS, GOAL_TYPE_CONFIG, GOAL_TYPE_OPTIONS, DEFAULT_NEW_GOAL
} from './goalConstants';
import { useGoalDetail } from '../../hooks/useGoalDetail';
import ProgressSlider from './ProgressSlider';
import GoalEditForm from './GoalEditForm';
import GoalTodoList from './GoalTodoList';
import GoalMilestones from './GoalMilestones';
import GoalPlanSection from './GoalPlanSection';
import GoalCheckIns from './GoalCheckIns';
import GoalProgressLog from './GoalProgressLog';
import GoalLinkedActivities from './GoalLinkedActivities';
import GoalLinkedCalendars from './GoalLinkedCalendars';

// Re-exported for backward compatibility — GoalsListView/GoalsTreeView/GoalProgressWidget
// import these from GoalDetailPanel. Source of truth is ./goalConstants.
export { CATEGORY_CONFIG, HORIZON_OPTIONS, GOAL_TYPE_CONFIG, GOAL_TYPE_OPTIONS, DEFAULT_NEW_GOAL };

const urgencyColor = (u) => {
  if (u == null) return 'text-gray-500';
  if (u >= 0.7) return 'text-red-400';
  if (u >= 0.4) return 'text-yellow-400';
  return 'text-green-400';
};

export default function GoalDetailPanel({ goal, allGoals, onClose, onRefresh }) {
  const s = useGoalDetail({ goal, allGoals, onClose, onRefresh });

  if (!goal) return null;

  const cat = CATEGORY_CONFIG[goal.category] || CATEGORY_CONFIG.mastery;
  const CatIcon = cat.icon;
  const parent = goal.parentId ? allGoals?.find(g => g.id === goal.parentId) : null;
  const children = allGoals?.filter(g => g.parentId === goal.id) || [];

  const excludedIds = s.getDescendantIds(goal.id);
  const parentOptions = (allGoals || []).filter(g => !excludedIds.has(g.id));

  return (
    <div className="w-full sm:w-80 bg-port-card border-l border-port-border h-full overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`p-1.5 rounded ${cat.bg} shrink-0`}>
            <CatIcon className={`w-4 h-4 ${cat.color}`} />
          </div>
          <span className="text-sm font-medium text-white truncate">{goal.title}</span>
          {goal.goalType && goal.goalType !== 'standard' && (
            // Not <Pill>: text-xs + px-1.5 is a size combo Pill doesn't carry, and
            // its sm/xs padding would override the className, shifting this badge.
            <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${GOAL_TYPE_CONFIG[goal.goalType]?.bg} ${GOAL_TYPE_CONFIG[goal.goalType]?.color}`}>
              {GOAL_TYPE_CONFIG[goal.goalType]?.label}
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-1 text-gray-500 hover:text-white shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      {s.editing ? (
        <GoalEditForm
          form={s.form}
          setForm={s.setForm}
          tagInput={s.tagInput}
          setTagInput={s.setTagInput}
          addTag={s.addTag}
          removeTag={s.removeTag}
          parentOptions={parentOptions}
          saveEdit={s.saveEdit}
          onCancel={() => s.setEditing(false)}
        />
      ) : (
        <>
          {/* Info */}
          {goal.description && (
            <p className="text-sm text-gray-400">{goal.description}</p>
          )}

          <div className="flex flex-wrap gap-2 text-xs">
            <Pill tone="bare" bordered={false} className={`${cat.bg} ${cat.color}`}>{cat.label}</Pill>
            <Pill tone="bare" bordered={false} className="bg-gray-700 text-gray-300">
              {HORIZON_OPTIONS.find(h => h.value === goal.horizon)?.label}
            </Pill>
            {goal.urgency != null && (
              <Pill tone="bare" bordered={false} icon={goal.urgency >= 0.7 ? AlertTriangle : undefined} className={`bg-gray-700 ${urgencyColor(goal.urgency)}`}>
                {Math.round(goal.urgency * 100)}% urgency
              </Pill>
            )}
            <Pill tone="bare" bordered={false} className="bg-gray-700 text-gray-400">
              {goal.status}
            </Pill>
          </div>

          {/* Progress Bar */}
          <ProgressSlider goal={goal} onCommit={s.handleProgressChange} />

          {/* Todos */}
          <GoalTodoList
            goal={goal}
            newTodoTitle={s.newTodoTitle}
            setNewTodoTitle={s.setNewTodoTitle}
            newTodoPriority={s.newTodoPriority}
            setNewTodoPriority={s.setNewTodoPriority}
            newTodoEstimate={s.newTodoEstimate}
            setNewTodoEstimate={s.setNewTodoEstimate}
            handleAddTodo={s.handleAddTodo}
            handleToggleTodo={s.handleToggleTodo}
            handleDeleteTodo={s.handleDeleteTodo}
          />

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
                <Pill key={tag} tone="bare" bordered={false} icon={Tag} className="bg-port-accent/20 text-port-accent">
                  {tag}
                </Pill>
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
          <GoalMilestones
            goal={goal}
            newMilestone={s.newMilestone}
            setNewMilestone={s.setNewMilestone}
            handleAddMilestone={s.handleAddMilestone}
            handleCompleteMilestone={s.handleCompleteMilestone}
          />

          {/* Target Date */}
          {goal.targetDate && (
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <Calendar className="w-3.5 h-3.5" />
              <span>Target: {new Date(goal.targetDate + 'T00:00:00').toLocaleDateString()}</span>
            </div>
          )}

          {/* Plan Section */}
          <GoalPlanSection
            goal={goal}
            planOpen={s.planOpen}
            setPlanOpen={s.setPlanOpen}
            generatingPhases={s.generatingPhases}
            handleGeneratePhases={s.handleGeneratePhases}
            proposedPhases={s.proposedPhases}
            setProposedPhases={s.setProposedPhases}
            handleAcceptPhases={s.handleAcceptPhases}
            schedulingBusy={s.schedulingBusy}
            handleSchedule={s.handleSchedule}
            handleReschedule={s.handleReschedule}
            handleRemoveSchedule={s.handleRemoveSchedule}
          />

          {/* Check-ins */}
          <GoalCheckIns
            goal={goal}
            checkInsOpen={s.checkInsOpen}
            setCheckInsOpen={s.setCheckInsOpen}
            checkingIn={s.checkingIn}
            handleCheckIn={s.handleCheckIn}
          />

          {/* Progress Log */}
          <GoalProgressLog
            goal={goal}
            showProgressForm={s.showProgressForm}
            setShowProgressForm={s.setShowProgressForm}
            progressForm={s.progressForm}
            setProgressForm={s.setProgressForm}
            handleAddProgress={s.handleAddProgress}
            resetProgressForm={s.resetProgressForm}
            handleDeleteProgress={s.handleDeleteProgress}
          />

          {/* Linked Activities */}
          <GoalLinkedActivities
            goal={goal}
            activities={s.activities}
            selectedActivity={s.selectedActivity}
            setSelectedActivity={s.setSelectedActivity}
            handleLinkActivity={s.handleLinkActivity}
            handleUnlinkActivity={s.handleUnlinkActivity}
          />

          {/* Linked Calendars */}
          <GoalLinkedCalendars
            goal={goal}
            subcalendars={s.subcalendars}
            selectedCalendar={s.selectedCalendar}
            setSelectedCalendar={s.setSelectedCalendar}
            calendarMatchPattern={s.calendarMatchPattern}
            setCalendarMatchPattern={s.setCalendarMatchPattern}
            handleLinkCalendar={s.handleLinkCalendar}
            handleUnlinkCalendar={s.handleUnlinkCalendar}
          />

          {/* Actions */}
          <div className="flex gap-2 pt-2 border-t border-port-border">
            <button
              onClick={s.startEdit}
              className="px-3 py-1.5 text-xs rounded bg-port-border text-gray-300 hover:bg-gray-600"
            >
              Edit
            </button>
            {goal.status === 'active' && (
              <button
                onClick={s.handleComplete}
                className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-green-500/20 text-green-400 hover:bg-green-500/30"
              >
                <Check className="w-3 h-3" />
                Complete
              </button>
            )}
            <button
              onClick={s.handleDelete}
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
