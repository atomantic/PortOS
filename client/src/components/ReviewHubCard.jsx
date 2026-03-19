import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Crown, CheckCircle2 } from 'lucide-react';
import * as api from '../services/api';
import socket from '../services/socket';

export default function ReviewHubCard() {
  const [counts, setCounts] = useState(null);

  useEffect(() => {
    api.getReviewCounts().then(setCounts).catch(() => null);

    const refresh = () => api.getReviewCounts().then(setCounts).catch(() => null);
    socket.on('review:item:created', refresh);
    socket.on('review:item:updated', refresh);
    socket.on('review:item:deleted', refresh);

    return () => {
      socket.off('review:item:created', refresh);
      socket.off('review:item:updated', refresh);
      socket.off('review:item:deleted', refresh);
    };
  }, []);

  const total = counts?.total ?? 0;

  return (
    <Link
      to="/review"
      className="bg-port-card border border-port-border rounded-xl p-4 hover:border-port-accent/50 transition-colors block"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Review Hub</h3>
        {total > 0 && (
          <span className="min-w-[22px] h-[22px] flex items-center justify-center text-xs font-bold rounded-full bg-port-warning text-black px-1.5">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </div>

      {total === 0 ? (
        <p className="text-sm text-gray-500">All caught up!</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {counts?.alert > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-port-warning">
              <AlertTriangle size={14} />
              <span>{counts.alert} alert{counts.alert !== 1 ? 's' : ''}</span>
            </div>
          )}
          {counts?.cos > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-port-accent">
              <Crown size={14} />
              <span>{counts.cos} CoS</span>
            </div>
          )}
          {counts?.todo > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-port-success">
              <CheckCircle2 size={14} />
              <span>{counts.todo} todo{counts.todo !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>
      )}
    </Link>
  );
}
