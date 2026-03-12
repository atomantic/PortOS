import { X, MapPin, Clock, Users, Repeat, CalendarDays } from 'lucide-react';

const RSVP_STYLES = {
  accepted: 'bg-port-success/20 text-port-success',
  declined: 'bg-port-error/20 text-port-error',
  tentative: 'bg-port-warning/20 text-port-warning',
  none: 'bg-gray-700 text-gray-400'
};

function formatDateTime(dateStr, isAllDay) {
  if (isAllDay) return new Date(dateStr).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return new Date(dateStr).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function EventDetail({ event, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        role="button"
        tabIndex={0}
        aria-label="Close panel"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        onKeyDown={(e) => (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') && onClose()}
      />
      <div className="relative w-full max-w-md bg-port-card border-l border-port-border overflow-y-auto animate-slide-in-right">
        <div className="sticky top-0 bg-port-card border-b border-port-border p-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white truncate">{event.title}</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Time */}
          <div className="flex items-start gap-3">
            <Clock size={16} className="text-gray-500 mt-0.5 shrink-0" />
            <div className="text-sm text-gray-300">
              {event.isAllDay ? (
                <div className="flex items-center gap-2">
                  <CalendarDays size={14} className="text-port-accent" />
                  <span>All day</span>
                </div>
              ) : (
                <>
                  <div>{formatDateTime(event.startTime, false)}</div>
                  <div className="text-gray-500">to</div>
                  <div>{formatDateTime(event.endTime, false)}</div>
                </>
              )}
              {event.isAllDay && (
                <div className="mt-1 text-gray-500">{formatDateTime(event.startTime, true)}</div>
              )}
            </div>
          </div>

          {/* Location */}
          {event.location && (
            <div className="flex items-start gap-3">
              <MapPin size={16} className="text-gray-500 mt-0.5 shrink-0" />
              <span className="text-sm text-gray-300">{event.location}</span>
            </div>
          )}

          {/* Recurrence */}
          {event.recurrence && (
            <div className="flex items-start gap-3">
              <Repeat size={16} className="text-gray-500 mt-0.5 shrink-0" />
              <span className="text-sm text-gray-300">Recurring event</span>
            </div>
          )}

          {/* Description */}
          {event.description && (
            <div className="p-3 bg-port-bg rounded-lg border border-port-border">
              <p className="text-sm text-gray-400 whitespace-pre-wrap break-words">{event.description}</p>
            </div>
          )}

          {/* Organizer */}
          {event.organizer && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Organizer</h3>
              <div className="text-sm text-gray-300">
                {event.organizer.name || event.organizer.email}
                {event.organizer.name && event.organizer.email && (
                  <span className="text-gray-500 ml-1">({event.organizer.email})</span>
                )}
              </div>
            </div>
          )}

          {/* Attendees */}
          {event.attendees?.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2 flex items-center gap-2">
                <Users size={14} />
                Attendees ({event.attendees.length})
              </h3>
              <div className="space-y-1.5">
                {event.attendees.map((attendee, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-2 bg-port-bg rounded border border-port-border"
                  >
                    <div className="text-sm text-gray-300 truncate">
                      {attendee.name || attendee.email}
                      {attendee.name && attendee.email && (
                        <span className="text-gray-500 ml-1 text-xs">({attendee.email})</span>
                      )}
                    </div>
                    <span className={`px-2 py-0.5 text-[10px] font-medium rounded shrink-0 ${RSVP_STYLES[attendee.status] || RSVP_STYLES.none}`}>
                      {attendee.status || 'none'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Response status */}
          {event.myStatus && event.myStatus !== 'none' && event.myStatus !== 'unknown' && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Your Response</h3>
              <span className={`px-2 py-1 text-xs font-medium rounded ${RSVP_STYLES[event.myStatus] || RSVP_STYLES.none}`}>
                {event.myStatus}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
