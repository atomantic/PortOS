import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { worldSetFootprint as footprint } from '../../../../server/lib/worldMap.js';

const PATH_COLORS = { road: '#5b606b', footpath: '#a39a8c', track: '#8a7155', corridor: '#7a8494' };
const round = (n) => Math.round(n * 10) / 10 + 0;
const noop = () => {};
const LABEL_MAX = 24;
const label = (text) => (text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text);

const LABEL_PX = 11;
const LABEL_CHAR_EM = 0.62;

// A set's footprint corners on the ground, turned and placed as the map draws it.
function setCorners(set, entry) {
  const box = footprint(entry?.ingredient?.payload?.greybox);
  const t = (set.rotationDegrees * Math.PI) / 180;
  return [[box.x, box.z], [box.x + box.w, box.z], [box.x, box.z + box.d], [box.x + box.w, box.z + box.d]]
    .map(([x, z]) => [set.position[0] + x * Math.cos(t) + z * Math.sin(t), set.position[1] - x * Math.sin(t) + z * Math.cos(t)]);
}

/** A view that shows every set's whole footprint and every path. `places` adds loaded greybox sizes. */
export function fitWorldView(world, places = {}) {
  const points = world ? [...world.sets.flatMap((set) => setCorners(set, places[set.ingredientId])), ...world.paths.flatMap((path) => path.points)] : [];
  if (!points.length) return { cx: 0, cz: 0, size: 400 };
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cz: (Math.min(...zs) + Math.max(...zs)) / 2, size: Math.max(60, span * 1.15) };
}

/**
 * The map's view, fitted to the whole world and refitted as its places load
 * (their greybox sizes change the footprints) until the user pans or zooms.
 * `fit()` refits and resumes following.
 */
export function useWorldMapView(world, places = {}) {
  const touched = useRef(false);
  const latest = useRef({ world, places });
  latest.current = { world, places };
  const [view, setViewState] = useState(() => fitWorldView(world, places));
  const loaded = Object.keys(places).sort().join(',');
  useEffect(() => {
    if (!touched.current) setViewState(fitWorldView(latest.current.world, latest.current.places));
  }, [loaded]);
  const setView = useCallback((next) => { touched.current = true; setViewState(next); }, []);
  const fit = useCallback(() => { touched.current = false; setViewState(fitWorldView(latest.current.world, latest.current.places)); }, []);
  return { view, setView, fit };
}

/**
 * Where each label fits without overlapping another, in map units: tried on the
 * set, then above and below its footprint, then stepped further out. A label
 * with no free spot is left off (its set still shows, and names itself on hover
 * and when selected). Earlier items win, so pass the selected one first.
 * `items`: `{ id, text, x, y, top, bottom }`; `unitPerPx` scales the pixel font.
 */
export function layoutWorldLabels(items, unitPerPx, fontPx = LABEL_PX) {
  const h = fontPx * 1.3 * unitPerPx;
  const placed = [];
  const hits = (a) => placed.some((b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1);
  for (const item of items) {
    const w = (item.text.length * fontPx * LABEL_CHAR_EM + 4) * unitPerPx;
    const ys = [item.y, item.top - h * 0.6, item.bottom + h * 0.6];
    for (let step = 1; step <= 3; step += 1) ys.push(item.y - h * step, item.y + h * step);
    const spot = ys.map((y) => ({ x0: item.x - w / 2, x1: item.x + w / 2, y0: y - h / 2, y1: y + h / 2 })).find((box) => !hits(box));
    if (!spot) continue;
    placed.push({ ...spot, id: item.id, text: item.text, x: item.x, y: (spot.y0 + spot.y1) / 2 });
  }
  return placed;
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
  const labelItems = world.sets.map((set) => {
    const zs = setCorners(set, places[set.ingredientId]).map((p) => p[1]);
    return { id: set.id, text: label(nameOf(set)), x: set.position[0], y: set.position[1], top: Math.min(...zs), bottom: Math.max(...zs) };
  }).sort((a, b) => (b.id === selected.slice(4)) - (a.id === selected.slice(4)));
  const labels = layoutWorldLabels(labelItems, unitPerPx);
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
      {world.sets.map((set) => {
        const entry = places[set.ingredientId];
        const box = footprint(entry?.ingredient?.payload?.greybox);
        const on = selected === `set:${set.id}`;
        return (
          <g key={set.id} transform={`translate(${set.position[0]} ${set.position[1]}) rotate(${-set.rotationDegrees})`}
            onPointerDown={(event) => start(event, { kind: 'set', id: set.id, select: `set:${set.id}` })}>
            <title>{nameOf(set)}</title>
            <rect x={box.x} y={box.z} width={box.w} height={box.d} fill={entry === null ? '#7a3b3b' : '#6f7f96'} fillOpacity={on ? 0.7 : 0.4}
              stroke={on ? '#ffdd55' : '#1b1e24'} strokeWidth={stroke * (on ? 2 : 1)} />
            {/* The greybox's front (its +Z, the way a facing of 0 looks). */}
            <line x1="0" y1="0" x2="0" y2={box.z + box.d} stroke="#ffffff" strokeWidth={stroke} pointerEvents="none" />
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
