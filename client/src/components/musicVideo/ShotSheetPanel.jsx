import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import StageSection from './StageSection.jsx';
import ScenePoster from './ScenePoster.jsx';
import { musicVideoImageSrc, scenePosterSrc } from '../../lib/musicVideoPreview.js';
import { formatTimecode } from '../../utils/formatters.js';
import { uuidv4 } from '../../lib/uuid.js';
import {
  SHOT_CAMERA_MAX, SHOT_CAMERA_SET_DOWN, normalizeShotSheet, shotSheetCast, shotSheetRows,
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
  const { scene, sheet, lyric, camera, frameOutdated } = row;
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
      </td>
      <td className="w-28 p-1.5">
        <ScenePoster scene={scene} src={musicVideoImageSrc(scene.panelArt) || scenePosterSrc(scene)} className="aspect-video w-24 rounded" iconSize={14} />
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
      <td className="w-44 p-1.5"><SheetText label={`${label} view`} value={sheet.view} maxLength={1000} disabled={disabled} onCommit={(value) => setField('view', value)} /></td>
      <td className="w-36 space-y-1 p-1.5">
        <SheetText label={`${label} location`} value={sheet.location} rows={1} maxLength={200} disabled={disabled} onCommit={(value) => setField('location', value)} />
        <SheetText label={`${label} time and light`} value={sheet.light} rows={1} maxLength={300} disabled={disabled} onCommit={(value) => setField('light', value)} />
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
      <td className="w-36 p-1.5"><SheetText label={`${label} emotion`} value={sheet.emotion} maxLength={300} disabled={disabled} onCommit={(value) => setField('emotion', value)} /></td>
      <td className="w-44 p-1.5"><SheetText label={`${label} notes`} value={sheet.notes} maxLength={2000} disabled={disabled} onCommit={(value) => setField('notes', value)} /></td>
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
  const [showPrompts, setShowPrompts] = useState(false);
  const rows = useMemo(() => shotSheetRows(project), [project]);
  const cast = useMemo(() => shotSheetCast(project), [project]);
  const outdated = rows.filter((row) => row.frameOutdated).length;
  const planned = rows.filter((row) => row.scene.shotSheet).length;
  const needle = query.trim().toLowerCase();
  const listed = rows.filter((row) => {
    if (outdatedOnly && !row.frameOutdated) return false;
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
  const summary = `${planned} of ${rows.length} shots planned${outdated ? ` · ${outdated} frame${outdated === 1 ? '' : 's'} older than ${outdated === 1 ? 'its prompt' : 'their prompts'}` : ''}`;
  return (
    <StageSection id="mv-shot-sheet" title="Shot sheet" summary={summary}>
      <CameraList project={project} disabled={locked} onChange={editCameras} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input type="search" aria-label="Search shots" placeholder="Search shots" value={query} onChange={(event) => setQuery(event.target.value)} className={`${inputCls} max-w-xs`} />
        <select aria-label="Filter by camera" value={cameraFilter} onChange={(event) => setCameraFilter(event.target.value)} className={`${inputCls} max-w-[12rem]`}>
          <option value="">All cameras</option>
          {(project.cameras || []).map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
        </select>
        <label className="inline-flex min-h-[44px] items-center gap-1 sm:min-h-0">
          <input type="checkbox" checked={outdatedOnly} onChange={(event) => setOutdatedOnly(event.target.checked)} /> Only frames older than their prompt
        </label>
        <label className="inline-flex min-h-[44px] items-center gap-1 sm:min-h-0">
          <input type="checkbox" checked={showPrompts} onChange={(event) => setShowPrompts(event.target.checked)} /> Show prompts
        </label>
        <span className="text-port-text-muted">{listed.length} shown</span>
      </div>
      <p className="text-xs text-port-text-muted">Your plan for each shot. It sits beside the frame and motion prompts and isn’t sent to a model.</p>
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
              <SheetRow key={row.scene.sceneId} project={project} row={row} cast={cast} showPrompts={showPrompts} disabled={locked} onEdit={editSheet} onOpen={onEditShot} />
            ))}
          </tbody>
        </table>
      </div>
    </StageSection>
  );
}
