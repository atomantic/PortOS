import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { worldSetFootprint as footprint } from '../../../../server/lib/worldMap.js';

const PATH_COLORS = { road: '#5b606b', footpath: '#a39a8c', track: '#8a7155', corridor: '#7a8494' };
const round = (n) => Math.round(n * 10) / 10 + 0;
const noop = () => {};
const LABEL_MAX = 24;
const label = (text) => (text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text);

const LABEL_PX = 11;
const LABEL_CHAR_EM = 0.62;
const MARKER_PX = 7;

// A set's footprint corners on the ground, turned and placed as the map draws it.
function setCorners(set, entry) {
  const box = footprint(entry?.ingredient?.payload?.greybox);
  const t = (set.rotationDegrees * Math.PI) / 180;
  return [[box.x, box.z], [box.x + box.w, box.z], [box.x + box.w, box.z + box.d], [box.x, box.z + box.d]]
    .map(([x, z]) => [set.position[0] + x * Math.cos(t) + z * Math.sin(t), set.position[1] - x * Math.sin(t) + z * Math.cos(t)]);
}

const viewAround = (points, margin, min) => {
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cz: (Math.min(...zs) + Math.max(...zs)) / 2, size: Math.max(min, span * margin) };
};

/**
 * A view that shows every set's marker and every path. Footprints are left
 * out: a set's greybox can carry a ground plane far bigger than the set, and
 * framing those would shrink every marker into one clump.
 */
export function fitWorldView(world) {
  const points = world ? [...world.sets.map((set) => set.position), ...world.paths.flatMap((path) => path.points)] : [];
  if (!points.length) return { cx: 0, cz: 0, size: 400 };
  return viewAround(points, 1.2, 60);
}

/** A view zoomed to one set: its whole footprint, or at least 60 m around it. */
export function worldSetView(set, entry) {
  return viewAround([set.position, ...setCorners(set, entry)], 1.3, 60);
}

/** The map's view, starting fitted to the whole world; `fit()` refits it. */
export function useWorldMapView(world) {
  const latest = useRef(world);
  latest.current = world;
  const [view, setView] = useState(() => fitWorldView(world));
  const fit = useCallback(() => setView(fitWorldView(latest.current)), []);
  return { view, setView, fit };
}

/**
 * Where each set's name fits without covering another name or marker, in map
 * units: right of its marker, then left, above, below, then stepped further
 * out. A name with no free spot is left off (the set still shows, names itself
 * on hover, and is in the list under the map). Earlier items win, so pass the
 * selected one first. `items`: `{ id, text, x, y }` at marker centers;
 * `unitPerPx` scales the pixel font and marker size.
 */
export function layoutWorldLabels(items, unitPerPx, fontPx = LABEL_PX, bounds = null) {
  const h = fontPx * 1.3 * unitPerPx;
  const r = (MARKER_PX + 2) * unitPerPx;
  const box = (x, y, w, hh) => ({ x0: x - w / 2, x1: x + w / 2, y0: y - hh / 2, y1: y + hh / 2 });
  const placed = items.map((item) => box(item.x, item.y, r * 2, r * 2));
  const labels = [];
  const hits = (a) => placed.some((b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1);
  for (const item of items) {
    const w = (item.text.length * fontPx * LABEL_CHAR_EM + 4) * unitPerPx;
    const side = r + w / 2;
    const spots = [[item.x + side, item.y], [item.x - side, item.y], [item.x, item.y - r - h / 2], [item.x, item.y + r + h / 2]];
    for (let step = 1; step <= 3; step += 1) spots.push([item.x + side, item.y - h * step], [item.x + side, item.y + h * step], [item.x - side, item.y - h * step], [item.x - side, item.y + h * step]);
    const spot = spots.map(([x, y]) => box(x, y, w, h)).find((candidate) => !hits(candidate) && (!bounds
      || (candidate.x0 >= bounds.x0 && candidate.x1 <= bounds.x1 && candidate.y0 >= bounds.y0 && candidate.y1 <= bounds.y1)));
    if (!spot) continue;
    placed.push(spot);
    const y = (spot.y0 + spot.y1) / 2;
    // A name stepped away from its marker gets a leader line back to it.
    const leader = Math.abs(y - item.y) > r + h ? { x1: item.x, y1: item.y, x2: Math.min(spot.x1, Math.max(spot.x0, item.x)), y2: y } : null;
    labels.push({ id: item.id, text: item.text, x: (spot.x0 + spot.x1) / 2, y, leader });
  }
  return labels;
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
  // The map fills its box (wider than tall on a desktop), so the view spans `size` along its shorter side.
  const [px, setPx] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const measure = () => {
      const rect = svg.getBoundingClientRect();
      setPx((current) => (current.w === rect.width && current.h === rect.height ? current : { w: rect.width, h: rect.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const aspect = px.w > 0 && px.h > 0 ? px.w / px.h : 1;
  const viewW = view.size * Math.max(1, aspect);
  const viewH = view.size * Math.max(1, 1 / aspect);
  const unitPerPx = px.w > 0 ? viewW / px.w : view.size / 400;
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
      onView({ ...active.view, cx: active.view.cx - dxPx * unitPerPx, cz: active.view.cz - dyPx * unitPerPx });
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
  // Strokes and text are sized in screen pixels, so they stay readable at any zoom.
  const stroke = unitPerPx;
  const nameOf = (set) => places[set.ingredientId]?.ingredient?.name || (places[set.ingredientId] === null ? 'Missing' : '…');
  const selectedSetId = selected.startsWith('set:') ? selected.slice(4) : '';
  const labelItems = world.sets.map((set) => ({ id: set.id, text: label(nameOf(set)), x: set.position[0], y: set.position[1] }))
    .sort((a, b) => (b.id === selectedSetId) - (a.id === selectedSetId));
  const labels = layoutWorldLabels(labelItems, unitPerPx, LABEL_PX, {
    x0: view.cx - viewW / 2 + stroke * 2, x1: view.cx + viewW / 2 - stroke * 2,
    y0: view.cz - viewH / 2 + stroke * 2, y1: view.cz + viewH / 2 - stroke * 2,
  });
  return (
    <svg
      ref={svgRef}
      viewBox={`${view.cx - viewW / 2} ${view.cz - viewH / 2} ${viewW} ${viewH}`}
      className="block w-full touch-none select-none rounded-lg border border-port-border bg-[#20241f]"
      style={{ aspectRatio: '1 / 1', maxHeight: '70vh' }}
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
      {labels.filter((entry) => entry.leader).map((entry) => (
        <line key={`leader-${entry.id}`} {...entry.leader} stroke="#d9dde3" strokeOpacity={0.6} strokeWidth={stroke} pointerEvents="none" />
      ))}
      {/* Only the selected set shows its true-scale footprint; every set is a marker. */}
      {world.sets.filter((set) => set.id === selectedSetId).map((set) => (
        <polygon key={set.id} points={setCorners(set, places[set.ingredientId]).map((p) => p.join(',')).join(' ')} fill="#ffdd55" fillOpacity={0.08}
          stroke="#ffdd55" strokeWidth={stroke * 1.5} strokeDasharray={`${stroke * 6} ${stroke * 4}`} pointerEvents="none" />
      ))}
      {world.sets.map((set) => {
        const on = set.id === selectedSetId;
        const r = stroke * MARKER_PX;
        return (
          <g key={set.id} transform={`translate(${set.position[0]} ${set.position[1]}) rotate(${-set.rotationDegrees})`}
            onPointerDown={(event) => start(event, { kind: 'set', id: set.id, select: `set:${set.id}` })}>
            <title>{nameOf(set)}</title>
            {/* A wider invisible ring keeps the marker easy to tap and drag. */}
            <circle r={r * 2.2} fill="transparent" />
            {/* The greybox's front (its +Z, the way a facing of 0 looks). */}
            <line x1="0" y1="0" x2="0" y2={r * 1.9} stroke={on ? '#ffdd55' : '#ffffff'} strokeWidth={stroke * 2} strokeLinecap="round" pointerEvents="none" />
            <circle r={r} fill={places[set.ingredientId] === null ? '#c25b5b' : '#8fb3e8'} stroke={on ? '#ffdd55' : '#0b0d10'} strokeWidth={stroke * (on ? 3 : 1.5)} />
          </g>
        );
      })}
      {labels.map((entry) => (
        <text key={entry.id} x={entry.x} y={entry.y} fontSize={stroke * LABEL_PX} fontWeight={selected === `set:${entry.id}` ? 700 : 400} fill="#ffffff" textAnchor="middle" dominantBaseline="central" pointerEvents="none"
          paintOrder="stroke" stroke="#000000" strokeWidth={stroke * 3}>
          {entry.text}
        </text>
      ))}
      {actors.map((actor) => (
        <g key={actor.subjectId} pointerEvents="none">
          <circle cx={actor.position[0]} cy={actor.position[2]} r={stroke * 5} fill={actor.color} stroke="#000000" strokeWidth={stroke} />
          <text x={actor.position[0] + stroke * 7} y={actor.position[2] - stroke * 5} fontSize={stroke * LABEL_PX} fill="#ffffff" paintOrder="stroke" stroke="#000000" strokeWidth={stroke * 3}>{actor.name}</text>
        </g>
      ))}
      {drawing && drawing.length > 0 && (
        <polyline points={drawing.map((p) => p.join(',')).join(' ')} fill="none" stroke="#ffdd55" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 6} ${stroke * 4}`} pointerEvents="none" />
      )}
    </svg>
  );
}
