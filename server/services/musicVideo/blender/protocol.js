/**
 * The Blender film driver's stdout protocol: one JSON object per line behind a
 * fixed prefix. Everything else Blender or a film prints is free-form log text.
 * Lines come from operator-authored code running in Blender, so each is parsed
 * defensively and reduced to the fields the server acts on.
 */
export const BLENDER_DRIVER_PREFIX = 'PORTOS_BLENDER ';

const EVENTS = new Set(['start', 'built', 'frame', 'blend', 'done', 'manifest', 'error']);
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const duration = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

/** The driver event on `line`, or null when the line is ordinary log text. */
export function parseBlenderDriverLine(line) {
  if (typeof line !== 'string' || !line.startsWith(BLENDER_DRIVER_PREFIX)) return null;
  let raw;
  try { raw = JSON.parse(line.slice(BLENDER_DRIVER_PREFIX.length)); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !EVENTS.has(raw.event)) return null;
  const shot = text(raw.shot, 40);
  switch (raw.event) {
    case 'start':
      return { event: 'start', shot, frames: count(raw.frames), blender: text(raw.blender, 32), engine: text(raw.engine, 40), device: text(raw.device, 40) };
    case 'frame': {
      const frame = count(raw.frame);
      const index = count(raw.index);
      const total = count(raw.total);
      if (frame === null || index === null || total === null) return null;
      return { event: 'frame', shot, frame, index, total, sec: duration(raw.sec) ?? 0, skipped: raw.skipped === true };
    }
    case 'built':
    case 'done':
      return { event: raw.event, shot, sec: duration(raw.sec) };
    case 'blend':
    case 'manifest':
      return { event: raw.event, shot, path: text(raw.path, 4096) };
    default:
      return { event: 'error', message: text(raw.message, 2000) || 'The film raised an error', traceback: text(raw.traceback, 20000) };
  }
}
