/** Authored city blocks using Eidoverse's existing gridded building component. */

export function eidoverseDistrictYaw(district) {
  return Math.atan2(-district.anchor[0], -district.anchor[2]);
}

export function eidoverseDistrictPoint(district, x, y, z) {
  const yaw = eidoverseDistrictYaw(district);
  return [district.anchor[0] + Math.cos(yaw) * x + Math.sin(yaw) * z,
    district.anchor[1] + y, district.anchor[2] - Math.sin(yaw) * x + Math.cos(yaw) * z];
}

export function eidoverseDesktopHeight(assets = {}) {
  const bounds = eidoverseModelBounds(assets.desk?.bounds);
  const size = bounds?.max.map((value, axis) => value - bounds.min[axis]);
  return 0.1 + (size ? 2.25 * size[1] / Math.max(...size) : 1.05);
}

function hall(label, width = 8, height = 3.8) {
  const tiles = [];
  const walls = [];
  const apertures = [];
  const left = -width / 2;
  const right = width / 2;
  for (let x = left; x < right; x += 1) {
    for (let z = -6; z < -2; z += 1) tiles.push([x, z]);
    walls.push([0, x, -6], [0, x, -2]);
    apertures.push([0, x, -6, 'window']);
    apertures.push([0, x, -2, Math.abs(x + 0.5) < 2 ? 'arch' : 'window']);
  }
  for (let z = -6; z < -2; z += 1) {
    walls.push([1, left, z], [1, right, z]);
    apertures.push([1, left, z, 'window'], [1, right, z, 'window']);
  }
  return { tile: 2, wallH: height, wallT: 0.2, slabT: 0.1,
    labels: { [`${left},-6`]: label }, levels: [{ y: 0, tiles, walls, apertures }] };
}

/** Each building is one bounded component, including its navigable doorways. */
export function eidoverseCityArchitecture(districts) {
  return districts.map((district) => ({
    key: `hall-${district.id}`, districtId: district.id,
    pos: district.anchor, yaw: eidoverseDistrictYaw(district), structure: hall(district.label, district.id === 'nexus' ? 6 : 8,
      district.id === 'nexus' ? 5.2 : 3.8),
  }));
}

/** Furniture sits beside entrances; the forecourt and street stay unobstructed. */
export function eidoverseCityFurniture(districts, assets = {}) {
  const desktopHeight = eidoverseDesktopHeight(assets);
  const furniture = districts.flatMap((district) => {
    const at = (x, y, z) => eidoverseDistrictPoint(district, x, y, z);
    const props = [
      { key: `${district.id}-lamp`, slot: 'activity', pos: at(9, 0, -2), scale: 1, size: 3.4 },
      ...[-1, 1].flatMap((side) => [
        { key: `${district.id}-tree-${side}`, slot: 'tree', pos: at(side * 11, 0, -6), scale: 1, size: 5.5 },
        { key: `${district.id}-garden-tree-${side}`, slot: 'tree', pos: at(side * 9, 0, 9), scale: 1, size: 4 },
      ]),
    ];
    if (district.id === 'apps') props.push({ key: 'apps-landmark-desk', slot: 'desk', pos: at(-5, 0.1, 3), scale: 1, size: 2.25 });
    if (['agents', 'goals'].includes(district.id)) {
      props.push({ key: `${district.id}-desk`, slot: 'desk', pos: at(-5, 0.1, -7), scale: 1, size: 2.25 });
      props.push({ key: `${district.id}-desktop`, slot: 'app', pos: at(-5, desktopHeight, -7), scale: 1, size: 0.7 });
    }
    if (['agents', 'data', 'federation'].includes(district.id)) {
      props.push({ key: `${district.id}-barrel`, slot: 'barrel', pos: at(6, 0.1, -7), scale: 0.65 });
      props.push({ key: `${district.id}-crate`, slot: 'task', pos: at(3, 0.1, -9), scale: 0.65 });
    }
    if (district.id === 'data') {
      props.push({ key: `${district.id}-terminal-desk`, slot: 'desk', pos: at(5, 0.1, -6), scale: 1, size: 2.25 });
      props.push({ key: `${district.id}-terminal`, slot: 'app', pos: at(5, desktopHeight, -6), scale: 1, size: 0.7 });
    }
    return props.map((prop) => ({ ...prop, yaw: eidoverseDistrictYaw(district), districtId: district.id }));
  });
  return [...furniture, ...Array.from({ length: 6 }, (_, i) => {
    const angle = i / 6 * Math.PI * 2;
    return { key: `park-tree-${i}`, slot: 'tree', districtId: 'nexus',
      pos: [Math.sin(angle) * 18, 0, Math.cos(angle) * 18], scale: 1, size: 5 + i % 2 };
  })];
}

/** Ordered display bays, facing the plaza. No hash-scattered overlapping rings. */
export function eidoverseCitySignalPosition(district, index, indoors = false) {
  const column = index % 4;
  const row = Math.floor(index / 4);
  // Two pairs of bays leave a generous aisle through the entrance.
  const x = [-6, -3.5, 3.5, 6][column];
  const outdoorRow = row - (indoors ? 2 : 0);
  // Large custom limits expand behind the hall, never across the promenade.
  const z = indoors && row < 2 ? -9.5 + row * 3
    : outdoorRow < 3 ? 1 + outdoorRow * 2.5 : -15 - (outdoorRow - 3) * 2.5;
  return eidoverseDistrictPoint(district, x, indoors && row < 2 ? 0.1 : 0.03, z);
}

/** Accept only finite, non-degenerate geometry summaries from the library. */
export function eidoverseModelBounds(value) {
  if (!value || !['min', 'max'].every((key) => Array.isArray(value[key])
    && value[key].length === 3 && value[key].every(Number.isFinite))) return null;
  const size = value.max.map((n, index) => n - value.min[index]);
  if (size.some((n) => n < 0) || Math.max(...size) < 0.000001) return null;
  return { min: [...value.min], max: [...value.max] };
}

/** Place the measured bottom-center at an authored point, at a useful size. */
export function eidoverseModelPlacement({ bounds, pos, yaw, scale, size = 2 }) {
  const box = eidoverseModelBounds(bounds);
  if (!box) return { pos, yaw, scale };
  const extent = Math.max(...box.max.map((n, index) => n - box.min[index]));
  const fittedScale = size * scale / extent;
  const x = (box.min[0] + box.max[0]) * 0.5 * fittedScale;
  const z = (box.min[2] + box.max[2]) * 0.5 * fittedScale;
  return {
    pos: [pos[0] - Math.cos(yaw) * x - Math.sin(yaw) * z,
      pos[1] - box.min[1] * fittedScale,
      pos[2] + Math.sin(yaw) * x - Math.cos(yaw) * z],
    yaw, scale: fittedScale,
  };
}


/** Two-metre visitor chamber: glazed back/sides and a clear plaza-facing entry. */
export function eidoverseCityTravelPod() {
  return {
    tile: 1, wallH: 2.8, wallT: 0.12, slabT: 0.12,
    levels: [{
      y: 0, tiles: [[-1, 0], [0, 0], [-1, 1], [0, 1]],
      walls: [[0, -1, 0], [0, 0, 0], [1, -1, 0], [1, -1, 1], [1, 1, 0], [1, 1, 1]],
      apertures: [[0, -1, 0, 'window'], [0, 0, 0, 'window'], [1, -1, 0, 'window'], [1, 1, 0, 'window']],
    }],
  };
}
