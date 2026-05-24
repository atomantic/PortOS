// Time-window helpers for dashboard layout auto-activation.
// Predicate logic (`isInTimeWindow`) mirrors the server's `isWithinTimeWindow`
// in `server/lib/timezone.js`; the regex below mirrors that file's strict,
// zero-padded `HHMM_STRICT_RE`. Keep the two literals in sync (parity-tested
// in timeWindow.test.js and timezone.test.js).

export const TIME_STRING_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeString(s) {
  return typeof s === 'string' && TIME_STRING_RE.test(s);
}

export function timeStringToMinutes(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

// Half-open [start, end). Handles overnight wrap when start > end.
export function isInTimeWindow(window, now = new Date()) {
  if (!window || typeof window !== 'object') return false;
  if (!isValidTimeString(window.start) || !isValidTimeString(window.end)) return false;
  if (window.start === window.end) return false;
  const startMin = timeStringToMinutes(window.start);
  const endMin = timeStringToMinutes(window.end);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

// First layout whose window covers `now`. Order matters when windows overlap.
function findActiveWindowLayout(layouts, now = new Date()) {
  if (!Array.isArray(layouts)) return null;
  return layouts.find((l) => isInTimeWindow(l?.activateWindow, now)) || null;
}

export const MORNING_DEFAULT_WINDOW = Object.freeze({ start: '06:00', end: '11:00' });

// localStorage key per-day so each new day clears the user's daily lock and
// a window-layout can auto-activate again.
const USER_PICK_KEY_PREFIX = 'dashboard:userPick:';
const localDateKey = (now = new Date()) => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};
const userPickKey = (now = new Date()) => `${USER_PICK_KEY_PREFIX}${localDateKey(now)}`;

// Drop stale `dashboard:userPick:*` keys older than today so the key count
// stays O(1) over time. Best-effort; failures are silent.
const pruneStaleUserPickKeys = (todayKey) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const remove = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(USER_PICK_KEY_PREFIX) && k !== todayKey) remove.push(k);
    }
    for (const k of remove) window.localStorage.removeItem(k);
  } catch { /* private mode / disabled — nothing to prune */ }
};

export function recordManualLayoutPick(layoutId, now = new Date()) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  // Prune BEFORE set so a quota-exceeded setItem still frees space first —
  // otherwise the catch swallows the throw and stale prior-day keys grow.
  const todayKey = userPickKey(now);
  pruneStaleUserPickKeys(todayKey);
  try { window.localStorage.setItem(todayKey, String(layoutId)); }
  catch { /* quota / disabled — auto-switch will fire next visit */ }
}

function readManualLayoutPick(now = new Date()) {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try { return window.localStorage.getItem(userPickKey(now)) ?? null; }
  catch { return null; }
}

// Decide which layout id should be active on a fresh dashboard load.
//   - alreadyAutoSwitched → keep the server's choice (subsequent refetches
//     must not stomp a manual pick the user just made).
//   - user has a recorded pick for today → honor it.
//   - a window layout currently covers `now` → auto-pick it.
//   - otherwise → server's active layout.
export function pickActiveLayoutId(serverActiveId, layouts, alreadyAutoSwitched, now = new Date()) {
  if (alreadyAutoSwitched) return serverActiveId;
  const userPickId = readManualLayoutPick(now);
  if (userPickId && layouts?.some((l) => l.id === userPickId)) return userPickId;
  const windowLayout = findActiveWindowLayout(layouts, now);
  if (windowLayout) return windowLayout.id;
  return serverActiveId;
}
