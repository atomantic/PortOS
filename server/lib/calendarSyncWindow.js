/**
 * True when a cached event could have been returned by a sync that covered
 * `dateRange` ({ pastDate, futureDate } Dates), i.e. its absence from the batch
 * means an upstream deletion. No range means the batch is the complete calendar.
 * Bounds are exclusive like Google's timeMin/timeMax; unparseable/missing times
 * can't be proven outside the window.
 */
export function overlapsSyncWindow(event, dateRange) {
  if (!dateRange) return true;
  const start = Date.parse(event.startTime || event.endTime);
  const end = Date.parse(event.endTime || event.startTime);
  return (Number.isNaN(start) || start < dateRange.futureDate.getTime())
    && (Number.isNaN(end) || end > dateRange.pastDate.getTime());
}
