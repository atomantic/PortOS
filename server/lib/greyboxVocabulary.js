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
// A pole this close to the aim axis is not on either side of the street.
const SIDE_MARGIN_M = 0.5;
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
  const forwardOf = (part) => (part.position[0] - camera.origin[0]) * camera.forward[0] + (part.position[2] - camera.origin[1]) * camera.forward[1];
  const lateralOf = (part) => (part.position[0] - camera.origin[0]) * camera.right[0] + (part.position[2] - camera.origin[1]) * camera.right[1];
  const furniture = (kind) => (scene?.parts || []).filter((part) => part.street?.kind === kind && Array.isArray(part.position)
    && (!camera || forwardOf(part) > 0));
  const wireRule = 'a pole never stands without wires and no wire crosses the road.';
  const lines = [];
  const poles = furniture('pole');
  const lamps = furniture('lamp');
  if (poles.length) {
    // The line runs between the two poles farthest apart, so the order depends on geometry alone.
    let along = [0, 0];
    for (const a of poles) {
      for (const b of poles) {
        const vector = [b.position[0] - a.position[0], b.position[2] - a.position[2]];
        if (Math.hypot(...vector) > Math.hypot(...along)) along = vector;
      }
    }
    // Orient the axis canonically so the listing does not depend on part order.
    const axis = along[0] < 0 || (along[0] === 0 && along[1] < 0) ? along.map((v) => -v) : along;
    const ordered = [...poles].sort((a, b) => (a.position[0] * axis[0] + a.position[2] * axis[1]) - (b.position[0] * axis[0] + b.position[2] * axis[1]));
    // Street side is only stated for a line that runs along the view; a line crossing the frame has no single side.
    const lat = camera ? ordered.map(lateralOf) : [];
    const depth = camera ? ordered.map(forwardOf) : [];
    const range = (values) => Math.max(...values) - Math.min(...values);
    const alongView = camera && range(lat) <= range(depth);
    const left = alongView ? ordered.filter((_, i) => lat[i] < -SIDE_MARGIN_M) : [];
    const right = alongView ? ordered.filter((_, i) => lat[i] > SIDE_MARGIN_M) : [];
    const onAxis = alongView && ordered.some((_, i) => Math.abs(lat[i]) <= SIDE_MARGIN_M);
    // Two lines only when nothing stands between the left and right clusters; otherwise it is one line.
    if (left.length && right.length && !onAxis) {
      lines.push(`Utility poles stand on both sides of the street: ${nameList(left)} on the viewer's left and ${nameList(right)} on the right. Each side is its own line, its poles joined pole to pole by continuous overhead wires that run on past the end poles along that side; ${wireRule}`);
    } else {
      const side = left.length === ordered.length ? " on the viewer's left side of the street" : right.length === ordered.length ? " on the viewer's right side of the street" : '';
      lines.push(poles.length === 1
        ? `Utility pole ${nameList(ordered)} stands${side} and carries continuous overhead wires that run off past the pole both ways; ${wireRule}`
        : `Utility poles ${nameList(ordered)} stand in one line along the road${side ? `, all${side}` : ''}, joined pole to pole by continuous overhead wires that also run on past the end poles; ${wireRule}`);
    }
  } else if (lamps.some((part) => part.street.mount === 'pole')) {
    lines.push(`The utility poles carrying the streetlights have continuous overhead wires that run past both ends; ${wireRule}`);
  }
  // Lamps sharing a mount and an apparent arm direction read as one sentence, so none is dropped.
  const groups = new Map();
  for (const lamp of lamps) {
    const seen = camera ? armAsSeen(camera, lamp.street.armDegrees) : null;
    const key = `${lamp.street.mount ?? ''}|${seen ?? (camera ? '' : lamp.street.armDegrees)}`;
    if (!groups.has(key)) groups.set(key, { seen, mount: lamp.street.mount, parts: [] });
    groups.get(key).parts.push(lamp);
  }
  for (const { seen, mount, parts } of groups.values()) {
    const many = parts.length > 1;
    const mounted = mount === 'pole' ? (many ? ' are bracketed on utility poles' : ' is bracketed on a utility pole')
      : mount === 'post' ? (many ? ' stand on their own posts' : ' stands on its own post') : '';
    // Without a usable camera aim the bearing itself is the only direction there is to give.
    const reaches = seen ? `${seen}, ` : camera ? '' : `on bearing ${parts[0].street.armDegrees} degrees (0 toward +Z, 90 toward +X), `;
    lines.push(`Streetlight${many ? 's' : ''} ${nameList(parts)}${mounted}: ${many ? 'their arms reach' : 'its arm reaches'} ${reaches}out over the road with the lamp head${many ? 's' : ''} above the pavement, never aimed at a house or yard.`);
  }
  const mounts = new Set(lamps.map((part) => part.street.mount));
  if (lamps.length > 1 && mounts.size === 1 && !mounts.has(undefined)) {
    lines.push(mounts.has('pole') ? 'Every streetlight here is arm-mounted on a utility pole; draw no separate lamp posts.' : 'Every streetlight here stands on its own post; draw none on a utility pole.');
  }
  return lines;
}
