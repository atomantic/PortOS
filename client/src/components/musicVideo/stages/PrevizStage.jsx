import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Box, Map as MapIcon, Play, RefreshCw, X } from 'lucide-react';
import StageSection from '../StageSection.jsx';
import toast from '../../ui/Toast';
import useMusicVideoGreyboxPlaces from '../../../hooks/useMusicVideoGreyboxPlaces.js';
import { ingredientPath } from '../../../lib/creativeLibraries.js';
import { createCatalogIngredient, listCatalogIngredientsByIds, saveCatalogTown } from '../../../services/apiCatalog.js';
import { draftTownFromRouteMaps } from '../../../../../server/lib/townMap.js';
import { sceneShotName } from '../../../lib/musicVideoStages.js';
import { formatCount, formatTimecode } from '../../../utils/formatters.js';
import { shotNumbers } from '../ShotStepper.jsx';
import {
  backfillPrevizFromShots, previzCutProblems, previzPawnColors, updatePrevizCut, previzCutTiming, previzCutVisibleIds, previzPlaceGreybox, projectPreviz,
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

const townIdMaker = () => {
  const stamp = Date.now().toString(36);
  let n = 0;
  return () => `t${stamp}${(n += 1).toString(36)}`;
};

/**
 * The town the previz plays in: a catalog environment with a town map. "Draft
 * town from route maps" makes a new environment from the video's route maps
 * (sets on their routes, streets between them) and picks it; it is edited on
 * that environment's Town tab.
 */
function PrevizTown({ project, townId, onPick }) {
  const [town, setTown] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setTown(null);
    if (!townId) return () => { active = false; };
    listCatalogIngredientsByIds([townId], { silent: true })
      .then((rows) => { if (active) setTown(rows.find((row) => row.id === townId) || false); })
      .catch(() => { if (active) setTown(false); });
    return () => { active = false; };
  }, [townId]);
  const routes = (project.routeMaps || []).filter((map) => (map.stops || []).length);
  const draft = async () => {
    setBusy(true);
    const { town: map, skipped } = draftTownFromRouteMaps(project, { newId: townIdMaker(), seed: Math.floor(Math.random() * 1e6) });
    const created = await createCatalogIngredient({ type: 'place', name: `${project.title || 'Music video'} town`.slice(0, 120), payload: { description: 'Town map for the previz: the video\'s sets placed on one map, joined by streets.' } }).catch(() => null);
    const saved = created ? await saveCatalogTown(created.id, map).catch(() => null) : null;
    setBusy(false);
    if (!saved) return;
    onPick(saved.id);
    toast.success(`Town drafted with ${formatCount(map.sets.length)} set${map.sets.length === 1 ? '' : 's'}${skipped.length ? `; not in the catalog yet: ${skipped.join(', ')}` : ''}`);
  };
  if (townId) {
    const path = town ? `${ingredientPath({ id: townId, type: 'place' })}/town` : null;
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <MapIcon size={14} aria-hidden="true" className="text-port-text-muted" />
        <span className="text-port-text">{town === null ? 'Loading the town…' : town ? town.name : 'The town environment was removed'}</span>
        {path && <Link className={buttonCls} to={path}>Open town map</Link>}
        <button type="button" className={buttonCls} onClick={() => onPick(null)}><X size={12} aria-hidden="true" /> Unlink town</button>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <button type="button" className={buttonCls} disabled={busy || !routes.length} onClick={draft}><MapIcon size={12} aria-hidden="true" /> Draft town from route maps</button>
      <span className="text-port-text-muted">{routes.length
        ? 'Places the sets on one map, joined by streets, as a new environment you can edit.'
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

/** One cut's row: the shot it plays, and its set, camera, holder, cast and aim pickers. */
function CutRow({ project, cut, number, scene, places, characters, placeSubjects, onChange, onWatch }) {
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
  const subjects = project.concept?.subjects || [];
  const characters = subjects.filter((subject) => subject.kind === 'character');
  const placeSubjects = subjects.filter((subject) => subject.kind === 'place');
  const placesLoaded = placeSubjects.every((subject) => !subject.ingredientId || places[subject.ingredientId] !== undefined);
  const scenes = useMemo(() => project.scenes || [], [project.scenes]);
  const numbers = useMemo(() => shotNumbers(scenes), [scenes]);
  const timedShots = scenes.filter((scene) => Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec).length;
  // Applied locally at once; the page serializes the saves.
  const save = (next) => { editProjectLocal({ previz: next }); saveProjectFields({ previz: next }); };
  const build = () => {
    const { previz: next, added, removed } = backfillPrevizFromShots(project, places);
    save(next);
    toast.success(added || removed
      ? `Previz: ${[added ? `${formatCount(added)} cut${added === 1 ? '' : 's'} added` : '', removed ? `${formatCount(removed)} removed` : ''].filter(Boolean).join(', ')}`
      : 'Previz already matches the shots');
  };
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
          <button type="button" className={buttonCls} disabled={!timedShots || !placesLoaded} onClick={build}>
            {previz ? <RefreshCw size={12} aria-hidden="true" /> : <Box size={12} aria-hidden="true" />}
            {previz ? 'Sync with shots' : `Build previz from ${formatCount(timedShots)} shot${timedShots === 1 ? '' : 's'}`}
          </button>
          {!timedShots && <span className="text-xs text-port-text-muted">Time the shots on the Storyboard step first.</span>}
          {timedShots > 0 && !placesLoaded && <span className="text-xs text-port-text-muted">Loading the sets…</span>}
        </fieldset>
        <fieldset disabled={locked} className="min-w-0 space-y-1">
          <legend className="text-xs text-port-text-muted">Town</legend>
          <PrevizTown project={project} townId={project.previz?.townId || null} onPick={(townId) => {
            const current = project.previz && Array.isArray(project.previz.cuts) ? project.previz : { cuts: [], tracks: [] };
            save({ ...current, townId });
          }} />
        </fieldset>
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
                    characters={characters} placeSubjects={placeSubjects} onChange={(patch) => editCut(cut.id, patch)}
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
