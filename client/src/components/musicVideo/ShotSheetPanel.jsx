import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import StageSection from './StageSection.jsx';
import ShotSheetAi from './ShotSheetAi.jsx';
import ScenePoster from './ScenePoster.jsx';
import { musicVideoImageSrc, scenePosterSrc } from '../../lib/musicVideoPreview.js';
import { formatTimecode } from '../../utils/formatters.js';
import { uuidv4 } from '../../lib/uuid.js';
import {
  SHOT_CAMERA_MAX, SHOT_CAMERA_SET_DOWN, SHOT_SHEET_MAP_BARS, normalizeShotSheet, shotSheetCast, shotSheetOptions, shotSheetProblems, shotSheetRows, shotSheetStretches,
} from '../../../../server/lib/musicVideoShotSheet.js';

const inputCls = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';

/** A text box that commits on blur, and only when its text changed. */
function SheetText({ label, value = '', rows = 2, disabled, onCommit, maxLength }) {
  return (
    <textarea key={value} aria-label={label} rows={rows} defaultValue={value} disabled={disabled} maxLength={maxLength}
      onBlur={(event) => { if (event.target.value !== value) onCommit(event.target.value); }}
      className={`${inputCls} resize-y [field-sizing:content]`} />
  );
}

/** A column you can pick from or type into: one list per column on the page, shared by every row. */
function SheetPick({ label, field, value = '', disabled, onCommit, maxLength }) {
  return (
    <input key={value} aria-label={label} list={`mv-sheet-${field}`} defaultValue={value} disabled={disabled} maxLength={maxLength}
      onBlur={(event) => { if (event.target.value !== value) onCommit(event.target.value); }}
      className={inputCls} />
  );
}

// A value keeps its color wherever it comes back along its bar.
const MAP_TICK_SEC = 30;
const MAP_COLORS = ['bg-port-accent/30', 'bg-port-success/30', 'bg-port-warning/30', 'bg-port-error/30', 'bg-port-accent/60', 'bg-port-success/60', 'bg-port-warning/60', 'bg-port-error/60'];

/** The video's map: a bar each for location, camera and time of day, each stretch sized by its length in the song. Tapping one lists only its shots. */
function ShotSheetMap({ rows, active, onPick }) {
  const timed = rows.filter(({ scene }) => Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec));
  const startSec = timed.length ? Math.min(...timed.map(({ scene }) => scene.startSec)) : 0;
  const span = timed.length ? Math.max(...timed.map(({ scene }) => scene.endSec)) - startSec : 0;
  const ticks = [];
  if (span > 0) for (let at = Math.ceil(startSec / MAP_TICK_SEC) * MAP_TICK_SEC; at < startSec + span; at += MAP_TICK_SEC) ticks.push(at);
  return (
    <div role="group" aria-label="Video map" className="min-w-0 space-y-1">
      {ticks.length > 0 && (
        <div aria-hidden="true" className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-1.5">
          <span />
          <div data-testid="map-ruler" className="relative h-4 min-w-0 overflow-hidden text-xs tabular-nums text-port-text-muted">
            {ticks.map((at) => (
              <span key={at} className="absolute top-0 border-l border-port-border pl-1" style={{ left: `${((at - startSec) / span) * 100}%` }}>{`${Math.floor(at / 60)}:${String(Math.round(at % 60)).padStart(2, '0')}`}</span>
            ))}
          </div>
        </div>
      )}
      {SHOT_SHEET_MAP_BARS.map(([bar, label, readValue]) => {
        const stretches = shotSheetStretches(rows, readValue);
        // A camera keeps one color whoever has it; the label says who.
        const colorKey = (value) => value.split(' · ')[0];
        const values = [...new Set(stretches.map((stretch) => stretch.value).filter(Boolean).map(colorKey))];
        return (
          <div key={bar} className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-stretch gap-1.5">
            <span className="self-center text-xs text-port-text-muted">{label}</span>
            <div role="group" aria-label={label} className="flex min-h-[44px] min-w-0 overflow-hidden rounded border border-port-border">
              {stretches.map((stretch) => {
                const name = stretch.value || 'Not set';
                const color = stretch.value ? MAP_COLORS[values.indexOf(colorKey(stretch.value)) % MAP_COLORS.length] : 'bg-port-bg';
                const on = active?.bar === bar && active.value === stretch.value;
                const detail = `${formatTimecode(stretch.startSec)}, ${stretch.shots} shot${stretch.shots === 1 ? '' : 's'}`;
                return (
                  <button key={stretch.startSec} type="button" aria-pressed={on} onClick={() => onPick(on ? null : { bar, value: stretch.value })}
                    aria-label={`${label} ${name}, ${detail}`} title={`${name}, ${detail}`}
                    style={{ flex: `${Math.max(stretch.endSec - stretch.startSec, 0.1)} 1 0` }}
                    className={`min-w-0 overflow-hidden border-r border-port-border px-1 py-1 text-left text-xs last:border-r-0 ${color} ${on ? 'ring-2 ring-inset ring-port-accent' : ''}`}>
                    <span className="block truncate font-medium">{name}</span>
                    <span className="block truncate tabular-nums text-port-text-muted">{formatTimecode(stretch.startSec)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The cameras that exist in this video: each shot on the sheet picks one. */
function CameraList({ project, disabled, onChange }) {
  const cameras = project.cameras || [];
  const patch = (id, change) => onChange(cameras.map((camera) => (camera.id === id ? { ...camera, ...change } : camera)));
  const add = () => onChange([...cameras, { id: `cam-${uuidv4().slice(0, 8)}`, name: `Camera ${cameras.length + 1}`, kind: 'in-world' }]);
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-1.5">
      <legend className="text-xs font-medium">Cameras in this video</legend>
      <p className="text-xs text-port-text-muted">Name each camera the story has. An in-world camera has an owner and can be borrowed or set down; an observer isn’t in their world, so nobody ever looks at it.</p>
      {cameras.map((camera) => (
        <div key={camera.id} className="grid min-w-0 gap-1.5 sm:grid-cols-[10rem_7.5rem_8rem_minmax(0,1fr)_2.75rem]">
          <input key={`n-${camera.name}`} aria-label="Camera name" defaultValue={camera.name} maxLength={120} className={inputCls}
            onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== camera.name) patch(camera.id, { name }); }} />
          <select aria-label={`${camera.name} kind`} value={camera.kind} className={inputCls} onChange={(event) => patch(camera.id, { kind: event.target.value })}>
            <option value="in-world">In their world</option>
            <option value="observer">Observer</option>
          </select>
          <input key={`o-${camera.owner || ''}`} aria-label={`${camera.name} owner`} placeholder="Owner" defaultValue={camera.owner || ''} maxLength={120} className={inputCls}
            onBlur={(event) => { if (event.target.value.trim() !== (camera.owner || '')) patch(camera.id, { owner: event.target.value.trim() }); }} />
          <input key={`r-${camera.rule || ''}`} aria-label={`${camera.name} rule`} placeholder="How it behaves in the story" defaultValue={camera.rule || ''} maxLength={1000} className={inputCls}
            onBlur={(event) => { if (event.target.value.trim() !== (camera.rule || '')) patch(camera.id, { rule: event.target.value.trim() }); }} />
          <button type="button" aria-label={`Remove ${camera.name}`} onClick={() => onChange(cameras.filter((entry) => entry.id !== camera.id))}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-port-text-muted">
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      {cameras.length < SHOT_CAMERA_MAX && (
        <button type="button" onClick={add} className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-1 text-xs sm:min-h-0">
          <Plus size={12} aria-hidden="true" /> Add camera
        </button>
      )}
    </fieldset>
  );
}

/** One shot's row. Each column is the director's own plan; the prompts it sits beside are shown on request. */
function SheetRow({ project, row, cast, showPrompts, disabled, onEdit, onOpen }) {
  const { scene, sheet, lyric, camera, frameOutdated, problems } = row;
  const setField = (field, value) => onEdit(scene.sceneId, { ...sheet, [field]: value });
  const label = scene.label || 'Shot';
  const toggleCharacter = (name) => {
    const current = sheet.characters || [];
    setField('characters', current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]);
  };
  const onCamera = (cameraId) => {
    const next = project.cameras?.find((entry) => entry.id === cameraId);
    // An observer has nobody behind it, so changing to one clears the holder.
    onEdit(scene.sceneId, { ...sheet, cameraId: cameraId || null, holder: next?.kind === 'observer' ? null : sheet.holder });
  };
  return (
    <tr className="align-top">
      <td className="whitespace-nowrap p-1.5 text-xs tabular-nums">
        <button type="button" onClick={() => onOpen(scene.sceneId)} aria-label={`Open ${label}`} className="block min-h-[44px] font-medium text-port-accent sm:min-h-0">{label}</button>
        {Number.isFinite(scene.startSec) ? formatTimecode(scene.startSec) : 'Untimed'}
        {Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && <span className="block text-port-text-muted">{(scene.endSec - scene.startSec).toFixed(1)}s</span>}
        <label className="mt-1 flex min-h-[44px] items-center gap-1 sm:min-h-0">
          <input type="checkbox" aria-label={`${label} checked`} checked={!!sheet.checked} disabled={disabled} onChange={(event) => setField('checked', event.target.checked)} /> Checked
        </label>
      </td>
      <td className="w-28 p-1.5">
        <ScenePoster scene={scene} src={scenePosterSrc(scene) || musicVideoImageSrc(scene.panelArt)} className="aspect-video w-24 rounded" iconSize={14} />
        {frameOutdated && <span className="mt-0.5 block text-xs text-port-warning">Prompt changed since this frame</span>}
      </td>
      <td className="w-32 p-1.5 text-xs italic">{lyric || <span className="not-italic text-port-text-muted">Instrumental</span>}</td>
      <td className="w-40 space-y-1 p-1.5">
        <select aria-label={`${label} camera`} value={sheet.cameraId || ''} disabled={disabled} className={inputCls} onChange={(event) => onCamera(event.target.value)}>
          <option value="">No camera set</option>
          {(project.cameras || []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        {camera?.kind !== 'observer' && (
          <select aria-label={`${label} held by`} value={sheet.holder || ''} disabled={disabled || !camera} className={inputCls} onChange={(event) => setField('holder', event.target.value || null)}>
            <option value="">Held by</option>
            {cast.map((name) => <option key={name} value={name}>{name}</option>)}
            <option value={SHOT_CAMERA_SET_DOWN}>Set down, nobody holding</option>
          </select>
        )}
      </td>
      <td className="w-44 p-1.5"><SheetPick label={`${label} view`} field="view" value={sheet.view} maxLength={1000} disabled={disabled} onCommit={(value) => setField('view', value)} /></td>
      <td className="w-36 space-y-1 p-1.5">
        <SheetPick label={`${label} location`} field="location" value={sheet.location} maxLength={200} disabled={disabled} onCommit={(value) => setField('location', value)} />
        <SheetPick label={`${label} time and light`} field="light" value={sheet.light} maxLength={300} disabled={disabled} onCommit={(value) => setField('light', value)} />
      </td>
      <td className="w-28 p-1.5">
        <div role="group" aria-label={`${label} characters`} className="flex flex-wrap gap-1">
          {cast.map((name) => {
            const on = (sheet.characters || []).includes(name);
            return (
              <button key={name} type="button" aria-pressed={on} disabled={disabled} onClick={() => toggleCharacter(name)}
                className={`min-h-[44px] rounded-full border px-2 py-0.5 text-xs sm:min-h-0 ${on ? 'border-port-accent bg-port-accent/10 text-port-accent' : 'border-port-border text-port-text-muted'}`}>{name}</button>
            );
          })}
        </div>
      </td>
      <td className="min-w-[14rem] p-1.5"><SheetText label={`${label} action`} value={sheet.action} rows={3} maxLength={2000} disabled={disabled} onCommit={(value) => setField('action', value)} /></td>
      <td className="w-36 p-1.5"><SheetPick label={`${label} emotion`} field="emotion" value={sheet.emotion} maxLength={300} disabled={disabled} onCommit={(value) => setField('emotion', value)} /></td>
      <td className="w-44 p-1.5">
        <SheetText label={`${label} notes`} value={sheet.notes} maxLength={2000} disabled={disabled} onCommit={(value) => setField('notes', value)} />
        {problems.map((text) => <span key={text} className="mt-0.5 block text-xs text-port-warning">{text}</span>)}
      </td>
      {showPrompts && (
        <td className="min-w-[24rem] p-1.5 text-xs text-port-text-muted">
          <p><span className="font-medium text-port-text">Frame: </span>{scene.framePrompt || 'None'}</p>
          <p className="mt-1"><span className="font-medium text-port-text">Motion: </span>{scene.prompt || 'None'}</p>
        </td>
      )}
    </tr>
  );
}

/**
 * The shot sheet on Shots: the whole video on one screen, to read the story
 * through and plan each shot without rendering a frame. Filled columns save
 * as you leave them. The sheet doesn't change what's sent to a model: the frame
 * and motion prompts stay the shot's inputs, shown here with Show prompts.
 */
export default function ShotSheetPanel({ board }) {
  const { project, locked, editSceneLocal, saveScene, editProjectLocal, saveProjectFields, onEditShot } = board;
  const [query, setQuery] = useState('');
  const [cameraFilter, setCameraFilter] = useState('');
  const [outdatedOnly, setOutdatedOnly] = useState(false);
  const [mapFilter, setMapFilter] = useState(null);
  const [uncheckedOnly, setUncheckedOnly] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const rows = useMemo(() => shotSheetRows(project).map((row, at, all) => ({ ...row, problems: shotSheetProblems(row, all[at - 1]) })), [project]);
  const options = useMemo(() => ['view', 'location', 'light', 'emotion'].map((field) => [field, shotSheetOptions(project, field)]), [project]);
  const cast = useMemo(() => shotSheetCast(project), [project]);
  const outdated = rows.filter((row) => row.frameOutdated).length;
  const checked = rows.filter((row) => row.sheet.checked).length;
  const withProblems = rows.filter((row) => row.problems.length).length;
  const needle = query.trim().toLowerCase();
  const listed = rows.filter((row) => {
    if (outdatedOnly && !row.frameOutdated) return false;
    if (mapFilter && SHOT_SHEET_MAP_BARS.find(([bar]) => bar === mapFilter.bar)[2](row) !== mapFilter.value) return false;
    if (uncheckedOnly && row.sheet.checked) return false;
    if (problemsOnly && !row.problems.length) return false;
    if (cameraFilter && row.sheet.cameraId !== cameraFilter) return false;
    if (!needle) return true;
    const { characters = [], view, location, light, action, emotion, notes } = row.sheet;
    return [row.scene.label, row.lyric, row.scene.framePrompt, row.scene.prompt, ...characters, view, location, light, action, emotion, notes]
      .some((text) => typeof text === 'string' && text.toLowerCase().includes(needle));
  });
  const editSheet = (sceneId, sheet) => {
    const shotSheet = normalizeShotSheet(sheet);
    editSceneLocal(sceneId, { shotSheet });
    saveScene(sceneId, { shotSheet });
  };
  const editCameras = (cameras) => {
    editProjectLocal({ cameras });
    saveProjectFields({ cameras });
  };
  const summary = `${checked} of ${rows.length} shots checked${withProblems ? ` · ${withProblems} incomplete` : ''}${outdated ? ` · ${outdated} frame${outdated === 1 ? '' : 's'} older than ${outdated === 1 ? 'its prompt' : 'their prompts'}` : ''}`;
  return (
    <StageSection id="mv-shot-sheet" title="Shot sheet" summary={summary}>
      <ShotSheetMap rows={rows} active={mapFilter} onPick={setMapFilter} />
      <CameraList project={project} disabled={locked} onChange={editCameras} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input type="search" aria-label="Search shots" placeholder="Search shots" value={query} onChange={(event) => setQuery(event.target.value)} className={`${inputCls} max-w-xs`} />
        <select aria-label="Filter by camera" value={cameraFilter} onChange={(event) => setCameraFilter(event.target.value)} className={`${inputCls} max-w-[12rem]`}>
          <option value="">All cameras</option>
          {(project.cameras || []).map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
        </select>
        <label className="inline-flex min-h-[44px] items-center gap-1 sm:min-h-0">
          <input type="checkbox" checked={uncheckedOnly} onChange={(event) => setUncheckedOnly(event.target.checked)} /> Only not checked
        </label>
        <label className="inline-flex min-h-[44px] items-center gap-1 sm:min-h-0">
          <input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} /> Only incomplete
        </label>
        <label className="inline-flex min-h-[44px] items-center gap-1 sm:min-h-0">
          <input type="checkbox" checked={outdatedOnly} onChange={(event) => setOutdatedOnly(event.target.checked)} /> Only frames older than their prompt
        </label>
        <label className="inline-flex min-h-[44px] items-center gap-1 sm:min-h-0">
          <input type="checkbox" checked={showPrompts} onChange={(event) => setShowPrompts(event.target.checked)} /> Show prompts
        </label>
        <span className="text-port-text-muted">{listed.length} shown</span>
      </div>
      <p className="text-xs text-port-text-muted">Your plan for each shot: pick from the lists or type your own, then tick Checked when it’s right. It sits beside the frame and motion prompts and isn’t sent to a model.</p>
      {options.map(([field, values]) => (
        <datalist key={field} id={`mv-sheet-${field}`}>{values.map((value) => <option key={value} value={value} />)}</datalist>
      ))}
      <button type="button" aria-expanded={aiOpen} onClick={() => setAiOpen((open) => !open)} className="min-h-[44px] rounded border border-port-border px-2 py-1 text-xs sm:min-h-0">
        {aiOpen ? 'Hide AI help' : 'AI help'}
      </button>
      {aiOpen && (
        <ShotSheetAi project={project} rows={listed} disabled={locked}
          onApplyingChange={setAiApplying}
          // Saved before it shows, so a failed shot stays a pending proposal that Apply can retry.
          onApply={async (sceneId, patch) => {
            const saved = await saveScene(sceneId, patch);
            if (saved) editSceneLocal(sceneId, patch);
            return saved;
          }} />
      )}
      <div className="max-h-[85vh] overflow-auto rounded border border-port-border">
        <table className="w-full min-w-[78rem] border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-port-card text-xs text-port-text-muted">
            <tr>
              {['Shot', 'Frame', 'Lyric', 'Camera', 'View', 'Where, time and light', 'Who', 'Action', 'Emotion', 'Notes', ...(showPrompts ? ['Prompts'] : [])]
                .map((heading) => <th key={heading} scope="col" className="border-b border-port-border p-1.5 font-medium">{heading}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-port-border">
            {listed.map((row) => (
              <SheetRow key={row.scene.sceneId} project={project} row={row} cast={cast} showPrompts={showPrompts} disabled={locked || aiApplying} onEdit={editSheet} onOpen={onEditShot} />
            ))}
          </tbody>
        </table>
      </div>
    </StageSection>
  );
}
