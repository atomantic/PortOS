/**
 * The Blender model driver's stdout protocol (py/portos_model_driver.py): one
 * JSON object per line behind a fixed prefix; everything else is free-form log
 * text. Facts stream as small events (one per declared part and per mesh) so no
 * line approaches the worker's 64 KiB line cap. Lines come from
 * operator-authored code running in Blender, so each is parsed defensively and
 * reduced to the fields the report reads; a malformed value becomes null and
 * the report names it.
 */
export const BLENDER_MODEL_DRIVER_PREFIX = 'PORTOS_MODEL ';

const EVENTS = new Set([
  'start', 'part', 'described', 'mesh', 'scene', 'saved', 'reimport', 'view', 'done', 'error',
  'control', 'control-skipped', 'action', 'sweep-scope', 'sweep-rest', 'sweep-overlap', 'sweep', 'reimport-control',
]);
const LIST_MAX_BYTES = 16 * 1024;
const SCOPES = new Set(['control', 'pair', 'action']);
const NAMES_LISTED = 64;

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const vector = (value) => (Array.isArray(value) && value.length === 3 && value.every((n) => finite(n) !== null) ? value.slice() : null);
const seconds = (value) => (finite(value) !== null && value >= 0 ? value : null);

function size(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const axes = ['x', 'y', 'z'].map((axis) => finite(value[axis]));
  return axes.every((n) => n !== null && n > 0) ? { x: axes[0], y: axes[1], z: axes[2] } : null;
}

// A list describe() returned: null when absent, `undefined` when it is not a list this reads. Entries are checked by motion.js.
function rawList(value) {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) && JSON.stringify(value).length <= LIST_MAX_BYTES ? value : undefined;
}

const names = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, NAMES_LISTED).map((item) => item.slice(0, 200)) : []);

function pose(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, n]) => finite(n) !== null).slice(0, NAMES_LISTED));
}

const probe = (raw) => ({ command: finite(raw?.command), expected: finite(raw?.expected), measured: finite(raw?.measured), drift: finite(raw?.drift) });

const bounds = (raw) => ({ min: vector(raw.min), max: vector(raw.max) });

/** The driver event on `line`, or null when the line is ordinary log text. */
export function parseBlenderModelDriverLine(line) {
  if (typeof line !== 'string' || !line.startsWith(BLENDER_MODEL_DRIVER_PREFIX)) return null;
  let raw;
  try { raw = JSON.parse(line.slice(BLENDER_MODEL_DRIVER_PREFIX.length)); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !EVENTS.has(raw.event)) return null;
  switch (raw.event) {
    case 'start':
      return { event: 'start', blender: text(raw.blender, 32), quality: text(raw.quality, 16) };
    case 'part':
      return { event: 'part', id: text(raw.id, 200), label: text(raw.label, 200), parent: raw.parent == null ? null : text(raw.parent, 200) ?? '' };
    case 'described':
      return {
        event: 'described', title: text(raw.title, 200), sizeMeters: size(raw.sizeMeters),
        triangleBudget: count(raw.triangleBudget), partsTruncated: raw.partsTruncated === true,
        controls: rawList(raw.controls), actions: rawList(raw.actions), allowContact: rawList(raw.allowContact),
      };
    case 'mesh':
      return {
        event: 'mesh', name: text(raw.name, 200), parent: raw.parent == null ? null : text(raw.parent, 200),
        triangles: count(raw.triangles), ...bounds(raw), scale: vector(raw.scale), negative: raw.negative === true, materials: count(raw.materials),
      };
    case 'scene':
      return {
        event: 'scene', objects: count(raw.objects), meshes: count(raw.meshes), triangles: count(raw.triangles),
        materials: count(raw.materials), images: count(raw.images), actions: count(raw.actions), ...bounds(raw), truncated: raw.truncated === true,
      };
    case 'saved':
      return { event: 'saved', blend: text(raw.blend, 4096), glb: text(raw.glb, 4096), glbBytes: count(raw.glbBytes) };
    case 'reimport':
      return {
        event: 'reimport', objects: count(raw.objects), meshes: count(raw.meshes), triangles: count(raw.triangles),
        materials: count(raw.materials), images: count(raw.images), actions: count(raw.actions), ...bounds(raw),
      };
    case 'control':
      return { event: 'control', id: text(raw.id, 200), parts: names(raw.parts), probes: (Array.isArray(raw.probes) ? raw.probes : []).slice(0, 16).map(probe) };
    case 'control-skipped':
      return { event: 'control-skipped', id: text(raw.id, 200), reason: text(raw.reason, 500) };
    case 'action':
      return { event: 'action', id: text(raw.id, 200), frames: count(raw.frames), error: text(raw.error, 500), unmetAt: finite(raw.unmetAt), unmet: names(raw.unmet) };
    case 'sweep-scope':
      return { event: 'sweep-scope', kind: SCOPES.has(raw.kind) ? raw.kind : null, ids: names(raw.ids), planned: count(raw.planned), measured: count(raw.measured), blocked: count(raw.blocked) };
    case 'sweep-rest':
      return { event: 'sweep-rest', a: text(raw.a, 200), b: text(raw.b, 200) };
    case 'sweep-overlap':
      return { event: 'sweep-overlap', a: text(raw.a, 200), b: text(raw.b, 200), kind: SCOPES.has(raw.kind) ? raw.kind : null, ids: names(raw.ids), count: count(raw.count), t: finite(raw.t), values: pose(raw.values) };
    case 'sweep':
      return {
        event: 'sweep', poses: count(raw.poses), parts: count(raw.parts), empty: names(raw.empty), restPairs: count(raw.restPairs),
        overlaps: count(raw.overlaps), budgetSec: seconds(raw.budgetSec), sec: seconds(raw.sec),
      };
    case 'reimport-control':
      return { event: 'reimport-control', id: text(raw.id, 200), found: raw.found === true, error: seconds(raw.error) };
    case 'view':
      return { event: 'view', id: text(raw.id, 64), look: text(raw.look, 16) };
    case 'done':
      return { event: 'done', sec: seconds(raw.sec) };
    default:
      return { event: 'error', message: text(raw.message, 2000) || 'The model raised an error', traceback: text(raw.traceback, 20000) };
  }
}
