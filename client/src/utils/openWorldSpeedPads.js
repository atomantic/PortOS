// Pure deterministic helpers for OpenWorld speed boost pads.
// Boost pads are luminous road markings with animated forward chevron arrows.
// Driving onto a boost pad gives an instant surge of acceleration and plays a turbo SFX.
// No three.js / React imports — pure, testable in node.

export const DEFAULT_PAD_BOOST_SPEED = 48; // Peak surge velocity in units/s
export const PAD_TRIGGER_RADIUS = 2.4;

export const SPEED_PADS = [
  // Harbor Grand Avenue (accelerating north toward the water)
  {
    id: 'pad-avenue-north',
    label: 'Harbor Sprint (North)',
    x: 0,
    z: -20,
    angle: -Math.PI / 2, // Facing north (-Z)
    width: 3.8,
    length: 5.5,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#06b6d4',
  },
  // Harbor Grand Avenue (accelerating south back toward downtown)
  {
    id: 'pad-avenue-south',
    label: 'Plaza Approach (South)',
    x: 0,
    z: -42,
    angle: Math.PI / 2, // Facing south (+Z)
    width: 3.8,
    length: 5.5,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#06b6d4',
  },
  // Southern Arrival Lane (heading into downtown)
  {
    id: 'pad-arrival-north',
    label: 'Downtown Gateway',
    x: 0,
    z: 42,
    angle: -Math.PI / 2, // Facing north (-Z)
    width: 3.8,
    length: 5.5,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#38bdf8',
  },
  // Western Avenue to Memory Quarter & Backup Vault
  {
    id: 'pad-west-spoke',
    label: 'Memory Quarter Express',
    x: -24,
    z: -14,
    angle: Math.PI * 0.85,
    width: 3.0,
    length: 4.8,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#a855f7',
  },
  // Eastern Avenue to Goal Monuments & Artifacts Hall
  {
    id: 'pad-east-spoke',
    label: 'Achievements Boulevard',
    x: 24,
    z: -14,
    angle: -Math.PI * 0.85,
    width: 3.0,
    length: 4.8,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#facc15',
  },
  // South-West Spoke to Productivity District
  {
    id: 'pad-sw-spoke',
    label: 'Productivity Turnpike',
    x: -28,
    z: 20,
    angle: Math.PI * 0.35,
    width: 3.0,
    length: 4.8,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#22c55e',
  },
  // South-East Spoke to Wellness District
  {
    id: 'pad-se-spoke',
    label: 'Wellness Expressway',
    x: 28,
    z: 20,
    angle: -Math.PI * 0.35,
    width: 3.0,
    length: 4.8,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#10b981',
  },
];

// Return list of speed boost pads with geometric bounding envelopes
export function getSpeedPadsList() {
  return SPEED_PADS.map((pad) => ({
    ...pad,
    halfWidth: pad.width / 2,
    halfLength: pad.length / 2,
  }));
}

// Check if player position is currently overlapping a speed boost pad using oriented box bounds
export function checkSpeedPadOverlap(playerPos, pads = SPEED_PADS, padding = 0.4) {
  if (!playerPos || typeof playerPos.x !== 'number' || typeof playerPos.z !== 'number') {
    return null;
  }

  for (const pad of pads) {
    const dx = playerPos.x - pad.x;
    const dz = playerPos.z - pad.z;
    const cos = Math.cos(-pad.angle);
    const sin = Math.sin(-pad.angle);
    const localX = cos * dx - sin * dz;
    const localZ = sin * dx + cos * dz;

    const halfL = (pad.length / 2) + padding;
    const halfW = (pad.width / 2) + padding;

    if (Math.abs(localX) <= halfL && Math.abs(localZ) <= halfW) {
      return pad;
    }
  }

  return null;
}
