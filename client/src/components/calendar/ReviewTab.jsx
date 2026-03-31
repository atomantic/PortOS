import { useState, useEffect, useCallback } from 'react';
import { Check, X, ChevronLeft, ChevronRight, Clock, Target, AlertTriangle, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';

function formatDuration(minutes) {
  if (!minutes) return '';
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${minutes}m`;
}

function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ReviewTab() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [editForm, setEditForm] = useState({ durationMinutes: '', note: '', goalId: '' });

  const fetchReview = useCallback(async () => {
    setLoading(true);
    const data = await api.getDailyReview(date).catch(() => null);
    setReview(data);
    setLoading(false);
  }, [date]);

  useEffect(() => {
    fetchReview();
  }, [fetchReview]);

  const changeDate = (delta) => {
    const d = new Date(date + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().slice(0, 10));
  };

  const handleConfirm = async (event, happened) => {
    const eventId = event.id || event.externalId;
    setConfirming(eventId);

    // If event has matching goals and happened, show edit form
    if (happened && event.matchingGoals?.length > 0 && !editingEvent) {
      const startTime = event.startTime ? new Date(event.startTime) : null;
      const endTime = event.endTime ? new Date(event.endTime) : null;
      const durationMinutes = startTime && endTime && !event.isAllDay
        ? Math.round((endTime - startTime) / 60000)
        : '';
      setEditingEvent(eventId);
      setEditForm({
        durationMinutes: durationMinutes || '',
        note: event.title || '',
        goalId: event.matchingGoals[0]?.goalId || ''
      });
      setConfirming(null);
      return;
    }

    const data = { eventId, happened };
    if (happened && editingEvent === eventId) {
      data.goalId = editForm.goalId || undefined;
      data.durationMinutes = editForm.durationMinutes ? parseInt(editForm.durationMinutes, 10) : undefined;
      data.note = editForm.note || undefined;
    }

    const result = await api.confirmDailyReviewEvent(date, data).catch(() => null);
    setConfirming(null);
    setEditingEvent(null);

    if (!result) return toast.error('Failed to confirm event');
    if (result.progressEntry) {
      toast.success('Event confirmed & progress logged');
    } else {
      toast.success(happened ? 'Event confirmed' : 'Event skipped');
    }
    fetchReview();
  };

  const handleConfirmWithEdit = async (event) => {
    const eventId = event.id || event.externalId;
    setConfirming(eventId);

    const data = {
      eventId,
      happened: true,
      goalId: editForm.goalId || undefined,
      durationMinutes: editForm.durationMinutes ? parseInt(editForm.durationMinutes, 10) : undefined,
      note: editForm.note || undefined
    };

    const result = await api.confirmDailyReviewEvent(date, data).catch(() => null);
    setConfirming(null);
    setEditingEvent(null);

    if (!result) return toast.error('Failed to confirm event');
    toast.success(result.progressEntry ? 'Event confirmed & progress logged' : 'Event confirmed');
    fetchReview();
  };

  const isToday = date === new Date().toISOString().slice(0, 10);
  const isSyncStale = review?.lastSyncAt
    ? (Date.now() - new Date(review.lastSyncAt).getTime()) > 12 * 60 * 60 * 1000
    : true;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Date Navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => changeDate(-1)} className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-white">
            <ChevronLeft size={18} />
          </button>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-port-accent"
          />
          <button onClick={() => changeDate(1)} className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-white">
            <ChevronRight size={18} />
          </button>
          {!isToday && (
            <button
              onClick={() => setDate(new Date().toISOString().slice(0, 10))}
              className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent"
            >
              Today
            </button>
          )}
        </div>
        {isSyncStale && (
          <div className="flex items-center gap-1.5 text-xs text-port-warning">
            <AlertTriangle size={14} />
            <span>{review?.lastSyncAt ? 'Sync data may be stale' : 'No sync data'}</span>
          </div>
        )}
      </div>

      {/* Summary */}
      {review && (
        <div className="flex gap-4 text-xs">
          <span className="text-gray-500">{review.summary.totalEvents} events</span>
          {review.summary.confirmed > 0 && (
            <span className="text-port-success">{review.summary.confirmed} confirmed</span>
          )}
          {review.summary.skipped > 0 && (
            <span className="text-gray-500">{review.summary.skipped} skipped</span>
          )}
          {review.summary.unreviewed > 0 && (
            <span className="text-port-accent">{review.summary.unreviewed} to review</span>
          )}
          {review.progressEntries?.length > 0 && (
            <span className="text-port-accent">
              {review.progressEntries.reduce((sum, e) => sum + (e.durationMinutes || 0), 0)}min logged
            </span>
          )}
        </div>
      )}

      {/* Events */}
      {(!review?.events?.length) ? (
        <div className="text-center py-12 text-gray-500">
          <p>No events for this date</p>
          <p className="text-sm mt-1">Sync your calendar to see events here</p>
        </div>
      ) : (
        <div className="space-y-2">
          {[...review.events]
            .sort((a, b) => {
              if (a.isAllDay && !b.isAllDay) return -1;
              if (!a.isAllDay && b.isAllDay) return 1;
              return (a.startTime || '').localeCompare(b.startTime || '');
            })
            .map(event => {
              const eventId = event.id || event.externalId;
              const isConfirmed = event.confirmation?.happened === true;
              const isSkipped = event.confirmation?.happened === false;
              const isReviewed = isConfirmed || isSkipped;
              const isEditing = editingEvent === eventId;

              return (
                <div
                  key={eventId}
                  className={`p-3 rounded-lg border transition-colors ${
                    isConfirmed
                      ? 'bg-port-success/5 border-port-success/30'
                      : isSkipped
                        ? 'bg-gray-900/50 border-gray-700 opacity-60'
                        : 'bg-port-card border-port-border'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      {event.subcalendarColor && (
                        <div
                          className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                          style={{ backgroundColor: event.subcalendarColor }}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium ${isSkipped ? 'line-through text-gray-500' : 'text-white'}`}>
                            {event.title}
                          </span>
                          {event.matchingGoals?.length > 0 && (
                            <Target size={12} className="text-port-accent shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                          {event.isAllDay ? (
                            <span>All day</span>
                          ) : (
                            <span>{formatTime(event.startTime)} - {formatTime(event.endTime)}</span>
                          )}
                          {event.subcalendarName && (
                            <span>· {event.subcalendarName}</span>
                          )}
                          {event.source && event.source !== 'google-calendar' && (
                            <span>· {event.source}</span>
                          )}
                        </div>
                        {event.location && (
                          <div className="text-xs text-gray-600 mt-0.5">{event.location}</div>
                        )}
                        {event.matchingGoals?.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {event.matchingGoals.map(mg => (
                              <span key={mg.goalId} className="text-xs px-1.5 py-0.5 rounded bg-port-accent/10 text-port-accent">
                                {mg.goalTitle}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {!isReviewed && !isEditing && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleConfirm(event, true)}
                          disabled={confirming === eventId}
                          className="p-1.5 rounded hover:bg-port-success/20 text-gray-500 hover:text-port-success transition-colors"
                          title="Confirm - it happened"
                        >
                          <Check size={16} />
                        </button>
                        <button
                          onClick={() => handleConfirm(event, false)}
                          disabled={confirming === eventId}
                          className="p-1.5 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors"
                          title="Skip - didn't happen"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    )}

                    {isReviewed && (
                      <div className="shrink-0">
                        {isConfirmed ? (
                          <Check size={16} className="text-port-success" />
                        ) : (
                          <X size={16} className="text-gray-600" />
                        )}
                      </div>
                    )}
                  </div>

                  {/* Edit form for goal-linked events */}
                  {isEditing && (
                    <div className="mt-2 pt-2 border-t border-port-border space-y-2">
                      <div className="text-xs text-gray-400">Log progress for this event:</div>
                      <div className="flex gap-2">
                        <select
                          value={editForm.goalId}
                          onChange={e => setEditForm(f => ({ ...f, goalId: e.target.value }))}
                          className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                        >
                          <option value="">No goal</option>
                          {event.matchingGoals?.map(mg => (
                            <option key={mg.goalId} value={mg.goalId}>{mg.goalTitle}</option>
                          ))}
                        </select>
                        <div className="flex items-center gap-1">
                          <Clock size={12} className="text-gray-500" />
                          <input
                            type="number"
                            value={editForm.durationMinutes}
                            onChange={e => setEditForm(f => ({ ...f, durationMinutes: e.target.value }))}
                            placeholder="min"
                            min="1"
                            max="1440"
                            className="w-16 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                          />
                        </div>
                      </div>
                      <input
                        type="text"
                        value={editForm.note}
                        onChange={e => setEditForm(f => ({ ...f, note: e.target.value }))}
                        placeholder="Note (optional)"
                        className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                      />
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => handleConfirmWithEdit(event)}
                          disabled={confirming === eventId}
                          className="px-2.5 py-1 text-xs rounded bg-port-success/20 text-port-success hover:bg-port-success/30"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => { setEditingEvent(null); }}
                          className="px-2.5 py-1 text-xs rounded bg-port-border text-gray-400"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {/* Progress Entries */}
      {review?.progressEntries?.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-2">Progress Logged Today</h3>
          <div className="space-y-1">
            {review.progressEntries.map(entry => (
              <div key={entry.id} className="flex items-center gap-2 text-xs py-1">
                <Target size={12} className="text-port-accent shrink-0" />
                <span className="text-gray-400">{entry.goalTitle}</span>
                <span className="text-gray-300">{entry.note}</span>
                {entry.durationMinutes && (
                  <span className="text-gray-500 flex items-center gap-0.5">
                    <Clock size={10} />
                    {formatDuration(entry.durationMinutes)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
