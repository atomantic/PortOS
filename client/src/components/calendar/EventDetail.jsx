import { MapPin, Clock, Users, Repeat, CalendarDays } from 'lucide-react';
import { formatEventDateTime } from '../../utils/formatters';
import Drawer from '../Drawer';

const RSVP_STYLES = {
  accepted: 'bg-port-success/20 text-port-success',
  declined: 'bg-port-error/20 text-port-error',
  tentative: 'bg-port-warning/20 text-port-warning',
  none: 'bg-gray-700 text-gray-400'
};

export default function EventDetail({ event, onClose }) {
  return (
    <Drawer open onClose={onClose} title={event.title} closeLabel="Close">
      <div className="space-y-4">
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
                <div>{formatEventDateTime(event.startTime)}</div>
                <div className="text-gray-500">to</div>
                <div>{formatEventDateTime(event.endTime)}</div>
              </>
            )}
            {event.isAllDay && (
              <div className="mt-1 text-gray-500">{formatEventDateTime(event.startTime, { allDay: true })}</div>
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
    </Drawer>
  );
}
