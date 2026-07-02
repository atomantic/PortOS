import { Milestone, Check, Calendar } from 'lucide-react';
import { PRIORITY_BADGE } from './goalConstants';

export default function GoalMilestones({
  goal, newMilestone, setNewMilestone, handleAddMilestone, handleCompleteMilestone,
  handleCompleteMilestoneTask
}) {
  return (
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
            <div key={ms.id} className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <button
                  onClick={() => !ms.completedAt && handleCompleteMilestone(ms.id)}
                  className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                    ms.completedAt
                      ? 'bg-port-success/20 border-port-success text-port-success'
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
              {ms.tasks?.length > 0 && (
                <div className="pl-6 space-y-0.5">
                  {ms.tasks.map(task => {
                    const done = task.status === 'done';
                    return (
                      <div key={task.id} className="flex items-center gap-1.5 text-[11px]">
                        <button
                          onClick={() => handleCompleteMilestoneTask?.(ms.id, task.id)}
                          className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                            done
                              ? 'bg-port-success/20 border-port-success text-port-success'
                              : 'border-gray-600 hover:border-port-accent'
                          }`}
                        >
                          {done && <Check className="w-2.5 h-2.5" />}
                        </button>
                        <span className={`flex-1 min-w-0 truncate ${done ? 'text-gray-600 line-through' : 'text-gray-400'}`}>
                          {task.title}
                        </span>
                        {task.estimateMinutes != null && (
                          <span className="text-gray-600 shrink-0">{task.estimateMinutes}m</span>
                        )}
                        <span className={`shrink-0 px-1 rounded ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.medium}`}>
                          {task.priority || 'medium'}
                        </span>
                      </div>
                    );
                  })}
                </div>
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
  );
}
