import { useRef } from 'react';

const PATH_COLORS = { road: '#5b606b', footpath: '#a39a8c', track: '#8a7155', corridor: '#7a8494' };
const SET_SIZE = 30;
const round = (n) => Math.round(n * 10) / 10 + 0;
const noop = () => {};

// A set's footprint on the map from its greybox's parts (meters), else a plain square.
function footprint(greybox) {
  const parts = (greybox?.parts || []).filter((part) => part.type === 'box' || part.type === 'plane');
  if (!parts.length) return { x: -SET_SIZE / 2, z: -SET_SIZE / 2, w: SET_SIZE, d: SET_SIZE };
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const part of parts) {
    const [w, , d] = part.type === 'plane' ? [part.size[0], 0, part.size[1]] : part.size;
    minX = Math.min(minX, part.position[0] - w / 2); maxX = Math.max(maxX, part.position[0] + w / 2);
    minZ = Math.min(minZ, part.position[2] - d / 2); maxZ = Math.max(maxZ, part.position[2] + d / 2);
  }
  return { x: minX, z: minZ, w: Math.max(2, maxX - minX), d: Math.max(2, maxZ - minZ) };
}

/** A view that shows every set and path. */
export function fitWorldView(world) {
  const points = [...world.sets.map((set) => set.position), ...world.paths.flatMap((path) => path.points)];
  if (!points.length) return { cx: 0, cz: 0, size: 400 };
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cz: (Math.min(...zs) + Math.max(...zs)) / 2, size: Math.max(200, (Math.max(...xs) - Math.min(...xs)) * 1.3, (Math.max(...zs) - Math.min(...zs)) * 1.3) };
}

/**
 * Top-down world map: drag a set or a path point to move it, drag the empty
 * ground to pan, tap the ground while drawing to add path points. North is up.
 * Without `onSelect` it is a read-only map that still pans. `actors` are
 * people drawn as dots (`{ subjectId, name, position: [x, y, z], color }`).
 */
export default function WorldMap({ world, places, selected = '', drawing = null, view, onView, onSelect = noop, onMoveSet = noop, onMovePoint = noop, onAddPoint = noop, actors = [] }) {
  const svgRef = useRef(null);
  const drag = useRef(null);
  const toWorld = (event) => {
    const svg = svgRef.current;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(svg.getScreenCTM().inverse());
    return [round(local.x), round(local.y)];
  };
  const start = (event, target) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { target, client: [event.clientX, event.clientY], view, moved: false };
    if (target.kind !== 'ground') onSelect(target.select);
  };
  const move = (event) => {
    const active = drag.current;
    if (!active) return;
    const dxPx = event.clientX - active.client[0];
    const dyPx = event.clientY - active.client[1];
    if (Math.hypot(dxPx, dyPx) > 4) active.moved = true;
    if (!active.moved) return;
    if (active.target.kind === 'set') onMoveSet(active.target.id, toWorld(event));
    else if (active.target.kind === 'point') onMovePoint(active.target.id, active.target.index, toWorld(event));
    else if (!drawing) {
      // Pan by screen pixels: the view moves under the pointer, so world points would drift.
      const perPx = active.view.size / (svgRef.current.getBoundingClientRect().width || 1);
      onView({ ...active.view, cx: active.view.cx - dxPx * perPx, cz: active.view.cz - dyPx * perPx });
    }
  };
  const end = (event) => {
    const active = drag.current;
    drag.current = null;
    if (active?.target.kind === 'ground' && !active.moved) {
      if (drawing) onAddPoint(toWorld(event));
      else onSelect('');
    }
  };
  const half = view.size / 2;
  const stroke = view.size / 400;
  return (
    <svg
      ref={svgRef}
      viewBox={`${view.cx - half} ${view.cz - half} ${view.size} ${view.size}`}
      className="aspect-square w-full touch-none select-none rounded-lg border border-port-border bg-[#20241f]"
      role="application"
      aria-label="World map, north is up"
      onPointerDown={(event) => start(event, { kind: 'ground' })}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => { drag.current = null; }}
    >
      {world.paths.map((path) => (
        <g key={path.id}>
          <polyline points={path.points.map((p) => p.join(',')).join(' ')} fill="none" stroke={PATH_COLORS[path.kind]}
            strokeWidth={Math.max(path.width, stroke * 3)} strokeLinecap="round" strokeLinejoin="round"
            onPointerDown={(event) => start(event, { kind: 'path', select: `path:${path.id}` })} />
          {selected === `path:${path.id}` && (
            <>
              <polyline points={path.points.map((p) => p.join(',')).join(' ')} fill="none" stroke="#ffdd55" strokeWidth={stroke} pointerEvents="none" />
              {path.points.map((p, index) => (
                <circle key={index} cx={p[0]} cy={p[1]} r={stroke * 6} fill="#ffdd55" aria-label={`Path point ${index + 1}`}
                  onPointerDown={(event) => start(event, { kind: 'point', id: path.id, index, select: `path:${path.id}` })} />
              ))}
            </>
          )}
        </g>
      ))}
      {world.sets.map((set) => {
        const entry = places[set.ingredientId];
        const box = footprint(entry?.ingredient?.payload?.greybox);
        const on = selected === `set:${set.id}`;
        return (
          <g key={set.id} transform={`translate(${set.position[0]} ${set.position[1]}) rotate(${-set.rotationDegrees})`}
            onPointerDown={(event) => start(event, { kind: 'set', id: set.id, select: `set:${set.id}` })}>
            <rect x={box.x} y={box.z} width={box.w} height={box.d} fill={entry === null ? '#7a3b3b' : '#6f7f96'} fillOpacity="0.75"
              stroke={on ? '#ffdd55' : '#1b1e24'} strokeWidth={stroke * (on ? 2 : 1)} />
            {/* The greybox's front (its +Z, the way a facing of 0 looks). */}
            <line x1="0" y1="0" x2="0" y2={box.z + box.d} stroke="#ffffff" strokeWidth={stroke} pointerEvents="none" />
          </g>
        );
      })}
      {world.sets.map((set) => (
        <text key={set.id} x={set.position[0]} y={set.position[1]} fontSize={stroke * 11} fill="#ffffff" textAnchor="middle" pointerEvents="none"
          paintOrder="stroke" stroke="#000000" strokeWidth={stroke * 2}>
          {places[set.ingredientId]?.ingredient?.name || (places[set.ingredientId] === null ? 'Missing' : '…')}
        </text>
      ))}
      {actors.map((actor) => (
        <g key={actor.subjectId} pointerEvents="none">
          <circle cx={actor.position[0]} cy={actor.position[2]} r={stroke * 5} fill={actor.color} stroke="#000000" strokeWidth={stroke} />
          <text x={actor.position[0] + stroke * 7} y={actor.position[2] - stroke * 5} fontSize={stroke * 10} fill="#ffffff" paintOrder="stroke" stroke="#000000" strokeWidth={stroke * 2}>{actor.name}</text>
        </g>
      ))}
      {drawing && drawing.length > 0 && (
        <polyline points={drawing.map((p) => p.join(',')).join(' ')} fill="none" stroke="#ffdd55" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 6} ${stroke * 4}`} pointerEvents="none" />
      )}
    </svg>
  );
}
