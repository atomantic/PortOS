// Pure, deterministic helpers for CyberCity's photo mode (roadmap 3.3): cinematic camera
// presets, the "city postcard" stats overlay, and screenshot filename generation. No three.js
// / React imports so it's unit-testable (mirrors the other city helpers). The component reads
// these presets to fly the camera and composites the postcard caption from a live stats
// snapshot the page passes in.

// Cinematic camera presets. Each is a stable framing of the city — position + look-at target —
// the photo UI cycles through. Tuned against the default orbital view (camera at [0,25,45]
// looking at origin) and the ±60-unit landmark ring, so every preset keeps downtown and at
// least one landmark district in frame.
export const PHOTO_PRESETS = [
  { id: 'establishing', label: 'ESTABLISHING', position: [0, 28, 52], target: [0, 2, 0] },
  { id: 'downtown', label: 'DOWNTOWN', position: [0, 10, 26], target: [0, 4, 0] },
  { id: 'skyline', label: 'SKYLINE', position: [44, 6, 44], target: [-6, 8, -6] },
  { id: 'overhead', label: 'OVERHEAD', position: [0, 70, 0.01], target: [0, 0, 0] },
  { id: 'horizon', label: 'HORIZON', position: [0, 4, 60], target: [0, 10, -60] },
  { id: 'low-angle', label: 'LOW ANGLE', position: [-18, 2, 30], target: [0, 12, 0] },
];

export const DEFAULT_PRESET_ID = 'establishing';

// Resolve a preset by id, falling back to the default establishing shot for an unknown id so a
// stale persisted id can never strand the camera with no framing.
export function getPreset(id) {
  return PHOTO_PRESETS.find(p => p.id === id) || PHOTO_PRESETS.find(p => p.id === DEFAULT_PRESET_ID);
}

// Step to the next/previous preset in the ring (wraps). Used by the ‹ › controls and arrow keys.
export function cyclePreset(currentId, direction = 1) {
  const idx = PHOTO_PRESETS.findIndex(p => p.id === currentId);
  const base = idx === -1 ? 0 : idx;
  const next = (base + direction + PHOTO_PRESETS.length) % PHOTO_PRESETS.length;
  return PHOTO_PRESETS[next].id;
}

// Build the short stat lines printed on a "city postcard". Pulls a handful of headline numbers
// from a stats snapshot the page already has (apps, agents, peers, level). Missing fields are
// omitted rather than rendered as "0/undefined", so a sparse install still prints a clean card.
export function buildPostcardStats(snapshot = {}) {
  const lines = [];
  const { online, total, agents, peers, level, streak } = snapshot;
  if (Number.isFinite(total)) lines.push(`${online ?? 0}/${total} SYSTEMS ONLINE`);
  if (Number.isFinite(agents) && agents > 0) lines.push(`${agents} AGENT${agents === 1 ? '' : 'S'} ACTIVE`);
  if (Number.isFinite(peers) && peers > 0) lines.push(`${peers} PEER${peers === 1 ? '' : 'S'} LINKED`);
  if (Number.isFinite(level)) lines.push(`LEVEL ${level}`);
  if (Number.isFinite(streak) && streak > 0) lines.push(`${streak}-DAY STREAK`);
  return lines;
}

// Pad a number to two digits without Date formatting (Date.now is unavailable in some contexts;
// the timestamp is always passed in from the caller).
const pad2 = (n) => String(n).padStart(2, '0');

// Build a stable, filesystem-safe screenshot filename from a Date. Format:
// `cybercity-YYYYMMDD-HHMMSS.png`. The Date is injected so the function is deterministic in
// tests and the caller controls the clock.
export function screenshotFilename(date = new Date()) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `cybercity-${y}${m}${d}-${hh}${mm}${ss}.png`;
}
