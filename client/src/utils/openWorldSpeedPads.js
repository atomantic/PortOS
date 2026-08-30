// Pure deterministic helpers for OpenWorld boost markings.
// They are painted lane flourishes in the village rather than sci-fi metal plates.
// Driving onto a boost pad gives an instant surge of acceleration and plays a turbo SFX.
// No three.js / React imports — pure, testable in node.

export const DEFAULT_PAD_BOOST_SPEED = 48; // Peak surge velocity in units/s
export const PAD_TRIGGER_RADIUS = 2.4;

export const SPEED_PADS = [
  {
    id: 'pad-harbor-lane',
    label: 'Harbor Lane',
    x: 0,
    z: -41,
    angle: -Math.PI / 2,
    width: 3.7,
    length: 5.2,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#7cc9be',
  },
  {
    id: 'pad-arrival-lane',
    label: 'Village Welcome',
    x: 0,
    z: 34,
    angle: -Math.PI / 2,
    width: 3.7,
    length: 5.2,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#f3b856',
  },
  {
    id: 'pad-west-loop',
    label: 'Orchard Bend',
    x: -28,
    z: 8,
    angle: -Math.PI / 2,
    width: 3.6,
    length: 4.8,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#ec8265',
  },
  {
    id: 'pad-east-loop',
    label: 'Pond Bend',
    x: 28,
    z: 6,
    angle: Math.PI / 2,
    width: 3.6,
    length: 4.8,
    boostSpeed: DEFAULT_PAD_BOOST_SPEED,
    color: '#8ccf9e',
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
