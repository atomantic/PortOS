// Shared bits between Image Gen and Video Gen pages.

export const MAX_SEED = 0xFFFFFFFF;

export const randomSeed = () => String(Math.floor(Math.random() * MAX_SEED));

// SSE handlers receive bare strings from EventSource; partial frames or
// keep-alive pings would crash the page if we threw on parse.
export const safeParseJSON = (s) => {
  if (typeof s !== 'string' || !s.startsWith('{')) return null;
  try { return JSON.parse(s); } catch { return null; }
};
