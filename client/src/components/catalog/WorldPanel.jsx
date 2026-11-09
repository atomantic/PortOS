import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Check, Loader2, Minus, Plus, RotateCcw, RotateCw, Route, Trash2, X } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import useCatalogPlaces from '../../hooks/useCatalogPlaces';
import WorldMap, { useWorldMapView, worldSetView } from './WorldMapView';
import useListResource from '../../hooks/useListResource';
import ListLoadError from '../ui/ListLoadError';
import { listCatalogIngredients, saveCatalogWorld } from '../../services/apiCatalog';
import { ingredientPath } from '../../lib/creativeLibraries';
import { formatCount } from '../../utils/formatters';
import {
  WORLD_LIMITS, WORLD_PATH_DEFAULT_WIDTH, WORLD_PATH_KINDS, WORLD_PATH_SIDES, WORLD_POLE_SIDES, WORLD_POLE_SPACING, WORLD_ROAD_INFRASTRUCTURE, WORLD_SETTINGS, blankWorld, placeWorld, worldClockText, worldProblems,
} from '../../../../server/lib/worldMap.js';

// three.js stays out of the main chunk: the 3D view loads when it is opened.
const WorldViewer = lazy(() => import('./WorldViewer'));


const buttonCls = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const iconCls = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg border border-port-border text-gray-200 hover:border-port-accent/60 disabled:opacity-40';
const selectCls = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 text-sm text-port-text';
const KIND_LABELS = { road: 'Road', footpath: 'Footpath', track: 'Dirt track', corridor: 'Corridor' };
const INFRA_LABELS = { overhead: 'Overhead poles and wires', buried: 'Buried lines (streetlights only)', rural: 'Rural poles (no lamps)', none: 'None' };
const SIDE_LABELS = { buildings: 'Buildings', fence: 'Fence or rail', open: 'Open ground', none: 'Nothing' };
const SETTING_LABELS = { outdoor: 'Outdoors (sky by time of day)', indoor: 'Indoors', space: 'Space' };
const round = (n) => Math.round(n * 10) / 10 + 0;
const newId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

/** Search the catalog's environments to add one to the world as a set. */
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
      <label htmlFor="world-add-set" className="block text-xs text-port-text-muted">Add an environment as a set</label>
      <input id="world-add-set" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search environments"
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
 * The World tab of an Environment: a map that places other environments (each
 * with its own greybox) and joins them with paths, for a music video's
 * previz to follow people through the whole world: a town, a ship, a planet,
 * a golf course. Filler buildings, fences, open ground and lamps come from each
 * path's kind and sides; the setting picks the light. The selected set or
 * path lives in the URL (`?worldItem=`). Saved through the server's schema.
 */
export default function WorldPanel({ record, readOnly = false, disabled = false, onBusyChange, onSaved }) {
  const [params, setParams] = useSearchParams();
  const saved = placeWorld(record);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drawing, setDrawing] = useState(null);
  const [show3d, setShow3d] = useState(false);
  const [clock, setClock] = useState(21 * 60);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const world = draft || saved;
  const places = useCatalogPlaces((world?.sets || []).map((set) => set.ingredientId));
  const { view, setView, fit } = useWorldMapView(world);
  const selected = params.get('worldItem') || '';
  const select = (item) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (item) next.set('worldItem', item); else next.delete('worldItem');
    return next;
  }, { replace: true });
  const set = selected.startsWith('set:') ? world?.sets.find((entry) => entry.id === selected.slice(4)) : null;
  const path = selected.startsWith('path:') ? world?.paths.find((entry) => entry.id === selected.slice(5)) : null;
  const problems = useMemo(() => worldProblems(world, places), [world, places]);

  const edit = (change) => setDraft((current) => change(current || saved || blankWorld(Math.floor(Math.random() * 1e6))));
  const patchSet = (id, patch) => edit((t) => ({ ...t, sets: t.sets.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }));
  const patchPath = (id, patch) => edit((t) => ({ ...t, paths: t.paths.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }));

  const persist = async (next) => {
    setBusy(true);
    onBusyChange?.(true);
    const updated = await saveCatalogWorld(record.id, next).catch(() => null);
    setBusy(false);
    onBusyChange?.(false);
    if (!updated) return;
    setDraft(null);
    onSaved?.(updated);
    toast.success(next ? 'World saved' : 'World removed');
  };

  if (!world) {
    return (
      <section className="space-y-3 rounded-lg border border-port-border p-3" aria-label="World map">
        <p className="text-sm text-port-text-muted">
          A world map places other environments on one map and joins them with paths, so a music video's previz can follow its people through the whole world.
          A video can also draft one from its route maps on its Previz step.
        </p>
        {!readOnly && <button type="button" className={buttonCls} disabled={disabled} onClick={() => edit((t) => t)}><Plus size={14} aria-hidden="true" /> Start a world map</button>}
      </section>
    );
  }

  const onAddPoint = (point) => setDrawing((points) => [...(points || []), point]);
  const finishPath = () => {
    if ((drawing || []).length >= 2) {
      const id = newId('path');
      edit((t) => ({ ...t, paths: [...t.paths, { id, kind: 'road', sides: 'buildings', width: WORLD_PATH_DEFAULT_WIDTH.road, points: drawing.slice(0, WORLD_LIMITS.PATH_POINTS) }] }));
      select(`path:${id}`);
    }
    setDrawing(null);
  };
  const addSet = (item) => {
    const id = newId('set');
    edit((t) => ({ ...t, sets: [...t.sets, { id, ingredientId: item.id, position: [round(view.cx), round(view.cz)], rotationDegrees: 0 }] }));
    select(`set:${id}`);
  };
  const placed = new Set([record.id, ...world.sets.map((entry) => entry.ingredientId)]);
  const zoom = (factor) => setView((v) => ({ ...v, size: Math.min(WORLD_LIMITS.COORD * 2, Math.max(40, v.size * factor)) }));

  return (
    <section className="min-w-0 space-y-3" aria-label="World map">
      <fieldset disabled={readOnly || disabled || busy} className="min-w-0 space-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {drawing
            ? <>
                <span className="text-sm text-port-text">Tap the map to add points ({formatCount(drawing.length)})</span>
                <button type="button" className={buttonCls} onClick={finishPath}><Check size={14} aria-hidden="true" /> {drawing.length >= 2 ? 'Finish path' : 'Cancel'}</button>
              </>
            : <button type="button" className={buttonCls} disabled={world.paths.length >= WORLD_LIMITS.PATHS} onClick={() => { select(''); setDrawing([]); }}><Route size={14} aria-hidden="true" /> Draw a path</button>}
          <span className="ml-auto inline-flex gap-1">
            <button type="button" className={iconCls} aria-label="Zoom in" onClick={() => zoom(0.7)}><Plus size={16} aria-hidden="true" /></button>
            <button type="button" className={iconCls} aria-label="Zoom out" onClick={() => zoom(1 / 0.7)}><Minus size={16} aria-hidden="true" /></button>
            <button type="button" className={buttonCls} onClick={fit}>Fit</button>
          </span>
        </div>
      </fieldset>
      <WorldMap world={world} places={places} selected={selected} drawing={drawing} view={view} onView={setView} onSelect={readOnly ? () => {} : select}
        onMoveSet={(id, position) => !readOnly && patchSet(id, { position })}
        onMovePoint={(id, index, point) => !readOnly && edit((t) => ({ ...t, paths: t.paths.map((entry) => (entry.id === id ? { ...entry, points: entry.points.map((p, i) => (i === index ? point : p)) } : entry)) }))}
        onAddPoint={onAddPoint} />
      {world.sets.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Sets on the map">
          {world.sets.map((entry) => {
            const name = places[entry.ingredientId]?.ingredient?.name || (places[entry.ingredientId] === null ? 'Missing environment' : '…');
            const on = selected === `set:${entry.id}`;
            return (
              <li key={entry.id} className="min-w-0">
                <button type="button" aria-pressed={on} className={`${buttonCls} max-w-full ${on ? 'border-port-accent text-white' : ''}`} title="Show this set on the map"
                  onClick={() => { select(`set:${entry.id}`); setView(worldSetView(entry, places[entry.ingredientId])); }}>
                  <span className="truncate">{name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {problems.length > 0 && <p role="status" className="text-xs text-port-warning">{problems.map((entry) => entry.problem).join(' · ')}</p>}
      <fieldset disabled={readOnly || disabled || busy} className="min-w-0 space-y-3">
        {set && (
          <div className="min-w-0 space-y-2 rounded-lg border border-port-border p-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-port-text">{places[set.ingredientId]?.ingredient?.name || 'Set'}</span>
              {places[set.ingredientId]?.ingredient && <Link className="text-xs underline" to={`${ingredientPath(places[set.ingredientId].ingredient)}/greybox`}>Open its greybox</Link>}
              <button type="button" className={`${iconCls} ml-auto`} aria-label="Turn left 15°" onClick={() => patchSet(set.id, { rotationDegrees: ((set.rotationDegrees + 15 + 360) % 360) })}><RotateCcw size={16} aria-hidden="true" /></button>
              <label htmlFor="world-set-turn" className="sr-only">Turn (degrees)</label>
              <input id="world-set-turn" type="number" min={0} max={359} value={Math.round(set.rotationDegrees)} className="min-h-[44px] w-20 rounded border border-port-border bg-port-bg px-2 text-sm"
                onChange={(event) => patchSet(set.id, { rotationDegrees: ((Number(event.target.value) || 0) % 360 + 360) % 360 })} />
              <button type="button" className={iconCls} aria-label="Turn right 15°" onClick={() => patchSet(set.id, { rotationDegrees: ((set.rotationDegrees - 15 + 360) % 360) })}><RotateCw size={16} aria-hidden="true" /></button>
              <button type="button" className={iconCls} aria-label="Remove this set from the world" onClick={() => { edit((t) => ({ ...t, sets: t.sets.filter((entry) => entry.id !== set.id) })); select(''); }}><Trash2 size={16} aria-hidden="true" /></button>
            </div>
          </div>
        )}
        {path && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-port-border p-2 text-sm">
            <label htmlFor="world-street-kind" className="text-port-text-muted">Path</label>
            <select id="world-street-kind" className={selectCls} value={path.kind}
              onChange={(event) => patchPath(path.id, { kind: event.target.value, width: WORLD_PATH_DEFAULT_WIDTH[event.target.value] })}>
              {WORLD_PATH_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
            </select>
            <label htmlFor="world-street-sides" className="text-port-text-muted">Lined with</label>
            <select id="world-street-sides" className={selectCls} value={path.sides} onChange={(event) => patchPath(path.id, { sides: event.target.value })}>
              {WORLD_PATH_SIDES.map((sides) => <option key={sides} value={sides}>{SIDE_LABELS[sides]}</option>)}
            </select>
            {path.kind === 'road' && (
              <>
                <label htmlFor="world-street-infra" className="text-port-text-muted">Infrastructure</label>
                <select id="world-street-infra" className={selectCls} value={path.infrastructure || 'overhead'} onChange={(event) => patchPath(path.id, { infrastructure: event.target.value })}>
                  {WORLD_ROAD_INFRASTRUCTURE.map((value) => <option key={value} value={value}>{INFRA_LABELS[value]}</option>)}
                </select>
                {['overhead', 'buried', 'rural'].includes(path.infrastructure || 'overhead') && (
                  <>
                    <label htmlFor="world-street-pole-side" className="text-port-text-muted">Pole side</label>
                    <select id="world-street-pole-side" className={selectCls} value={path.poleSide || 'right'} onChange={(event) => patchPath(path.id, { poleSide: event.target.value })}>
                      {WORLD_POLE_SIDES.map((value) => <option key={value} value={value}>{value === 'right' ? 'Right' : 'Left'}</option>)}
                    </select>
                    <label htmlFor="world-street-pole-spacing" className="text-port-text-muted">Spacing (m)</label>
                    <input id="world-street-pole-spacing" type="number" min={WORLD_POLE_SPACING.min} max={WORLD_POLE_SPACING.max} step={1} placeholder="auto" value={path.poleSpacing ?? ''} className="min-h-[44px] w-20 rounded border border-port-border bg-port-bg px-2"
                      onChange={(event) => patchPath(path.id, { poleSpacing: event.target.value === '' ? undefined : Math.min(WORLD_POLE_SPACING.max, Math.max(WORLD_POLE_SPACING.min, Number(event.target.value) || WORLD_POLE_SPACING.min)) })} />
                  </>
                )}
              </>
            )}
            <label htmlFor="world-street-width" className="text-port-text-muted">Width (m)</label>
            <input id="world-street-width" type="number" min={1} max={WORLD_LIMITS.WIDTH_MAX} step={0.5} value={path.width} className="min-h-[44px] w-20 rounded border border-port-border bg-port-bg px-2"
              onChange={(event) => patchPath(path.id, { width: Math.min(WORLD_LIMITS.WIDTH_MAX, Math.max(1, Number(event.target.value) || 1)) })} />
            <button type="button" className={`${iconCls} ml-auto`} aria-label="Remove this path" onClick={() => { edit((t) => ({ ...t, paths: t.paths.filter((entry) => entry.id !== path.id) })); select(''); }}><Trash2 size={16} aria-hidden="true" /></button>
          </div>
        )}
        <span className="inline-flex min-w-0 items-center gap-2 text-sm">
          <label htmlFor="world-setting" className="text-port-text-muted">Setting</label>
          <select id="world-setting" className={selectCls} value={world.setting || 'outdoor'} onChange={(event) => edit((t) => ({ ...t, setting: event.target.value }))}>
            {WORLD_SETTINGS.map((setting) => <option key={setting} value={setting}>{SETTING_LABELS[setting]}</option>)}
          </select>
        </span>
        {!readOnly && world.sets.length < WORLD_LIMITS.SETS && <AddSet exclude={placed} onAdd={addSet} />}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" className={buttonCls} aria-pressed={show3d} onClick={() => setShow3d((on) => !on)}>{show3d ? 'Hide 3D view' : 'Show 3D view'}</button>
          {show3d && (world.setting || 'outdoor') === 'outdoor' && (
            <span className="inline-flex min-w-0 flex-1 items-center gap-2">
              <label htmlFor="world-clock" className="text-xs text-port-text-muted">Time</label>
              <input id="world-clock" type="range" min={0} max={1439} step={5} value={clock} onChange={(event) => setClock(Number(event.target.value))} className="min-w-0 flex-1" />
              <span className="tabular-nums text-xs text-port-text">{worldClockText(clock)}</span>
            </span>
          )}
        </div>
      </fieldset>
      {show3d && <Suspense fallback={<p className="text-sm text-port-text-muted"><Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" />Loading the 3D view…</p>}><WorldViewer world={world} places={places} clockMinutes={clock} /></Suspense>}
      {!readOnly && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-xs text-port-text-muted">{formatCount(world.sets.length)} set{world.sets.length === 1 ? '' : 's'} · {formatCount(world.paths.length)} path{world.paths.length === 1 ? '' : 's'}</span>
          {draft && <button type="button" className={buttonCls} disabled={busy || disabled} onClick={() => { setDraft(null); setDrawing(null); }}><X size={14} aria-hidden="true" /> Discard changes</button>}
          {draft && <button type="button" className={`${buttonCls} border-port-accent text-port-accent`} disabled={busy || disabled } onClick={() => persist(draft)}>{busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />} Save world</button>}
          {!draft && saved && (confirmRemove
            ? <ConfirmButtonPair className="ml-auto" prompt="Remove the world map?" confirmText="Remove" largeTouchTargets busy={busy} onConfirm={() => { setConfirmRemove(false); persist(null); }} onCancel={() => setConfirmRemove(false)} />
            : <button type="button" className={`${buttonCls} ml-auto`} disabled={busy || disabled} onClick={() => setConfirmRemove(true)}><Trash2 size={14} aria-hidden="true" /> Remove world map</button>)}
        </div>
      )}
    </section>
  );
}
