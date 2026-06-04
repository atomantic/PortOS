import { Link2, Unlink } from 'lucide-react';

export default function GoalLinkedActivities({
  goal, activities, selectedActivity, setSelectedActivity,
  handleLinkActivity, handleUnlinkActivity
}) {
  return (
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
  );
}
