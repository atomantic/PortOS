// Guarded localStorage access. `localStorage` can throw (Safari private mode,
// blocked storage, disabled cookies) or be entirely absent (SSR, sandboxed
// iframes). These helpers make persistence best-effort so a storage failure
// never crashes a `useState` initializer or a write path — in-memory state stays
// the source of truth. Use these instead of touching `localStorage` inline.

// Returns the stored string, or null on any failure / missing storage. Callers
// distinguish absent (null) from a legitimately-empty value and fall through to
// their own default.
export const safeReadStorage = (key) => {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

// Parse a JSON value from storage, returning the caller's fallback for a missing,
// inaccessible, or corrupt entry. Keeps JSON.parse's exception boundary beside
// the storage boundary so feature code never needs its own try/catch.
export const safeReadJsonStorage = (key, fallback = null) => {
  const raw = safeReadStorage(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

// Best-effort write; silently no-ops when storage is unavailable.
export const safeWriteStorage = (key, value) => {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Ignore — the value stays in memory when persistence is unavailable.
  }
};

// Best-effort JSON write. Serialization happens inside the guard because
// JSON.stringify itself throws on circular/BigInt values — a caller that only
// wrapped setItem would still crash on those.
export const safeWriteJsonStorage = (key, value) => {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore — the value stays in memory when persistence is unavailable.
  }
};

// Best-effort remove; silently no-ops when storage is unavailable.
export const safeRemoveStorage = (key) => {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Ignore — nothing persisted to remove when storage is unavailable.
  }
};
