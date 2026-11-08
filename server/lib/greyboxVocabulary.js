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

const MAX_STREET_NAMES = 8;
const toRad = (degrees) => (degrees * Math.PI) / 180;

/** Ground-plane camera axes (forward, right) for a saved shot, or null when it has no usable aim. */
function cameraGround(shot) {
  const [px, , pz] = shot?.position || [];
  const [tx, , tz] = shot?.target || [];
  if (![px, pz, tx, tz].every(Number.isFinite)) return null;
  const length = Math.hypot(tx - px, tz - pz);
  if (length === 0) return null;
  const forward = [(tx - px) / length, (tz - pz) / length];
  return { origin: [px, pz], forward, right: [-forward[1], forward[0]] };
}

/** Which way an arm bearing reaches as the viewer sees it (X right, Z toward the default viewer, bearing 0 = +Z). */
function armAsSeen(camera, armDegrees) {
  const arm = [Math.sin(toRad(armDegrees)), Math.cos(toRad(armDegrees))];
  const ahead = arm[0] * camera.forward[0] + arm[1] * camera.forward[1];
  const side = arm[0] * camera.right[0] + arm[1] * camera.right[1];
  const across = Math.abs(side) < 0.38 ? '' : side > 0 ? 'right' : 'left';
  const depth = Math.abs(ahead) < 0.38 ? '' : ahead > 0 ? 'away from the camera' : 'toward the camera';
  return [across && `toward the viewer's ${across}`, depth].filter(Boolean).join(' and ') || null;
}

const nameList = (parts) => {
  const names = parts.slice(0, MAX_STREET_NAMES).map((part) => `"${part.label || part.id}"`).join(', ');
  return parts.length > MAX_STREET_NAMES ? `${names} and ${parts.length - MAX_STREET_NAMES} more` : names;
};

/**
 * Street furniture facts for a shot, one visible sentence each: the pole line
 * with its wires, then each lamp's arm over the road. A greybox primitive is a
 * grey cylinder, so without these a painter guesses and draws poles with no
 * wires or lamps aimed at the houses. Only parts in front of a saved camera are
 * stated; a shot with no usable aim states them all.
 */
export function greyboxStreetPromptLines(scene, shot) {
  const camera = cameraGround(shot);
  const inFront = (part) => {
    if (!camera) return true;
    const [x, , z] = part.position || [];
    return (x - camera.origin[0]) * camera.forward[0] + (z - camera.origin[1]) * camera.forward[1] > 0;
  };
  const furniture = (kind) => (scene?.parts || []).filter((part) => part.street?.kind === kind && Array.isArray(part.position) && inFront(part));
  const lines = [];
  const poles = furniture('pole');
  if (poles.length) {
    // Walk the line from one end: the pole farthest from the first is the other end.
    const [first] = poles;
    const far = poles.reduce((best, part) => (Math.hypot(part.position[0] - first.position[0], part.position[2] - first.position[2])
      > Math.hypot(best.position[0] - first.position[0], best.position[2] - first.position[2]) ? part : best), first);
    const along = [far.position[0] - first.position[0], far.position[2] - first.position[2]];
    // Orient the axis canonically so the listing does not depend on part order.
    const axis = along[0] < 0 || (along[0] === 0 && along[1] < 0) ? along.map((v) => -v) : along;
    const ordered = [...poles].sort((a, b) => (a.position[0] * axis[0] + a.position[2] * axis[1]) - (b.position[0] * axis[0] + b.position[2] * axis[1]));
    lines.push(poles.length === 1
      ? `Utility pole ${nameList(ordered)} carries continuous overhead wires that run off past the pole on both sides; a pole never stands without wires.`
      : `Utility poles ${nameList(ordered)} stand in one line along the road, joined pole to pole by continuous overhead wires that also run on past the end poles; a pole never stands without wires.`);
  }
  const lamps = furniture('lamp');
  const mounts = new Set(lamps.map((part) => part.street.mount));
  for (const lamp of lamps.slice(0, MAX_STREET_NAMES)) {
    const seen = camera ? armAsSeen(camera, lamp.street.armDegrees) : null;
    const mount = lamp.street.mount === 'pole' ? ' is bracketed on a utility pole' : lamp.street.mount === 'post' ? ' stands on its own post' : '';
    lines.push(`Streetlight "${lamp.label || lamp.id}"${mount}: its arm reaches ${seen ? `${seen}, ` : ''}out over the road with the lamp head above the pavement, never aimed at a house or yard.`);
  }
  if (lamps.length > 1 && mounts.size === 1 && !mounts.has(undefined)) {
    lines.push(mounts.has('pole') ? 'Every streetlight here is arm-mounted on a utility pole; draw no separate lamp posts.' : 'Every streetlight here stands on its own post; draw none on a utility pole.');
  }
  return lines;
}
