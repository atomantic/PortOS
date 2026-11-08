/**
 * Greybox constants both sides of the wire agree on, kept DEPENDENCY-FREE so
 * the client imports them directly (`greyboxScene.js` pulls in zod, which the
 * client CI job does not install).
 */

/** Maximum authored instruction length, shared with request validation. */
export const GREYBOX_INSTRUCTION_MAX = 4000;

export const GREYBOX_ASPECTS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '21:9']);

/** Media role on a place's reference image that a saved shot's capture carries. */
export const GREYBOX_SHOT_ROLE_PREFIX = 'greybox-shot:';

/** A saved shot id fits inside the 64-character media role it is tagged with. */
export const GREYBOX_SHOT_ID_MAX = 64 - GREYBOX_SHOT_ROLE_PREFIX.length;
export const GREYBOX_SHOT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Figure placement instructions stay separate from the director's authored text. */
export function greyboxFigurePromptLines(scene, shot) {
  return (shot?.figures || []).map((figure) => {
    const anchor = scene.anchors.find((a) => a.id === figure.anchorId);
    return anchor ? `${anchor.label} stands at the "${anchor.id}" mark${figure.pose ? `, ${figure.pose}` : ''}` : null;
  }).filter(Boolean);
}

/**
 * Capture background: a light overcast sky, so dark poles, wires and rooflines
 * stay visible to an image model painting a plate from the capture (#15327).
 */
export const GREYBOX_SKY_COLOR = '#c9d6e2';

// Zone ids (case-insensitive, singular or plural) the greybox contract asks a street greybox to use.
const zoneKey = (id) => String(id || '').toLowerCase().replace(/s$/, '');

/**
 * Plain-language street facts read from a greybox's infrastructure zones
 * (`pole`, `wire`, `drop`, `lamp`, `road`, `sidewalk`, `derelict`), so a painter
 * keeps the modeled pole line, the stated sidewalks and only the marked
 * derelict houses (#15327, #15328). With `shot`, says which side of the
 * frame the pole line is on.
 */
export function greyboxInfrastructurePromptLines(scene, shot = null) {
  const zoneOf = new Map((scene?.zones || []).map((zone) => [zone.id, zoneKey(zone.id)]));
  const parts = (key) => (scene?.parts || []).filter((part) => zoneOf.get(part.zone) === key);
  const poles = parts('pole');
  const lines = [];
  if (poles.length) {
    let side = '';
    if (shot?.position && shot?.target) {
      // Camera right on the ground plane is (-forward.z, forward.x) with Y up.
      const fx = shot.target[0] - shot.position[0];
      const fz = shot.target[2] - shot.position[2];
      const sides = new Set(poles.map((p) => Math.sign(-fz * (p.position[0] - shot.position[0]) + fx * (p.position[2] - shot.position[2]))));
      if (sides.size === 1 && !sides.has(0)) side = sides.has(1) ? ' on the right of the frame' : ' on the left of the frame';
    }
    const drops = parts('drop').length > 0;
    const lamps = parts('lamp').length > 0;
    lines.push(`Street power: ${poles.length === 1 ? 'one utility pole' : `${poles.length} utility poles in one line`}${side}, exactly where the greybox shows them, with their wires${drops ? ', service drops to the houses' : ''}${lamps ? ' and pole-mounted streetlights' : ''}; no extra poles, lamps or wires.`);
  } else if (parts('lamp').length) {
    lines.push('Streetlights only where the greybox shows them.');
  }
  if (parts('sidewalk').length) lines.push('Sidewalks only where the greybox shows them.');
  else if (parts('road').length) lines.push('This street has no sidewalks: the lawns or shoulders run to the road edge.');
  const derelict = [...new Set(parts('derelict').map((part) => part.label || part.id))];
  if (derelict.length) lines.push(`Derelict: ${derelict.join(', ')}. Only ${derelict.length === 1 ? 'this looks' : 'these look'} abandoned; every other building is lived-in.`);
  return lines;
}
