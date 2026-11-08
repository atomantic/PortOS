import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Check, Loader2, Minus, Plus, RotateCcw, RotateCw, Route, Trash2, X } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import useCatalogPlaces from '../../hooks/useCatalogPlaces';
import useListResource from '../../hooks/useListResource';
import ListLoadError from '../ui/ListLoadError';
import { listCatalogIngredients, saveCatalogTown } from '../../services/apiCatalog';
import { ingredientPath } from '../../lib/creativeLibraries';
import { formatCount } from '../../utils/formatters';
import {
  TOWN_LIMITS, TOWN_STREET_DEFAULT_WIDTH, TOWN_STREET_KINDS, TOWN_STREET_SIDES, blankTown, placeTown, townClockText, townProblems,
} from '../../../../server/lib/townMap.js';

// three.js stays out of the main chunk: the 3D view loads when it is opened.
const TownViewer = lazy(() => import('./TownViewer'));

const buttonCls = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const iconCls = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg border border-port-border text-gray-200 hover:border-port-accent/60 disabled:opacity-40';
const selectCls = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 text-sm text-port-text';
const STREET_COLORS = { road: '#5b606b', path: '#a39a8c', track: '#8a7155' };
const KIND_LABELS = { road: 'Road', path: 'Footpath', track: 'Dirt track' };
const SIDE_LABELS = { houses: 'Houses', fence: 'Fence', fields: 'Fields', none: 'Nothing' };
const SET_SIZE = 30;
const round = (n) => Math.round(n * 10) / 10 + 0;
const newId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

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

function fitView(town) {
  const points = [...town.sets.map((set) => set.position), ...town.streets.flatMap((street) => street.points)];
  if (!points.length) return { cx: 0, cz: 0, size: 400 };
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cz: (Math.min(...zs) + Math.max(...zs)) / 2, size: Math.max(200, (Math.max(...xs) - Math.min(...xs)) * 1.3, (Math.max(...zs) - Math.min(...zs)) * 1.3) };
}

/**
 * Top-down town map: drag a set or a street point to move it, drag the empty
 * ground to pan, tap the ground while drawing to add street points. North is up.
 */
function TownMap({ town, places, selected, drawing, view, onView, onSelect, onMoveSet, onMovePoint, onAddPoint }) {
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
      aria-label="Town map, north is up"
      onPointerDown={(event) => start(event, { kind: 'ground' })}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => { drag.current = null; }}
    >
      {town.streets.map((street) => (
        <g key={street.id}>
          <polyline points={street.points.map((p) => p.join(',')).join(' ')} fill="none" stroke={STREET_COLORS[street.kind]}
            strokeWidth={Math.max(street.width, stroke * 3)} strokeLinecap="round" strokeLinejoin="round"
            onPointerDown={(event) => start(event, { kind: 'street', select: `street:${street.id}` })} />
          {selected === `street:${street.id}` && (
            <>
              <polyline points={street.points.map((p) => p.join(',')).join(' ')} fill="none" stroke="#ffdd55" strokeWidth={stroke} pointerEvents="none" />
              {street.points.map((p, index) => (
                <circle key={index} cx={p[0]} cy={p[1]} r={stroke * 6} fill="#ffdd55" aria-label={`Street point ${index + 1}`}
                  onPointerDown={(event) => start(event, { kind: 'point', id: street.id, index, select: `street:${street.id}` })} />
              ))}
            </>
          )}
        </g>
      ))}
      {town.sets.map((set) => {
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
      {town.sets.map((set) => (
        <text key={set.id} x={set.position[0]} y={set.position[1]} fontSize={stroke * 11} fill="#ffffff" textAnchor="middle" pointerEvents="none"
          paintOrder="stroke" stroke="#000000" strokeWidth={stroke * 2}>
          {places[set.ingredientId]?.ingredient?.name || (places[set.ingredientId] === null ? 'Missing' : '…')}
        </text>
      ))}
      {drawing && drawing.length > 0 && (
        <polyline points={drawing.map((p) => p.join(',')).join(' ')} fill="none" stroke="#ffdd55" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 6} ${stroke * 4}`} pointerEvents="none" />
      )}
    </svg>
  );
}

/** Search the catalog's environments to add one to the town as a set. */
function AddSet({ exclude, onAdd }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const fetcher = useCallback(() => listCatalogIngredients({ type: 'place', q: search || undefined, limit: 24, silent: true }).then((page) => page?.items), [search]);
  const list = useListResource(fetcher);
  const options = list.items.filter((item) => !exclude.has(item.id));
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor="town-add-set" className="block text-xs text-port-text-muted">Add an environment as a set</label>
      <input id="town-add-set" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search environments"
        className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 text-sm text-port-text" />
      <ul className="flex min-w-0 flex-wrap gap-1.5">
        {options.slice(0, 12).map((item) => (
          <li key={item.id}><button type="button" className={buttonCls} onClick={() => onAdd(item)}><Plus size={14} aria-hidden="true" /> {item.name}</button></li>
        ))}
        {list.state === 'ready' && !options.length && <li className="text-xs text-port-text-muted">No other environments match.</li>}
      </ul>
      {list.state === 'error' && <ListLoadError what="environments" error={list.error} onRetry={list.retry} />}
    </div>
  );
}

/**
 * The Town tab of an Environment: a map that places other environments (each
 * with its own greybox) and joins them with streets, for a music video's
 * previz to follow people through the whole town. Filler houses, fences,
 * fields and lamps come from each street's kind and sides. The selected set or
 * street lives in the URL (`?townItem=`). Saved through the server's schema.
 */
export default function TownPanel({ record, readOnly = false, disabled = false, onBusyChange, onSaved }) {
  const [params, setParams] = useSearchParams();
  const saved = placeTown(record);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drawing, setDrawing] = useState(null);
  const [show3d, setShow3d] = useState(false);
  const [clock, setClock] = useState(21 * 60);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const town = draft || saved;
  const [view, setView] = useState(() => fitView(town || blankTown()));
  const places = useCatalogPlaces((town?.sets || []).map((set) => set.ingredientId));
  const selected = params.get('townItem') || '';
  const select = (item) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (item) next.set('townItem', item); else next.delete('townItem');
    return next;
  }, { replace: true });
  const set = selected.startsWith('set:') ? town?.sets.find((entry) => entry.id === selected.slice(4)) : null;
  const street = selected.startsWith('street:') ? town?.streets.find((entry) => entry.id === selected.slice(7)) : null;
  const problems = useMemo(() => townProblems(town, places), [town, places]);

  const edit = (change) => setDraft((current) => change(current || saved || blankTown(Math.floor(Math.random() * 1e6))));
  const patchSet = (id, patch) => edit((t) => ({ ...t, sets: t.sets.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }));
  const patchStreet = (id, patch) => edit((t) => ({ ...t, streets: t.streets.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }));

  const persist = async (next) => {
    setBusy(true);
    onBusyChange?.(true);
    const updated = await saveCatalogTown(record.id, next).catch(() => null);
    setBusy(false);
    onBusyChange?.(false);
    if (!updated) return;
    setDraft(null);
    onSaved?.(updated);
    toast.success(next ? 'Town saved' : 'Town removed');
  };

  if (!town) {
    return (
      <section className="space-y-3 rounded-lg border border-port-border p-3" aria-label="Town map">
        <p className="text-sm text-port-text-muted">
          A town map places other environments on one map and joins them with streets, so a music video's previz can follow its people through the whole town.
          A video can also draft one from its route maps on its Previz step.
        </p>
        {!readOnly && <button type="button" className={buttonCls} disabled={disabled} onClick={() => edit((t) => t)}><Plus size={14} aria-hidden="true" /> Start a town map</button>}
      </section>
    );
  }

  const onAddPoint = (point) => setDrawing((points) => [...(points || []), point]);
  const finishStreet = () => {
    if ((drawing || []).length >= 2) {
      const id = newId('street');
      edit((t) => ({ ...t, streets: [...t.streets, { id, kind: 'road', sides: 'houses', width: TOWN_STREET_DEFAULT_WIDTH.road, points: drawing.slice(0, TOWN_LIMITS.STREET_POINTS) }] }));
      select(`street:${id}`);
    }
    setDrawing(null);
  };
  const addSet = (item) => {
    const id = newId('set');
    edit((t) => ({ ...t, sets: [...t.sets, { id, ingredientId: item.id, position: [round(view.cx), round(view.cz)], rotationDegrees: 0 }] }));
    select(`set:${id}`);
  };
  const placed = new Set([record.id, ...town.sets.map((entry) => entry.ingredientId)]);
  const zoom = (factor) => setView((v) => ({ ...v, size: Math.min(TOWN_LIMITS.COORD * 2, Math.max(40, v.size * factor)) }));

  return (
    <section className="min-w-0 space-y-3" aria-label="Town map">
      <fieldset disabled={readOnly || disabled || busy} className="min-w-0 space-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {drawing
            ? <>
                <span className="text-sm text-port-text">Tap the map to add points ({formatCount(drawing.length)})</span>
                <button type="button" className={buttonCls} onClick={finishStreet}><Check size={14} aria-hidden="true" /> {drawing.length >= 2 ? 'Finish street' : 'Cancel'}</button>
              </>
            : <button type="button" className={buttonCls} disabled={town.streets.length >= TOWN_LIMITS.STREETS} onClick={() => { select(''); setDrawing([]); }}><Route size={14} aria-hidden="true" /> Draw a street</button>}
          <span className="ml-auto inline-flex gap-1">
            <button type="button" className={iconCls} aria-label="Zoom in" onClick={() => zoom(0.7)}><Plus size={16} aria-hidden="true" /></button>
            <button type="button" className={iconCls} aria-label="Zoom out" onClick={() => zoom(1 / 0.7)}><Minus size={16} aria-hidden="true" /></button>
            <button type="button" className={buttonCls} onClick={() => setView(fitView(town))}>Fit</button>
          </span>
        </div>
      </fieldset>
      <TownMap town={town} places={places} selected={selected} drawing={drawing} view={view} onView={setView} onSelect={readOnly ? () => {} : select}
        onMoveSet={(id, position) => !readOnly && patchSet(id, { position })}
        onMovePoint={(id, index, point) => !readOnly && edit((t) => ({ ...t, streets: t.streets.map((entry) => (entry.id === id ? { ...entry, points: entry.points.map((p, i) => (i === index ? point : p)) } : entry)) }))}
        onAddPoint={onAddPoint} />
      {problems.length > 0 && <p role="status" className="text-xs text-port-warning">{problems.map((entry) => entry.problem).join(' · ')}</p>}
      <fieldset disabled={readOnly || disabled || busy} className="min-w-0 space-y-3">
        {set && (
          <div className="min-w-0 space-y-2 rounded-lg border border-port-border p-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-port-text">{places[set.ingredientId]?.ingredient?.name || 'Set'}</span>
              {places[set.ingredientId]?.ingredient && <Link className="text-xs underline" to={`${ingredientPath(places[set.ingredientId].ingredient)}/greybox`}>Open its greybox</Link>}
              <button type="button" className={`${iconCls} ml-auto`} aria-label="Turn left 15°" onClick={() => patchSet(set.id, { rotationDegrees: ((set.rotationDegrees + 15 + 360) % 360) })}><RotateCcw size={16} aria-hidden="true" /></button>
              <label htmlFor="town-set-turn" className="sr-only">Turn (degrees)</label>
              <input id="town-set-turn" type="number" min={0} max={359} value={Math.round(set.rotationDegrees)} className="min-h-[44px] w-20 rounded border border-port-border bg-port-bg px-2 text-sm"
                onChange={(event) => patchSet(set.id, { rotationDegrees: ((Number(event.target.value) || 0) % 360 + 360) % 360 })} />
              <button type="button" className={iconCls} aria-label="Turn right 15°" onClick={() => patchSet(set.id, { rotationDegrees: ((set.rotationDegrees - 15 + 360) % 360) })}><RotateCw size={16} aria-hidden="true" /></button>
              <button type="button" className={iconCls} aria-label="Remove this set from the town" onClick={() => { edit((t) => ({ ...t, sets: t.sets.filter((entry) => entry.id !== set.id) })); select(''); }}><Trash2 size={16} aria-hidden="true" /></button>
            </div>
          </div>
        )}
        {street && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-port-border p-2 text-sm">
            <label htmlFor="town-street-kind" className="text-port-text-muted">Street</label>
            <select id="town-street-kind" className={selectCls} value={street.kind}
              onChange={(event) => patchStreet(street.id, { kind: event.target.value, width: TOWN_STREET_DEFAULT_WIDTH[event.target.value] })}>
              {TOWN_STREET_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
            </select>
            <label htmlFor="town-street-sides" className="text-port-text-muted">Lined with</label>
            <select id="town-street-sides" className={selectCls} value={street.sides} onChange={(event) => patchStreet(street.id, { sides: event.target.value })}>
              {TOWN_STREET_SIDES.map((sides) => <option key={sides} value={sides}>{SIDE_LABELS[sides]}</option>)}
            </select>
            <label htmlFor="town-street-width" className="text-port-text-muted">Width (m)</label>
            <input id="town-street-width" type="number" min={1} max={TOWN_LIMITS.WIDTH_MAX} step={0.5} value={street.width} className="min-h-[44px] w-20 rounded border border-port-border bg-port-bg px-2"
              onChange={(event) => patchStreet(street.id, { width: Math.min(TOWN_LIMITS.WIDTH_MAX, Math.max(1, Number(event.target.value) || 1)) })} />
            <button type="button" className={`${iconCls} ml-auto`} aria-label="Remove this street" onClick={() => { edit((t) => ({ ...t, streets: t.streets.filter((entry) => entry.id !== street.id) })); select(''); }}><Trash2 size={16} aria-hidden="true" /></button>
          </div>
        )}
        {!readOnly && town.sets.length < TOWN_LIMITS.SETS && <AddSet exclude={placed} onAdd={addSet} />}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" className={buttonCls} aria-pressed={show3d} onClick={() => setShow3d((on) => !on)}>{show3d ? 'Hide 3D view' : 'Show 3D view'}</button>
          {show3d && (
            <span className="inline-flex min-w-0 flex-1 items-center gap-2">
              <label htmlFor="town-clock" className="text-xs text-port-text-muted">Time</label>
              <input id="town-clock" type="range" min={0} max={1439} step={5} value={clock} onChange={(event) => setClock(Number(event.target.value))} className="min-w-0 flex-1" />
              <span className="tabular-nums text-xs text-port-text">{townClockText(clock)}</span>
            </span>
          )}
        </div>
      </fieldset>
      {show3d && <Suspense fallback={<p className="text-sm text-port-text-muted"><Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" />Loading the 3D view…</p>}><TownViewer town={town} places={places} clockMinutes={clock} /></Suspense>}
      {!readOnly && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-xs text-port-text-muted">{formatCount(town.sets.length)} set{town.sets.length === 1 ? '' : 's'} · {formatCount(town.streets.length)} street{town.streets.length === 1 ? '' : 's'}</span>
          {draft && <button type="button" className={buttonCls} disabled={busy || disabled} onClick={() => { setDraft(null); setDrawing(null); }}><X size={14} aria-hidden="true" /> Discard changes</button>}
          {draft && <button type="button" className={`${buttonCls} border-port-accent text-port-accent`} disabled={busy || disabled } onClick={() => persist(draft)}>{busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />} Save town</button>}
          {!draft && saved && (confirmRemove
            ? <ConfirmButtonPair className="ml-auto" prompt="Remove the town map?" confirmText="Remove" largeTouchTargets busy={busy} onConfirm={() => { setConfirmRemove(false); persist(null); }} onCancel={() => setConfirmRemove(false)} />
            : <button type="button" className={`${buttonCls} ml-auto`} disabled={busy || disabled} onClick={() => setConfirmRemove(true)}><Trash2 size={14} aria-hidden="true" /> Remove town map</button>)}
        </div>
      )}
    </section>
  );
}
