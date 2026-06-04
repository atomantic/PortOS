// Pure date/grid computation helpers for the Life Calendar.
// No React, no DOM — safe to unit-test in isolation.

export const MS_PER_DAY = 86400000;

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export const CADENCE_LABELS = { day: '/day', week: '/week', month: '/month', year: '/year' };

// === View Mode Config ===

export const UNIT_MODES = [
  { id: 'years', label: 'Years' },
  { id: 'months', label: 'Months' },
  { id: 'weeks', label: 'Weeks' },
  { id: 'days', label: 'Days' },
];

export const WEEK_LAYOUTS = [
  { id: 'year', label: '1Y', weeksPerRow: 52 },
  { id: 'half', label: '6M', weeksPerRow: 26 },
  { id: 'quarter', label: '3M', weeksPerRow: 13 },
  { id: 'auto', label: 'Auto', weeksPerRow: null },
];

// Fixed cell sizes per unit mode — no user toggle needed
export const UNIT_CELL_SIZES = {
  years: { size: 18, gap: 2 },
  months: { size: 9, gap: 1 },
  weeks: { size: 7, gap: 1 },
  days: { size: 16, gap: 2 },
};

export const EVENT_TYPES = [
  { id: 'holiday', label: 'Holiday' },
  { id: 'vacation', label: 'Vacation' },
  { id: 'milestone', label: 'Milestone' },
  { id: 'health', label: 'Health' },
  { id: 'custom', label: 'Custom' },
];

export const EVENT_TYPE_STYLES = {
  birthday: { bg: 'bg-pink-500', ring: 'ring-1 ring-pink-500/50' },
  holiday: { bg: 'bg-amber-500', ring: 'ring-1 ring-amber-500/50' },
  vacation: { bg: 'bg-cyan-500', ring: 'ring-1 ring-cyan-500/50' },
  milestone: { bg: 'bg-purple-500', ring: 'ring-1 ring-purple-500/50' },
  health: { bg: 'bg-red-500', ring: 'ring-1 ring-red-500/50' },
  custom: { bg: 'bg-emerald-500', ring: 'ring-1 ring-emerald-500/50' },
};

/**
 * Compute which weeks in the remaining grid correspond to events.
 * Uses server-provided events plus birthdays.
 * Returns a Map<string, { type, name }> where key is "age-week".
 */
export function computeEventWeeks(birthDate, grid, stats, lifeEvents) {
  const events = new Map();
  if (!birthDate) return events;

  const birth = new Date(birthDate);
  // Helper: compute week offset within an age-year (server uses birth time as yearStart)
  const weekInAgeYear = (eventDate, yearStart) => {
    const ms = eventDate.getTime() - yearStart.getTime();
    return Math.floor(ms / (7 * MS_PER_DAY));
  };

  // Mark birthday weeks for all years (birthday is always week 0 by definition)
  for (const row of grid) {
    events.set(`${row.age}-0`, { type: 'birthday', name: 'Birthday' });
  }

  // Add life events from server
  if (lifeEvents?.length) {
    for (const event of lifeEvents) {
      if (!event.enabled) continue;

      if (event.recurrence === 'yearly' && event.month != null && event.day != null) {
        for (const row of grid) {
          const yearStart = new Date(birth);
          yearStart.setFullYear(birth.getFullYear() + row.age);
          // Event may fall in this calendar year or next (if before birthday)
          let eventDate = new Date(yearStart.getFullYear(), event.month, event.day);
          if (eventDate < yearStart) {
            eventDate = new Date(yearStart.getFullYear() + 1, event.month, event.day);
          }
          const weekOfYear = weekInAgeYear(eventDate, yearStart);
          if (weekOfYear >= 0 && weekOfYear < 52) {
            const key = `${row.age}-${weekOfYear}`;
            if (!events.has(key)) {
              events.set(key, { type: event.type, name: event.name });
            }
          }
        }
      } else if (event.recurrence === 'once' && event.date) {
        const eventDate = new Date(event.date);
        const ageMs = eventDate - birth;
        const age = Math.floor(ageMs / (365.25 * MS_PER_DAY));
        const yearStart = new Date(birth);
        yearStart.setFullYear(birth.getFullYear() + age);
        const weekOfYear = weekInAgeYear(eventDate, yearStart);
        if (weekOfYear >= 0 && weekOfYear < 52) {
          const key = `${age}-${weekOfYear}`;
          if (!events.has(key)) {
            events.set(key, { type: event.type, name: event.name });
          }
        }
      }
    }
  }

  return events;
}

export function computeYearGrid(birthDate, deathDate) {
  const birth = new Date(birthDate);
  const death = new Date(deathDate);
  const now = new Date();
  const totalYears = Math.ceil((death - birth) / (365.25 * MS_PER_DAY));
  const cells = [];
  for (let y = 0; y < totalYears; y++) {
    const yearStart = new Date(birth);
    yearStart.setFullYear(birth.getFullYear() + y);
    const yearEnd = new Date(yearStart);
    yearEnd.setFullYear(yearEnd.getFullYear() + 1);
    let status;
    if (yearEnd <= now) status = 's';
    else if (yearStart <= now && now < yearEnd) status = 'c';
    else if (yearStart > death) break;
    else status = 'r';
    // Every year contains a birthday
    cells.push({ index: y, label: `Age ${y}`, status, isBirthday: true });
  }
  return cells;
}

export function computeMonthGrid(birthDate, deathDate) {
  const birth = new Date(birthDate);
  const death = new Date(deathDate);
  const now = new Date();
  const birthMonth = birth.getMonth();
  const cells = [];
  const cursor = new Date(birth);
  let i = 0;
  while (cursor < death) {
    const monthStart = new Date(cursor);
    const monthEnd = new Date(cursor);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    let status;
    if (monthEnd <= now) status = 's';
    else if (monthStart <= now && now < monthEnd) status = 'c';
    else status = 'r';
    const age = Math.floor(i / 12);
    const mo = i % 12;
    const calMonth = cursor.getMonth();
    const isBirthday = calMonth === birthMonth;
    cells.push({ index: i, age, month: mo, calMonth, label: `Age ${age}, Month ${mo + 1}`, status, isBirthday });
    cursor.setMonth(cursor.getMonth() + 1);
    i++;
  }
  return cells;
}

export function computeMonthCalendars(birthDate, deathDate, selectedAge) {
  const birth = new Date(birthDate);
  const birthMonth = birth.getMonth();
  const birthDay = birth.getDate();
  const death = new Date(deathDate);
  const now = new Date();

  // 1-year span: from birthday at selectedAge to day before birthday at selectedAge+1
  const rangeStart = new Date(birth);
  rangeStart.setFullYear(birth.getFullYear() + selectedAge);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setFullYear(rangeEnd.getFullYear() + 1);

  const months = [];
  const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);

  while (cursor < rangeEnd && cursor < death) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDow = new Date(year, month, 1).getDay();

    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const dateEnd = new Date(date.getTime() + MS_PER_DAY);
      let status;
      if (date >= death) break;
      if (dateEnd <= now) status = 's';
      else if (date <= now && now < dateEnd) status = 'c';
      else status = 'r';
      const isBirthday = month === birthMonth && d === birthDay;
      days.push({ day: d, status, isBirthday, dow: date.getDay(), label: date.toLocaleDateString() });
    }

    months.push({ year, month, name: `${MONTH_NAMES[month]} ${year}`, firstDow, days });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return months;
}

export function cellClasses(status, isCurrent, isBirthday, showEvents) {
  if (isBirthday && showEvents && status === 'r') return 'bg-pink-500 ring-1 ring-pink-500/50';
  if (status === 'c') return 'bg-port-accent shadow-[0_0_4px_rgba(59,130,246,0.5)]';
  if (status === 's') {
    const base = isCurrent ? 'bg-gray-500' : 'bg-gray-700';
    return isBirthday && showEvents ? `${base} ring-1 ring-pink-500/50` : base;
  }
  return isBirthday && showEvents ? 'bg-pink-500 ring-1 ring-pink-500/50' : 'bg-port-success/20';
}
