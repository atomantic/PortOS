import { useState, useEffect, useCallback } from 'react';
import * as api from '../../../services/api';
import { ACTION_TYPES } from '../constants';

export default function ActivityTab({ agentId }) {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');
  const [hasMore, setHasMore] = useState(true);

  const fetchData = useCallback(async () => {
    const activitiesData = await api.getAgentActivities(
      50, [agentId], actionFilter || null
    );
    setActivities(activitiesData);
    setHasMore(activitiesData.length >= 50);
    setLoading(false);
  }, [agentId, actionFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const loadMore = async () => {
    if (activities.length === 0) return;

    const lastTimestamp = activities[activities.length - 1].timestamp;
    const moreData = await api.getAgentActivityTimeline(
      50, [agentId], lastTimestamp
    );

    if (moreData.length < 50) {
      setHasMore(false);
    }

    setActivities(prev => [...prev, ...moreData]);
  };

  const getActionIcon = (action) => {
    const actionType = ACTION_TYPES.find(a => a.value === action);
    return actionType?.icon || '📋';
  };

  const getStatusStyle = (status) => {
    switch (status) {
      case 'completed':
        return 'bg-port-success/20 text-port-success';
      case 'started':
        return 'bg-port-accent/20 text-port-accent';
      case 'failed':
        return 'bg-port-error/20 text-port-error';
      default:
        return 'bg-port-border text-gray-400';
    }
  };

  if (loading) {
    return <div className="p-4 text-gray-400">Loading activity...</div>;
  }

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-white">Activity Log</h2>
        <div className="flex gap-2">
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="px-3 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
          >
            <option value="">All Actions</option>
            {ACTION_TYPES.map(action => (
              <option key={action.value} value={action.value}>
                {action.icon} {action.label}
              </option>
            ))}
          </select>
          <button
            onClick={fetchData}
            className="px-3 py-1 bg-port-border text-gray-300 rounded text-sm hover:bg-port-border/80"
          >
            Refresh
          </button>
        </div>
      </div>

      {activities.length === 0 ? (
        <div className="text-center py-8 text-gray-400">
          <p className="text-lg mb-2">No activity yet</p>
          <p className="text-sm">Agent actions will appear here</p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {activities.map((activity, index) => (
              <div
                key={`${activity.id}-${index}`}
                className="p-3 bg-port-card border border-port-border rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{getActionIcon(activity.action)}</span>
                      <span className="text-gray-300">{activity.action}</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${getStatusStyle(activity.status)}`}>
                        {activity.status}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {new Date(activity.timestamp).toLocaleString()}
                      {activity.scheduleId && (
                        <span className="ml-2">• Scheduled</span>
                      )}
                    </div>
                  </div>
                  {activity.result && (
                    <div className="text-sm text-gray-400">
                      {typeof activity.result === 'string'
                        ? activity.result.slice(0, 50)
                        : JSON.stringify(activity.result).slice(0, 50)}
                      {(typeof activity.result === 'string' ? activity.result.length : JSON.stringify(activity.result).length) > 50 && '...'}
                    </div>
                  )}
                  {activity.error && (
                    <div className="text-sm text-port-error">
                      {activity.error.slice(0, 50)}
                      {activity.error.length > 50 && '...'}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {hasMore && (
            <div className="mt-4 text-center">
              <button
                onClick={loadMore}
                className="px-4 py-2 bg-port-border text-gray-300 rounded hover:bg-port-border/80"
              >
                Load More
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
