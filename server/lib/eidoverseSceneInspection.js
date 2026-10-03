/** Local authored geometry projection, not a renderer or a world-log export. */
import { z } from 'zod';
import { eidoverseModelBounds } from './eidoverseCityLayout.js';

const coordinate = z.number().finite().min(-10000).max(10000);
const vector = z.array(coordinate).length(3);
export const eidoverseInspectSceneInputSchema = z.object({
  anchor: vector,
  radius: z.number().finite().positive().max(100),
  limit: z.number().int().min(1).max(12).default(8),
}).strict();
const boxSchema = z.object({ min: vector, max: vector }).strict();
export const eidoverseInspectSceneOutputSchema = z.object({
  availability: z.enum(['current', 'unavailable', 'incomplete']),
  sequence: z.number().int().min(-1).nullable(),
  observedAt: z.string().nullable(),
  complete: z.boolean(), truncated: z.boolean(), boundsComplete: z.boolean(),
  unknownBounds: z.number().int().nonnegative(), invalidEntities: z.number().int().nonnegative(),
  entities: z.array(z.object({
    id: z.string().max(64), pos: vector, yaw: z.number().finite().min(-Math.PI * 2000).max(Math.PI * 2000),
    scale: z.number().finite().positive().max(100),
    asset: z.string().max(192).nullable(), portosManaged: z.boolean(),
    bounds: boxSchema.nullable(), boundsState: z.enum(['known', 'unknown']),
  }).strict()).max(12),
}).strict();

export const EIDOVERSE_SCENE_RESULT_MAX_CHARS = 3000;
const MAX_SCENE_ENTITIES = 2000;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validVector = (value) => vector.safeParse(value).success;

/** Only library model references and content-addressed store models, never URLs. */
function eidoverseSceneAsset(value) {
  if (typeof value !== 'string') return null;
  const path = value.replaceAll('\\', '/');
  if (path.length > 192 || path.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return /^(?:eidoverse\/assets\/models\/[A-Za-z0-9_./-]+\.glb|store\/[a-f0-9]{16,64}\.glb)$/.test(path) ? path : null;
}

const projectEntity = (entity) => ({
  pos: entity?.pos, yaw: entity?.yaw ?? 0, scale: entity?.scale ?? 1,
  asset: eidoverseSceneAsset(entity?.lib),
  portosManaged: entity?.comp?.portos?.managedBy === 'portos',
  parentId: entity?.parent?.to ?? null,
  light: entity?.kind === 'light',
  // Component evaluators and parents can change rendered geometry. Do not
  // interpret their bags, or claim a static model box covers their effects.
  unsupported: Boolean(entity?.parent) || Object.keys(entity?.comp || {}).some((key) => !['portos', 'label'].includes(key)),
});

/** The snapshot state already includes its tail. Validate the cut, never replay it. */
export function createEidoverseSceneView(snapshot) {
  const view = { availability: 'unavailable', sequence: null, entities: new Map(), dynamic: false };
  if (!record(snapshot?.state?.entities) || !Number.isSafeInteger(snapshot.throughSeq)
    || snapshot.throughSeq < -1 || !Array.isArray(snapshot.entries)) return view;
  let sequence = snapshot.throughSeq;
  for (const entry of snapshot.entries) {
    if (!Number.isSafeInteger(entry?.seq) || entry.seq !== sequence + 1) return view;
    sequence = entry.seq;
  }
  view.sequence = sequence;
  view.availability = 'current';
  view.dynamic = Boolean(snapshot.state.epoch) || Object.keys(snapshot.state.behaviors || {}).length > 0;
  for (const [id, entity] of Object.entries(snapshot.state.entities)) {
    if (view.entities.size === MAX_SCENE_ENTITIES) { view.availability = 'incomplete'; break; }
    view.entities.set(id, projectEntity(entity));
  }
  return view;
}

const nonSpatialVerbs = new Set(['genesis', 'say', 'grant', 'ban', 'unban', 'asset', 'terrain', 'grass', 'sky', 'weather', 'attest', 'use', 'kick']);
/** Fold only the supported authored entity vocabulary; gaps/new dialects fail closed. */
export function updateEidoverseSceneView(view, entry) {
  if (view.availability !== 'current') return;
  if (!Number.isSafeInteger(entry?.seq) || entry.seq !== view.sequence + 1 || typeof entry.verb !== 'string') {
    view.availability = 'incomplete'; return;
  }
  view.sequence = entry.seq;
  const args = entry.args;
  if (nonSpatialVerbs.has(entry.verb)) return;
  if (!record(args)) { view.availability = 'incomplete'; return; }
  const entity = view.entities.get(args.id);
  switch (entry.verb) {
    case 'spawn':
      if (typeof args.id !== 'string' || !args.lib) { view.availability = 'incomplete'; break; }
      if (!entity && view.entities.size >= MAX_SCENE_ENTITIES) { view.availability = 'incomplete'; break; }
      view.entities.set(args.id, projectEntity({ ...args, pos: args.pos ?? [0, 0, 0] }));
      break;
    case 'place':
      if (!entity) break;
      if (args.pos !== undefined) entity.pos = args.pos;
      if (args.yaw !== undefined) entity.yaw = args.yaw;
      if (args.scale !== undefined) entity.scale = args.scale;
      break;
    case 'remove':
      view.entities.delete(args.id);
      // Attached children require renderer transforms; the view cannot
      // reconstruct their dismount pose. Keep the enumeration incomplete.
      for (const row of view.entities.values()) if (row.parentId === args.id) { row.pos = null; row.parentId = null; }
      break;
    case 'light':
      if (!entity && view.entities.size >= MAX_SCENE_ENTITIES) { view.availability = 'incomplete'; break; }
      view.entities.set(args.id, { ...(entity?.light ? entity : projectEntity({ kind: 'light', pos: [0, 1, 0] })),
        ...(args.pos !== undefined ? { pos: args.pos } : {}), unsupported: true });
      break;
    case 'comp':
      if (!entity) break;
      if (args.type === 'portos') entity.portosManaged = args.data?.managedBy === 'portos';
      else if (args.type !== 'label') entity.unsupported = true;
      break;
    case 'motion': case 'mount': case 'dismount':
      if (entity) {
        entity.unsupported = true;
        if (entry.verb === 'mount') entity.parentId = args.to;
        if (entry.verb === 'dismount') {
          entity.parentId = null;
          entity.pos = validVector(args.pos) ? args.pos : null;
          if (args.yaw !== undefined) entity.yaw = args.yaw;
        }
      }
      break;
    case 'epoch': case 'behavior': case 'bstate': case 'force': case 'punt':
      view.dynamic = true;
      break;
    default:
      view.availability = 'incomplete';
  }
}

/** Rotate all eight model-box corners into the world frame, then enclose them. */
function occupiedBounds(entity, value) {
  if (entity.unsupported) return null;
  const box = eidoverseModelBounds(value);
  if (!box || !validVector(box.min) || !validVector(box.max)) return null;
  const corners = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    corners.push([entity.pos[0] + entity.scale * (Math.cos(entity.yaw) * x + Math.sin(entity.yaw) * z),
      entity.pos[1] + entity.scale * y,
      entity.pos[2] + entity.scale * (-Math.sin(entity.yaw) * x + Math.cos(entity.yaw) * z)]);
  }
  const result = { min: [0, 1, 2].map((axis) => Math.min(...corners.map((v) => v[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...corners.map((v) => v[axis]))) };
  return validVector(result.min) && validVector(result.max) ? result : null;
}

export function buildEidoverseSceneInspection(view, input, { boundsByAsset = new Map(), observedAt = null } = {}) {
  const { anchor, radius, limit } = eidoverseInspectSceneInputSchema.parse(input);
  const result = { availability: view?.availability ?? 'unavailable', sequence: view?.sequence ?? null, observedAt,
    complete: false, truncated: false, boundsComplete: false, unknownBounds: 0, invalidEntities: 0, entities: [] };
  if (result.availability === 'unavailable') return result;
  for (const [id, entity] of view.entities) {
    if (!idPattern.test(id) || entity.parentId || !validVector(entity.pos) || !Number.isFinite(entity.yaw) || Math.abs(entity.yaw) > Math.PI * 2000
      || !Number.isFinite(entity.scale) || entity.scale <= 0 || entity.scale > 100) {
      result.invalidEntities++; continue;
    }
    const bounds = view.dynamic ? null : occupiedBounds(entity, boundsByAsset.get(entity.asset));
    if (!bounds) result.unknownBounds++;
    // Known large objects can overlap the query even when their origin does
    // not. Unknown extents anywhere in the world preclude a clearance claim.
    const distanceSquared = anchor.reduce((sum, n, axis) => {
      const nearest = bounds ? Math.max(bounds.min[axis], Math.min(bounds.max[axis], n)) : entity.pos[axis];
      return sum + (n - nearest) ** 2;
    }, 0);
    if (distanceSquared > radius ** 2) continue;
    const row = { id, pos: [...entity.pos], yaw: entity.yaw, scale: entity.scale, asset: entity.asset,
      portosManaged: entity.portosManaged, bounds, boundsState: bounds ? 'known' : 'unknown' };
    if (result.entities.length >= limit || JSON.stringify({ ...result, entities: [...result.entities, row] }).length > EIDOVERSE_SCENE_RESULT_MAX_CHARS - 100) {
      result.truncated = true; continue;
    }
    result.entities.push(row);
  }
  result.complete = result.availability === 'current' && !result.truncated && !result.invalidEntities;
  result.boundsComplete = result.complete && !result.unknownBounds;
  return result;
}
