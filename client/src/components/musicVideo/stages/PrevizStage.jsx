import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Box, Loader2, Map as MapIcon, Play, RefreshCw, X } from 'lucide-react';
import StageSection from '../StageSection.jsx';
import toast from '../../ui/Toast';
import useMusicVideoGreyboxPlaces from '../../../hooks/useMusicVideoGreyboxPlaces.js';
import usePrevizWorld from '../../../hooks/usePrevizWorld.js';
import PrevizNight from './PrevizNight.jsx';
import WorldMap, { fitWorldView } from '../../catalog/WorldMapView';
import { nightActorsAt, nightClockAt, nightMinuteOfClock, previzNight } from '../../../../../server/lib/musicVideoPrevizNight.js';
import { ingredientPath } from '../../../lib/creativeLibraries.js';
import { createCatalogIngredient, saveCatalogWorld } from '../../../services/apiCatalog.js';
import { draftWorldFromRouteMaps, worldClockText } from '../../../../../server/lib/worldMap.js';
import { sceneShotName } from '../../../lib/musicVideoStages.js';
import { formatCount, formatDateTime, formatTimecode } from '../../../utils/formatters.js';
import { shotNumbers } from '../ShotStepper.jsx';
import {
  backfillPrevizFromShots, previzCutProblems, previzPawnColors, updatePrevizCut, previzCutTiming, previzCutVisibleIds, previzPlaceGreybox, previzSetsWithoutGreybox, projectPreviz,
} from '../../../../../server/lib/musicVideoPreviz.js';
import { PREVIZ_CAMERA_STYLES, PREVIZ_PAWN_COLORS } from '../../../../../server/lib/musicVideoPrevizLimits.js';

export const PREVIZ_ANCHOR = 'mv-previz';
const selectCls = 'min-h-[44px] min-w-0 max-w-full rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-port-text sm:min-h-0';
const buttonCls = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-1 text-xs disabled:opacity-50 sm:min-h-0';
const chipCls = (on) => `inline-flex min-h-[44px] items-center gap-1 rounded-full border px-2 text-xs sm:min-h-7 ${on ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`;

function Picker({ id, label, value, options, empty, onChange }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <label htmlFor={id} className="shrink-0 text-port-text-muted">{label}</label>
      <select id={id} value={value || ''} onChange={(event) => onChange(event.target.value || null)} className={selectCls}>
        <option value="">{empty}</option>
        {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    </span>
  );
}

/** Each character's pawn color, and their bike's, so who is who reads at a glance in the previz. */
function PawnColors({ project, characters, onChange }) {
  const colors = previzPawnColors(project);
  const picked = project.previz?.pawnColors || {};
  const pick = (subjectId, part, id) => onChange({ ...picked, [subjectId]: { ...picked[subjectId], [part]: id } });
  return (
    <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Pawn colors">
      {characters.map((subject) => (
        <li key={subject.id} className="inline-flex min-w-0 flex-wrap items-center gap-1">
          <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-full border border-port-border" style={{ background: colors[subject.id].figure.hex }} />
          <span className="font-medium text-port-text">{subject.name}</span>
          {['figure', 'bike'].map((part) => (
            <span key={part} className="inline-flex items-center gap-1">
              <label htmlFor={`mv-previz-color-${subject.id}-${part}`} className="text-port-text-muted">{part === 'figure' ? 'Figure' : 'Bike'}</label>
              <select id={`mv-previz-color-${subject.id}-${part}`} value={colors[subject.id][part].id} onChange={(event) => pick(subject.id, part, event.target.value)} className={selectCls}>
                {PREVIZ_PAWN_COLORS.map((color) => <option key={color.id} value={color.id}>{color.label}</option>)}
              </select>
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

const CAMERA_STYLE_LABELS = { steady: 'Steady', handheld: 'Handheld shake', still: 'Still (snapshot)', documentary: 'Documentary drift' };

const plural = (count, word) => `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`;

/** The sets cuts play on that have no greybox, so those cuts play an empty set; each links to its Greybox panel. */
function SetsWithoutGreybox({ sets }) {
  if (!sets.length) return null;
  return (
    <section role="status" aria-label="Sets without a greybox" className="min-w-0 space-y-1 rounded border border-port-warning/50 p-2 text-xs">
      <h3 className="flex items-center gap-1 font-medium text-port-warning"><AlertTriangle size={12} aria-hidden="true" /> Sets without a greybox</h3>
      <p className="text-port-text-muted">These cuts play an empty set until the set has a greybox. Its Greybox panel can draft one.</p>
      <ul className="flex min-w-0 flex-wrap gap-2">
        {sets.map(({ subject, cuts }) => (
          <li key={subject.id} className="inline-flex min-w-0 flex-wrap items-center gap-1">
            {subject.ingredientId
              ? <Link className={buttonCls} to={`${ingredientPath({ id: subject.ingredientId, type: 'place' })}/greybox`}>{subject.name}</Link>
              : <span className="font-medium text-port-text">{subject.name} (not in the catalog)</span>}
            <span className="text-port-text-muted">{plural(cuts, 'cut')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const worldIdMaker = () => {
  const stamp = Date.now().toString(36);
  let n = 0;
  return () => `t${stamp}${(n += 1).toString(36)}`;
};

/**
 * The world the previz plays in: a catalog environment with a world map. "Draft
 * world from route maps" makes a new environment from the video's route maps
 * (sets on their routes, paths between them) and picks it; it is edited on
 * that environment's World tab.
 */
/** The linked world environment (`entry`: undefined while loading, null when removed), or a button to draft one. */
function PrevizWorld({ project, worldId, entry, onPick }) {
  const [busy, setBusy] = useState(false);
  const routes = (project.routeMaps || []).filter((map) => (map.stops || []).length);
  const draft = async () => {
    setBusy(true);
    const { world: map, skipped } = draftWorldFromRouteMaps(project, { newId: worldIdMaker(), seed: Math.floor(Math.random() * 1e6) });
    const created = await createCatalogIngredient({ type: 'place', name: `${project.title || 'Music video'} world`.slice(0, 120), payload: { description: 'World map for the previz: the video\'s sets placed on one map, joined by paths.' } }).catch(() => null);
    const saved = created ? await saveCatalogWorld(created.id, map).catch(() => null) : null;
    setBusy(false);
    if (!saved) return;
    onPick(saved.id);
    toast.success(`World drafted with ${formatCount(map.sets.length)} set${map.sets.length === 1 ? '' : 's'}${skipped.length ? `; not in the catalog yet: ${skipped.join(', ')}` : ''}`);
  };
  if (worldId) {
    const world = entry?.ingredient;
    const path = world ? `${ingredientPath({ id: worldId, type: 'place' })}/world` : null;
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <MapIcon size={14} aria-hidden="true" className="text-port-text-muted" />
        <span className="text-port-text">{entry === undefined ? 'Loading the world…' : world ? world.name : 'The world environment was removed'}</span>
        {path && <Link className={buttonCls} to={path}>Open world map</Link>}
        <button type="button" className={buttonCls} onClick={() => onPick(null)}><X size={12} aria-hidden="true" /> Unlink world</button>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <button type="button" className={buttonCls} disabled={busy || !routes.length} onClick={draft}><MapIcon size={12} aria-hidden="true" /> Draft world from route maps</button>
      <span className="text-port-text-muted">{routes.length
        ? 'Places the sets on one map, joined by paths, as a new environment you can edit.'
        : 'Add a route map on the Shots step first.'}</span>
    </div>
  );
}

/** How each of the video's cameras moves in the previz while it shoots a cut. */
function CameraStyles({ cameras, onChange }) {
  return (
    <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Camera styles">
      {cameras.map((camera) => (
        <li key={camera.id} className="inline-flex min-w-0 items-center gap-1">
          <label htmlFor={`mv-previz-style-${camera.id}`} className="font-medium text-port-text">{camera.name}</label>
          <select id={`mv-previz-style-${camera.id}`} value={camera.previzStyle || 'steady'} className={selectCls}
            onChange={(event) => onChange(camera.id, event.target.value)}>
            {PREVIZ_CAMERA_STYLES.map((style) => <option key={style} value={style}>{CAMERA_STYLE_LABELS[style]}</option>)}
          </select>
        </li>
      ))}
    </ul>
  );
}

/** A cut's moment on the previz night, and where an unheld camera stands for it (tap the map). */
function CutOnNight({ project, cut, world, worldPlaces, onChange }) {
  const night = previzNight(project);
  const [picking, setPicking] = useState(false);
  const [view, setView] = useState(() => fitWorldView(world));
  const id = `mv-previz-${cut.id}-story`;
  const on = Number.isFinite(cut.storyMin);
  const spotActors = () => {
    const actors = nightActorsAt(project, world, worldPlaces, cut.storyMin).map((actor) => ({ ...actor, color: '#d9dde3' }));
    return cut.cameraSpot ? [...actors, { subjectId: 'camera-spot', name: 'Camera', position: [cut.cameraSpot[0], 0, cut.cameraSpot[1]], color: '#ffdd55' }] : actors;
  };
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="flex items-center gap-1" htmlFor={id}>
          <span className="text-port-text-muted">On the night at</span>
          <input id={id} type="time" className={selectCls} value={on ? worldClockText(nightClockAt(night, cut.storyMin)) : ''}
            onChange={(event) => {
              const [h, m] = event.target.value.split(':').map(Number);
              if (!Number.isFinite(h) || !Number.isFinite(m)) return;
              // A time outside the night wraps past its end, where everyone has stopped.
              const storyMin = nightMinuteOfClock(night, h * 60 + m);
              if (storyMin <= night.lengthMin) onChange({ storyMin });
            }} />
        </label>
        {on
          ? <button type="button" className={buttonCls} onClick={() => onChange({ storyMin: null })}>Off the night</button>
          : <span className="text-port-text-muted">Not on the night: plays its set's own blocking</span>}
        {on && !cut.holderSubjectId && (
          <>
            <button type="button" className={buttonCls} aria-pressed={picking} onClick={() => setPicking(!picking)}><MapIcon size={12} aria-hidden="true" /> {cut.cameraSpot ? 'Move camera spot' : 'Pick camera spot'}</button>
            {cut.cameraSpot && <button type="button" className={buttonCls} onClick={() => onChange({ cameraSpot: null })}>Auto spot</button>}
          </>
        )}
      </div>
      {picking && on && !cut.holderSubjectId && (
        <div className="max-w-sm space-y-1">
          <p className="text-port-text-muted">Tap where the observer stands.</p>
          <WorldMap world={world} places={worldPlaces} view={view} onView={setView} drawing={[]} actors={spotActors()}
            onAddPoint={(point) => onChange({ cameraSpot: point })} />
        </div>
      )}
    </div>
  );
}

/** One cut's row: the shot it plays, and its set, camera, holder, cast and aim pickers. */
function CutRow({ project, cut, number, scene, places, characters, placeSubjects, world, worldPlaces, onChange, onWatch }) {
  const timing = previzCutTiming(project, cut);
  const problems = previzCutProblems(project, cut, places);
  const greybox = cut.placeSubjectId ? previzPlaceGreybox(project, cut.placeSubjectId, places) : null;
  const cameras = (greybox?.shots || []).map((shot) => ({ id: shot.id, name: shot.label }));
  const visible = new Set(previzCutVisibleIds(project, cut));
  const others = characters.filter((subject) => subject.id !== cut.holderSubjectId);
  const toggle = (id) => {
    const next = visible.has(id) ? [...visible].filter((entry) => entry !== id) : [...visible, id];
    onChange({ visibleSubjectIds: next });
  };
  const id = `mv-previz-${cut.id}`;
  const place = placeSubjects.find((subject) => subject.id === cut.placeSubjectId);
  return (
    <li className="min-w-0 space-y-1.5 rounded border border-port-border p-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-medium text-port-text">{scene ? sceneShotName(scene, { number }) : 'Previz cut'}</span>
        {timing && <span className="tabular-nums text-port-text-muted">{formatTimecode(timing.startSec)}–{formatTimecode(timing.endSec)}</span>}
        {timing && <button type="button" className={`${buttonCls} ml-auto`} onClick={() => onWatch(timing.startSec)}><Play size={12} aria-hidden="true" /> Watch</button>}
      </div>
      {problems.length > 0 && <p role="status" className="text-port-warning">{problems.join(' · ')}{place?.ingredientId && problems.some((text) => /greybox/.test(text)) && <> · <Link className="underline" to={ingredientPath({ id: place.ingredientId, type: 'place' })}>Open {place.name}</Link></>}</p>}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <Picker id={`${id}-set`} label="Set" value={cut.placeSubjectId} options={placeSubjects} empty="No set"
          onChange={(placeSubjectId) => onChange({ placeSubjectId, viewShotId: null })} />
        <Picker id={`${id}-camera`} label="Camera" value={cut.viewShotId} options={cameras} empty="Default view"
          onChange={(viewShotId) => onChange({ viewShotId })} />
        <Picker id={`${id}-holder`} label="Held by" value={cut.holderSubjectId} options={characters} empty="Nobody (observer)"
          onChange={(holderSubjectId) => onChange({ holderSubjectId, ...(Array.isArray(cut.visibleSubjectIds) ? { visibleSubjectIds: cut.visibleSubjectIds.filter((entry) => entry !== holderSubjectId) } : {}) })} />
        <Picker id={`${id}-aim`} label="Keep in frame" value={cut.aimSubjectId} options={others} empty="Camera's own aim"
          onChange={(aimSubjectId) => onChange({ aimSubjectId })} />
      </div>
      {world && previzNight(project) && <CutOnNight project={project} cut={cut} world={world} worldPlaces={worldPlaces} onChange={onChange} />}
      {others.length > 0 && (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-1.5">
          <legend className="sr-only">In shot</legend>
          <span className="text-port-text-muted">In shot</span>
          {others.map((subject) => (
            <button key={subject.id} type="button" aria-pressed={visible.has(subject.id)} className={chipCls(visible.has(subject.id))} onClick={() => toggle(subject.id)}>
              {subject.name}
            </button>
          ))}
          {Array.isArray(cut.visibleSubjectIds)
            ? <button type="button" className={buttonCls} onClick={() => onChange({ visibleSubjectIds: null })}>Everyone on set</button>
            : <span className="text-port-text-muted">(everyone on set but the holder)</span>}
        </fieldset>
      )}
    </li>
  );
}

/**
 * The optional Previz step: block the video in a Three.js greybox of each set
 * and watch it with the song in the preview player before anything is rendered.
 * "Build previz from shots" gives every timed shot a linked cut (its set, saved
 * camera, camera holder and cast read off the shot and its sheet) and seeds
 * where each person stands; later syncs add new shots and drop removed ones,
 * keeping every pick and mark. Each cut's set, camera, holder, who is in shot
 * and who the camera keeps in frame are picked here.
 */
export default function PrevizStage({ board }) {
  const { project, locked, editProjectLocal, saveProjectFields, seekToScene } = board;
  const places = useMusicVideoGreyboxPlaces(project);
  const previz = projectPreviz(project);
  const { worldId, entry: worldEntry, world, places: worldPlaces } = usePrevizWorld(project);
  const subjects = project.concept?.subjects || [];
  const characters = subjects.filter((subject) => subject.kind === 'character');
  const placeSubjects = subjects.filter((subject) => subject.kind === 'place');
  const placesLoaded = placeSubjects.every((subject) => !subject.ingredientId || places[subject.ingredientId] !== undefined);
  const scenes = useMemo(() => project.scenes || [], [project.scenes]);
  const numbers = useMemo(() => shotNumbers(scenes), [scenes]);
  const timedShots = scenes.filter((scene) => Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec).length;
  // Applied locally at once; the page serializes the saves.
  const save = (next) => { editProjectLocal({ previz: next }); return saveProjectFields({ previz: next }); };
  // The label of the save in flight ('Building…' / 'Syncing…'), null when idle.
  const [building, setBuilding] = useState(null);
  // World and night can come before any cuts exist.
  const savePrevizField = (patch) => save({ ...(project.previz && Array.isArray(project.previz.cuts) ? project.previz : { cuts: [], tracks: [] }), ...patch });
  const build = () => {
    const { previz: built, added, removed } = backfillPrevizFromShots(project, places);
    setBuilding(previz ? 'Syncing…' : 'Building…');
    // saveProjectFields toasts its own failure and always settles.
    Promise.resolve(save({ ...built, builtAt: new Date().toISOString() })).finally(() => setBuilding(null));
    toast.success(added || removed
      ? `Previz: ${[added ? `${plural(added, 'cut')} added` : '', removed ? `${formatCount(removed)} removed` : ''].filter(Boolean).join(', ')}`
      : 'Previz already matches the shots');
  };
  const builtFrom = previz ? previz.cuts.filter((cut) => cut.sceneId).length : 0;
  const missingGreybox = placesLoaded ? previzSetsWithoutGreybox(project, places) : [];
  // Seeds marks for anyone the edited cut now needs on its set, so the change plays at once.
  const editCut = (cutId, patch) => save(updatePrevizCut(project, { ...previz.cuts.find((cut) => cut.id === cutId), ...patch }, places));
  const sorted = useMemo(() => (previz?.cuts || [])
    .map((cut) => ({ cut, timing: previzCutTiming(project, cut) }))
    .sort((a, b) => (a.timing?.startSec ?? Infinity) - (b.timing?.startSec ?? Infinity)), [previz, project]);
  const summary = previz ? `${formatCount(previz.cuts.length)} cut${previz.cuts.length === 1 ? '' : 's'} · ${formatCount(previz.tracks.length)} blocking track${previz.tracks.length === 1 ? '' : 's'}` : 'Block cameras and people in 3D before rendering';
  return (
    <div className="min-w-0 space-y-3">
      <StageSection id={PREVIZ_ANCHOR} title="Greybox previz" summary={summary} defaultOpen>
        <p className="text-xs text-port-text-muted">
          A Three.js greybox of each set, cut to each shot's camera and played with the song in the preview. Nothing is rendered, so it's free to change.
        </p>
        <fieldset disabled={locked} className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" className={buttonCls} disabled={!timedShots || !placesLoaded || Boolean(building)} aria-busy={Boolean(building)} onClick={build}>
            {building ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : previz ? <RefreshCw size={12} aria-hidden="true" /> : <Box size={12} aria-hidden="true" />}
            {building || (previz ? 'Sync with shots' : `Build previz from ${plural(timedShots, 'shot')}`)}
          </button>
          {!timedShots && <span className="text-xs text-port-text-muted">Time the shots on the Storyboard step first.</span>}
          {timedShots > 0 && !placesLoaded && <span className="inline-flex items-center gap-1 text-xs text-port-text-muted"><Loader2 size={12} aria-hidden="true" className="animate-spin" /> Loading the sets…</span>}
          {previz && !building && (
            <span role="status" className="text-xs text-port-text-muted">
              {[`Built from ${plural(builtFrom, 'shot')}`, plural(previz.cuts.length, 'cut'), previz.builtAt ? `updated ${formatDateTime(previz.builtAt)}` : null].filter(Boolean).join(' · ')}
            </span>
          )}
        </fieldset>
        <SetsWithoutGreybox sets={missingGreybox} />
        <fieldset disabled={locked} className="min-w-0 space-y-1">
          <legend className="text-xs text-port-text-muted">World</legend>
          <PrevizWorld project={project} worldId={worldId} entry={worldEntry} onPick={(next) => savePrevizField({ worldId: next })} />
        </fieldset>
        {world && (
          <section className="min-w-0 space-y-1" aria-label="Night">
            <h3 className="text-xs text-port-text-muted">Night</h3>
            <PrevizNight project={project} world={world} places={worldPlaces} locked={locked} onSave={savePrevizField} />
          </section>
        )}
        {previz && (project.cameras || []).length > 0 && (
          <fieldset disabled={locked} className="min-w-0 space-y-1">
            <legend className="text-xs text-port-text-muted">Camera styles (from each shot's sheet camera)</legend>
            <CameraStyles cameras={project.cameras} onChange={(cameraId, previzStyle) => {
              const cameras = project.cameras.map((camera) => (camera.id === cameraId ? { ...camera, previzStyle } : camera));
              editProjectLocal({ cameras });
              saveProjectFields({ cameras });
            }} />
          </fieldset>
        )}
        {previz && characters.length > 0 && (
          <fieldset disabled={locked} className="min-w-0 space-y-1">
            <legend className="text-xs text-port-text-muted">Pawn colors</legend>
            <PawnColors project={project} characters={characters} onChange={(pawnColors) => save({ ...previz, pawnColors })} />
          </fieldset>
        )}
        {previz && (
          <fieldset disabled={locked} className="min-w-0">
            <legend className="sr-only">Previz cuts</legend>
            <ol className="min-w-0 space-y-2">
              {sorted.map(({ cut }) => {
                const scene = cut.sceneId ? scenes.find((entry) => entry.sceneId === cut.sceneId) : null;
                return (
                  <CutRow key={cut.id} project={project} cut={cut} number={scene ? numbers.get(scene.sceneId) : null} scene={scene} places={places}
                    characters={characters} placeSubjects={placeSubjects} world={world} worldPlaces={worldPlaces} onChange={(patch) => editCut(cut.id, patch)}
                    onWatch={(startSec) => seekToScene?.({ startSec }, { play: true })} />
                );
              })}
            </ol>
          </fieldset>
        )}
      </StageSection>
    </div>
  );
}
