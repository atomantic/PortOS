import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowDown, ArrowUp, Navigation, Plus, Trash2 } from 'lucide-react';
import StageSection from './StageSection.jsx';
import { uuidv4 } from '../../lib/uuid.js';
import { ingredientPath } from '../../lib/creativeLibraries.js';
import { formatCount } from '../../utils/formatters.js';
import useMusicVideoGreyboxPlaces from '../../hooks/useMusicVideoGreyboxPlaces.js';
import {
  ROUTE_MAP_FEATURE_LABEL_MAX, ROUTE_MAP_FEATURES_MAX, ROUTE_MAP_HEADINGS, ROUTE_MAP_MAX, ROUTE_MAP_NAME_MAX, ROUTE_MAP_NOTE_MAX, ROUTE_MAP_STOPS_MAX, ROUTE_MAP_TRAVEL_MAX,
} from '../../../../server/lib/musicVideoRouteMapLimits.js';
import {
  draftRouteMapStops, projectRouteMaps, routeMapProblems, routeMapStopShots, shotRangesText,
} from '../../../../server/lib/musicVideoRouteMaps.js';

export const ROUTE_MAPS_ANCHOR = 'mv-route-maps';
const inputCls = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';
const buttonCls = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-1 text-xs disabled:opacity-50 sm:min-h-0';
const iconButtonCls = 'flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-port-text-muted disabled:opacity-40 sm:min-h-8 sm:min-w-8';
const HEADING_DEGREES = Object.fromEntries(ROUTE_MAP_HEADINGS.map((heading, at) => [heading, at * 45]));
const newStopId = () => `rstop-${uuidv4().slice(0, 8)}`;
const FEATURE_KIND_LABELS = { 'side-street': 'Side street', landmark: 'Landmark' };
const SIDE_LABELS = { left: '← Left', right: 'Right →', ahead: '↑ Ahead' };

/** A text box that commits on blur, only when its text changed. */
function CommitInput({ label, value = '', placeholder, maxLength, onCommit }) {
  return (
    <input key={value} aria-label={label} defaultValue={value} placeholder={placeholder} maxLength={maxLength} className={inputCls}
      onBlur={(event) => { const next = event.target.value.trim(); if (next !== value) onCommit(next); }} />
  );
}

/**
 * A stretch's side streets and landmarks, each on the travellers' left, right
 * or ahead. Drawn beside the stop: left ones lead the line, right ones end it.
 */
function StopFeatures({ stop, at, onChange }) {
  const features = stop.features || [];
  const edit = (id, change) => onChange(features.map((feature) => (feature.id === id ? { ...feature, ...change } : feature)));
  const name = (feature) => feature.label || FEATURE_KIND_LABELS[feature.kind];
  const left = features.filter((feature) => feature.side === 'left');
  const right = features.filter((feature) => feature.side === 'right');
  const ahead = features.filter((feature) => feature.side === 'ahead');
  return (
    <div className="min-w-0 space-y-1">
      {features.length > 0 && (
        <p data-testid={`stop-${at + 1}-sides`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 text-xs">
          <span className="truncate text-right">{left.map((feature) => `← ${name(feature)}`).join(' · ')}</span>
          <span aria-hidden="true" className="text-port-accent">┃</span>
          <span className="truncate">{right.map((feature) => `${name(feature)} →`).join(' · ')}{ahead.length ? `${right.length ? ' · ' : ''}${ahead.map((feature) => `↑ ${name(feature)}`).join(' · ')}` : ''}</span>
        </p>
      )}
      {features.map((feature) => (
        <div key={feature.id} className="grid min-w-0 grid-cols-2 gap-1.5 sm:grid-cols-[6rem_7rem_minmax(0,1fr)_auto]">
          <select aria-label={`${name(feature)} side`} value={feature.side} className={inputCls} onChange={(event) => edit(feature.id, { side: event.target.value })}>
            {Object.entries(SIDE_LABELS).map(([side, label]) => <option key={side} value={side}>{label}</option>)}
          </select>
          <select aria-label={`${name(feature)} kind`} value={feature.kind} className={inputCls} onChange={(event) => edit(feature.id, { kind: event.target.value })}>
            {Object.entries(FEATURE_KIND_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
          <CommitInput label={`${name(feature)} name`} value={feature.label || ''} maxLength={ROUTE_MAP_FEATURE_LABEL_MAX}
            placeholder={feature.kind === 'side-street' ? 'Street name' : 'e.g. derelict house'} onCommit={(label) => edit(feature.id, { label })} />
          <button type="button" aria-label={`Remove ${name(feature)}`} onClick={() => onChange(features.filter((entry) => entry.id !== feature.id))} className={iconButtonCls}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      {features.length < ROUTE_MAP_FEATURES_MAX && (
        <span className="flex flex-wrap gap-1">
          <button type="button" className={buttonCls} onClick={() => onChange([...features, { id: `rfeat-${uuidv4().slice(0, 8)}`, kind: 'side-street', side: 'left', label: '' }])}>
            <Plus size={12} aria-hidden="true" /> Side street
          </button>
          <button type="button" className={buttonCls} onClick={() => onChange([...features, { id: `rfeat-${uuidv4().slice(0, 8)}`, kind: 'landmark', side: 'right', label: '' }])}>
            <Plus size={12} aria-hidden="true" /> Landmark
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * Which of the place's greybox cameras look ahead along the route and back
 * the way they came. Forward and back views of one spot share that greybox's
 * layout, and a shot on either camera is told which way it looks.
 */
function StopViews({ stop, at, place, greyboxPlaces, onChange }) {
  if (!place?.ingredientId) return null;
  const entry = greyboxPlaces[place.ingredientId];
  const cameras = entry?.ingredient?.payload?.greybox?.shots || [];
  const greyboxPath = `${ingredientPath({ id: place.ingredientId, type: 'place' })}/greybox`;
  if (entry === undefined) return <p className="text-xs text-port-text-muted">Loading this place's cameras…</p>;
  if (!cameras.length) {
    return <p className="text-xs text-port-text-muted">For views looking ahead and back from one spot, save two cameras in this place's <Link to={greyboxPath} className="text-port-accent hover:underline">Greybox</Link>.</p>;
  }
  const views = stop.views || {};
  const pick = (which, value) => onChange({ ...views, [which]: value || null });
  return (
    <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
      {[['forward', 'Looking ahead'], ['back', 'Looking back']].map(([which, label]) => (
        <span key={which} className="flex min-w-0 items-center gap-1 text-xs">
          <span aria-hidden="true" className="shrink-0 text-port-text-muted">{label}</span>
          <select aria-label={`Stop ${at + 1} ${label.toLowerCase()} camera`} value={views[which] || ''} className={inputCls} onChange={(event) => pick(which, event.target.value)}>
            <option value="">No camera</option>
            {views[which] && !cameras.some((camera) => camera.id === views[which]) && <option value={views[which]}>Missing camera</option>}
            {cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.label}</option>)}
          </select>
        </span>
      ))}
    </div>
  );
}

/**
 * One route, drawn as its path: a numbered stop per place in travel order,
 * each with the shots set there. The drawing is the editor, and the map is
 * never sent to a model as a picture; each shot gets a "Route" line instead.
 */
function RouteMap({ project, map, places, greyboxPlaces, problems, onChange, onRemove }) {
  const shots = useMemo(() => routeMapStopShots(project, map), [project, map]);
  const stops = map.stops || [];
  const patch = (change) => onChange({ ...map, ...change });
  const setStops = (next) => patch({ stops: next });
  const editStop = (id, change) => setStops(stops.map((stop) => (stop.id === id ? { ...stop, ...change } : stop)));
  const move = (at, by) => {
    const next = [...stops];
    [next[at], next[at + by]] = [next[at + by], next[at]];
    setStops(next);
  };
  const unused = places.filter((place) => !stops.some((stop) => stop.subjectId === place.id));
  const heading = map.heading || '';
  return (
    <div className="min-w-0 space-y-2 rounded border border-port-border p-2" aria-label={`Route ${map.name}`} role="group">
      <div className="grid min-w-0 gap-1.5 sm:grid-cols-[minmax(0,14rem)_9rem_minmax(0,1fr)_2.75rem]">
        <CommitInput label="Route name" value={map.name} maxLength={ROUTE_MAP_NAME_MAX}
          onCommit={(name) => { if (name) patch({ name }); }} />
        <span className="flex min-w-0 items-center gap-1">
          <Navigation size={14} aria-hidden="true" className={`shrink-0 ${heading ? 'text-port-accent' : 'text-port-text-muted'}`}
            style={{ transform: `rotate(${(HEADING_DEGREES[heading] ?? 0) - 45}deg)` }} />
          <select aria-label={`${map.name} direction of travel`} value={heading} className={inputCls}
            onChange={(event) => patch({ heading: event.target.value || null })}>
            <option value="">Any direction</option>
            {ROUTE_MAP_HEADINGS.map((entry) => <option key={entry} value={entry}>Heading {entry}</option>)}
          </select>
        </span>
        <CommitInput label={`${map.name} travel`} value={map.travel || ''} maxLength={ROUTE_MAP_TRAVEL_MAX}
          placeholder="How they travel, e.g. riding bikes, low sun ahead and to the left" onCommit={(travel) => patch({ travel })} />
        <button type="button" aria-label={`Remove route ${map.name}`} onClick={onRemove} className={iconButtonCls}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      {stops.length === 0 && <p className="text-xs text-port-text-muted">No stops yet. Add the places in the order they travel through them.</p>}
      <ol className="min-w-0">
        {stops.map((stop, at) => {
          const place = places.find((entry) => entry.id === stop.subjectId);
          const problem = problems.find((entry) => entry.stopId === stop.id)?.problem;
          const numbers = shots[stop.id] || [];
          const last = at === stops.length - 1;
          return (
            <li key={stop.id} className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
              <span aria-hidden="true" className="flex flex-col items-center">
                <span className={`mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${place ? 'bg-port-accent text-white' : 'bg-port-border text-port-text-muted'}`}>{at + 1}</span>
                {!last && <span className="w-0.5 flex-1 bg-port-accent/50" />}
              </span>
              <div className="min-w-0 space-y-1 pb-3">
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1.5">
                  <select aria-label={`Stop ${at + 1} place`} value={place ? stop.subjectId : ''} className={inputCls}
                    onChange={(event) => { if (event.target.value) editStop(stop.id, { subjectId: event.target.value }); }}>
                    {!place && <option value="">Pick a place</option>}
                    {places.filter((entry) => entry.id === stop.subjectId || !stops.some((other) => other.subjectId === entry.id))
                      .map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                  </select>
                  <span className="flex gap-1">
                    <button type="button" aria-label={`Move stop ${at + 1} earlier`} disabled={at === 0} onClick={() => move(at, -1)} className={iconButtonCls}><ArrowUp size={14} aria-hidden="true" /></button>
                    <button type="button" aria-label={`Move stop ${at + 1} later`} disabled={last} onClick={() => move(at, 1)} className={iconButtonCls}><ArrowDown size={14} aria-hidden="true" /></button>
                    <button type="button" aria-label={`Remove stop ${at + 1}`} onClick={() => setStops(stops.filter((entry) => entry.id !== stop.id))} className={iconButtonCls}><Trash2 size={14} aria-hidden="true" /></button>
                  </span>
                </div>
                <p className="text-xs text-port-text-muted">
                  {numbers.length ? `Shot${numbers.length === 1 ? '' : 's'} ${shotRangesText(numbers)}` : 'No shots set here yet'}
                  {place?.ingredientId && <>{' · '}<Link to={ingredientPath({ id: place.ingredientId, type: 'place' })} className="text-port-accent hover:underline">Environment</Link></>}
                </p>
                {problem === 'missing-place' && <p className="text-xs text-port-warning">This place is no longer in the video. Pick another or remove the stop.</p>}
                {problem === 'repeated-place' && <p className="text-xs text-port-warning">This place is already an earlier stop, so its shots count there.</p>}
                <CommitInput label={`Stop ${at + 1} note`} value={stop.note || ''} maxLength={ROUTE_MAP_NOTE_MAX}
                  placeholder="What this stretch looks like, e.g. brick houses, big trees" onCommit={(note) => editStop(stop.id, { note })} />
                <StopFeatures stop={stop} at={at} onChange={(features) => editStop(stop.id, { features })} />
                <StopViews stop={stop} at={at} place={place} greyboxPlaces={greyboxPlaces} onChange={(views) => editStop(stop.id, { views })} />
              </div>
            </li>
          );
        })}
      </ol>
      {stops.length < ROUTE_MAP_STOPS_MAX && unused.length > 0 && (
        <button type="button" className={buttonCls} onClick={() => setStops([...stops, { id: newStopId(), subjectId: unused[0].id, note: '' }])}>
          <Plus size={12} aria-hidden="true" /> Add stop
        </button>
      )}
    </div>
  );
}

/**
 * Route maps on Shots: the paths that join the video's places (a ride down
 * several streets, a walk from the car park into the rink). A new route can
 * be read off the shots, in the order they visit each place. Every shot set
 * on a stop gets a "Route" addition in its frame and clip prompts, so shots on
 * different stretches keep one direction of travel.
 */
export default function RouteMapsPanel({ board }) {
  const { project, locked, editProjectLocal, saveProjectFields } = board;
  const maps = projectRouteMaps(project);
  const places = (project.concept?.subjects || []).filter((subject) => subject.kind === 'place');
  const problems = useMemo(() => routeMapProblems(project), [project]);
  const greyboxPlaces = useMusicVideoGreyboxPlaces(project);
  const shotCount = (project.scenes || []).length;
  const [fromShot, setFromShot] = useState('1');
  const [toShot, setToShot] = useState('');
  const save = (routeMaps) => { editProjectLocal({ routeMaps }); saveProjectFields({ routeMaps }); };
  const from = Math.max(1, Number.parseInt(fromShot, 10) || 1);
  const to = Number.parseInt(toShot, 10) || Infinity;
  const drafted = useMemo(() => draftRouteMapStops(project, { fromShot: from, toShot: to, newId: newStopId }), [project, from, to]);
  const add = (stops) => save([...maps, { id: `route-${uuidv4().slice(0, 8)}`, name: `Route ${maps.length + 1}`, heading: null, travel: '', stops }]);
  const stopTotal = maps.reduce((sum, map) => sum + (map.stops || []).length, 0);
  const summary = maps.length
    ? `${formatCount(maps.length)} route${maps.length === 1 ? '' : 's'} · ${formatCount(stopTotal)} stop${stopTotal === 1 ? '' : 's'}${problems.length ? ` · ${formatCount(problems.length)} to fix` : ''}`
    : 'Join places along a path so shots keep one direction of travel';
  return (
    <StageSection id={ROUTE_MAPS_ANCHOR} title="Route maps" summary={summary}>
      <fieldset disabled={locked} aria-label="Route maps editor" className="min-w-0 space-y-2">
        {places.length < 2 && <p className="text-xs text-port-text-muted">A route needs at least two places in the video. Add environments on the Story step.</p>}
        {maps.map((map) => (
          <RouteMap key={map.id} project={project} map={map} places={places} greyboxPlaces={greyboxPlaces} problems={problems.filter((entry) => entry.mapId === map.id)}
            onChange={(next) => save(maps.map((entry) => (entry.id === map.id ? next : entry)))}
            onRemove={() => save(maps.filter((entry) => entry.id !== map.id))} />
        ))}
        {maps.length < ROUTE_MAP_MAX && places.length >= 2 && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <span className="text-port-text-muted">New route from shots</span>
            <label htmlFor="mv-route-from" className="sr-only">From shot</label>
            <input id="mv-route-from" type="number" min={1} max={shotCount || 1} value={fromShot} onChange={(event) => setFromShot(event.target.value)} className={`${inputCls} w-16`} />
            <span aria-hidden="true">to</span>
            <label htmlFor="mv-route-to" className="sr-only">To shot</label>
            <input id="mv-route-to" type="number" min={1} max={shotCount || 1} value={toShot} placeholder={String(shotCount || '')} onChange={(event) => setToShot(event.target.value)} className={`${inputCls} w-16`} />
            <button type="button" className={buttonCls} disabled={drafted.length < 2} onClick={() => add(drafted)}>
              <Plus size={12} aria-hidden="true" /> {drafted.length >= 2 ? `Draft route with ${formatCount(drafted.length)} places` : 'These shots visit fewer than two places'}
            </button>
            <button type="button" className={buttonCls} onClick={() => add([])}>
              <Plus size={12} aria-hidden="true" /> Empty route
            </button>
          </div>
        )}
      </fieldset>
    </StageSection>
  );
}
