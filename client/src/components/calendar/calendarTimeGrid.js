import { getEventDayMinutes } from './calendarUtils';

export const START_HOUR = 0;
export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
export const PX_PER_HOUR = 80;
export const PX_PER_15MIN = PX_PER_HOUR / 4;

export function getEventPosition(event, day) {
  const { startMin, endMin } = getEventDayMinutes(event, day);
  const top = (startMin / 60) * PX_PER_HOUR;
  const height = Math.min(
    Math.max(((endMin - startMin) / 60) * PX_PER_HOUR, PX_PER_15MIN),
    HOURS.length * PX_PER_HOUR - top,
  );
  return { top, height };
}

export function eventKey(event) {
  return `${event.accountId}-${event.id}`;
}

/** Assign side-by-side columns to timed events that overlap on this day. */
export function layoutEvents(events, day) {
  const items = events.map(event => {
    const { startMin, endMin } = getEventDayMinutes(event, day);
    return { event, startMin, endMin: Math.max(endMin, startMin + 15) };
  }).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const groups = [];
  let currentGroup = [];
  let groupEnd = -1;

  for (const item of items) {
    if (currentGroup.length === 0 || item.startMin < groupEnd) {
      currentGroup.push(item);
      groupEnd = Math.max(groupEnd, item.endMin);
    } else {
      groups.push(currentGroup);
      currentGroup = [item];
      groupEnd = item.endMin;
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  const layout = new Map();
  for (const group of groups) {
    const columns = [];
    for (const item of group) {
      let placed = false;
      for (let col = 0; col < columns.length; col++) {
        if (columns[col] <= item.startMin) {
          columns[col] = item.endMin;
          layout.set(eventKey(item.event), { column: col, totalColumns: 0 });
          placed = true;
          break;
        }
      }
      if (!placed) {
        layout.set(eventKey(item.event), { column: columns.length, totalColumns: 0 });
        columns.push(item.endMin);
      }
    }
    const total = columns.length;
    for (const item of group) {
      const position = layout.get(eventKey(item.event));
      if (position) position.totalColumns = total;
    }
  }
  return layout;
}
