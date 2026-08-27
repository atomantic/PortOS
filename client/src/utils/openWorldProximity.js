// Pure deterministic proximity detection for OpenWorld exploration mode.
// Unifies detection across buildings, warp pads, landmarks, and easter eggs.
// No three.js / React imports — pure, testable in node.

import { PARCELS } from './openWorldPlan';
import { isOpenWorldEntryVisible } from './openWorldRegions';

export const PROXIMITY_DISTANCES = {
  warpPad: 3.6,
  building: 6.0,
  landmark: 8.5,
  easterEgg: 4.5,
  shard: 3.0,
};

// Curated list of recognizable world landmarks derived from the master town plan
export const WORLD_LANDMARKS = [
  { id: 'ai-core', regionId: 'ai-core', parcel: 'aiCore', label: 'AI Core Plaza', eyebrow: 'LANDMARK REACTOR', action: 'INSPECT AI RUNS' },
  { id: 'backup-vault', regionId: 'backup-vault', parcel: 'backupVault', label: 'Backup Vault', eyebrow: 'LANDMARK VAULT', action: 'INSPECT BACKUPS' },
  { id: 'task-queue', regionId: 'task-queue', parcel: 'taskQueue', label: 'Task Queue Depot', eyebrow: 'LANDMARK DEPOT', action: 'VIEW TASKS' },
  { id: 'wellness', regionId: 'wellness', parcel: 'health', label: 'Wellness Tower', eyebrow: 'LANDMARK TOWER', action: 'VIEW VITALS' },
  { id: 'memory', regionId: 'memory', parcel: 'memory', label: 'Memory Quarter', eyebrow: 'LANDMARK DISTRICT', action: 'VIEW MEMORY GRAPH' },
  { id: 'sprint-yard', regionId: 'sprint-yard', parcel: 'jira', feature: 'jira', label: 'Sprint Yard', eyebrow: 'LANDMARK SPRINT', action: 'VIEW SPRINT TICKETS' },
  { id: 'goals', regionId: 'goals', parcel: 'goals', label: 'Goal Monuments', eyebrow: 'LANDMARK MONUMENT', action: 'VIEW LIFE GOALS' },
  { id: 'artifacts', regionId: 'artifacts', parcel: 'artifacts', label: 'Hall of Achievements', eyebrow: 'LANDMARK HALL', action: 'VIEW ACHIEVEMENTS' },
  { id: 'voice', regionId: 'voice', parcel: 'voice', label: 'Voice Beacon', eyebrow: 'LANDMARK BEACON', action: 'VIEW VOICE AGENT' },
  { id: 'data-harbor', regionId: 'data-harbor', parcel: 'dataHarbor', label: 'Data Harbor Piers', eyebrow: 'LANDMARK HARBOR', action: 'VIEW DATA HARBOR' },
];

export function getResolvedLandmarks(isFeatureEnabled) {
  return WORLD_LANDMARKS
    .filter((landmark) => isOpenWorldEntryVisible(landmark, isFeatureEnabled))
    .map((lm) => {
      const parcel = PARCELS[lm.parcel];
      if (!parcel) return null;
      return {
        ...lm,
        x: parcel.anchor[0],
        y: 0,
        z: parcel.anchor[2],
      };
    })
    .filter(Boolean);
}

// Compute the closest interactable target to the player
export function detectProximity({
  playerPos,
  apps = [],
  positions = null,
  warpPads = [],
  easterEggs = [],
  landmarks = getResolvedLandmarks(),
} = {}) {
  if (!playerPos || typeof playerPos.x !== 'number' || typeof playerPos.z !== 'number') {
    return null;
  }

  // Validate collection-shaped inputs before iterating: this runs inside the r3f frame
  // loop, where a thrown TypeError kills rendering for the whole scene (the canvas would
  // show only its clear color). A wrong-shaped payload degrades to "no targets" instead.
  const pads = Array.isArray(warpPads) ? warpPads : [];
  const eggs = Array.isArray(easterEggs) ? easterEggs : [];

  const px = playerPos.x;
  const pz = playerPos.z;

  let closestTarget = null;
  let closestDist = Infinity;

  // 1. Warp pads (highest priority for fast travel nodes)
  for (const pad of pads) {
    if (!pad) continue;
    const pos = pad.position || (pad.region ? [pad.region.anchor[0], 0, pad.region.anchor[2]] : null);
    if (!pos) continue;
    const dx = px - pos[0];
    const dz = pz - pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist < PROXIMITY_DISTANCES.warpPad && dist < closestDist) {
      closestDist = dist;
      const region = pad.region || pad;
      closestTarget = {
        type: 'warpPad',
        id: region.id,
        label: region.label || 'WARP GATE',
        eyebrow: 'WARP GATE',
        action: 'WARP TO',
        raw: region,
      };
    }
  }

  // 2. Apps / Buildings
  if (positions && typeof positions.forEach === 'function') {
    positions.forEach((pos, appId) => {
      const dx = px - pos.x;
      const dz = pz - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < PROXIMITY_DISTANCES.building && dist < closestDist) {
        closestDist = dist;
        const app = apps.find((a) => a.id === appId);
        const name = app?.name || appId;
        closestTarget = {
          type: 'building',
          id: appId,
          label: name,
          eyebrow: 'NEARBY BUILDING',
          action: 'OPEN APP STATUS',
          raw: app || { id: appId, name },
        };
      }
    });
  }

  // 3. Easter eggs
  for (const egg of eggs) {
    if (!egg || !egg.position) continue;
    const dx = px - egg.position[0];
    const dz = pz - egg.position[2];
    const dist = Math.hypot(dx, dz);
    if (dist < PROXIMITY_DISTANCES.easterEgg && dist < closestDist) {
      closestDist = dist;
      closestTarget = {
        type: 'easterEgg',
        id: egg.id,
        label: `${egg.label || '?!'} — ${egg.hint || 'SECRET'}`,
        eyebrow: 'EASTER EGG FOUND',
        action: 'DISCOVER',
        raw: egg,
      };
    }
  }

  // 4. District landmarks (only if no closer specific target was matched)
  if (!closestTarget) {
    for (const lm of landmarks) {
      if (!lm) continue;
      const dx = px - lm.x;
      const dz = pz - lm.z;
      const dist = Math.hypot(dx, dz);
      if (dist < PROXIMITY_DISTANCES.landmark && dist < closestDist) {
        closestDist = dist;
        closestTarget = {
          type: 'landmark',
          id: lm.id,
          regionId: lm.regionId,
          label: lm.label,
          eyebrow: lm.eyebrow,
          action: lm.action,
          raw: lm,
        };
      }
    }
  }

  return closestTarget;
}
