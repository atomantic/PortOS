import { useMemo, useState } from 'react';
import { formatTimecode } from '../../utils/formatters.js';
import { reviewButtonClass as buttonClass, reviewFieldClass as fieldClass } from './controlClasses.js';

const shotKey = shot => shot.id || shot.sceneId;

export default function StoryboardPlanningForm({ project, review, ready, draft, dirty, fieldId, shots, set, setLocal }) {
  const [importError, setImportError] = useState(null);
  const documentShots = draft.storyboardSource === 'document';
  const manifestBasis = ready?.documentShotImport;
  const manifestExample = useMemo(() => JSON.stringify({
    ...manifestBasis, sourceFile: 'timeline.js', shots: [{
      id: 'source-shot-id', sceneId: null, startSec: 0, endSec: 10, lyricCueIds: [],
      action: 'Source action', staging: 'Source staging', camera: 'Source camera', transition: 'Source transition',
    }],
  }, null, 2), [manifestBasis]);
  const setShot = (shot, key, value) => set('storyboard', shots.map(entry => shotKey(entry) === shotKey(shot) ? { ...entry, [key]: value } : entry));

  return <>
    {importError && <p role="alert">{importError}</p>}
    {project.composition?.mode === 'document' && <div className="space-y-2 rounded border border-port-border p-2">
      <p className="text-sm">Document shot manifest</p>
      <p className="text-xs text-port-text-muted">Export the composition in Shots. Have its author extract the actual shot IDs, timings and choreography from the source (for example timeline.js) into the JSON format below, keeping its documentDirectory and audioBasis from when that source was authored. A generic document section or Board row is not a shot list. Reauthor and reimport the composition after changing lyrics or timing, then import its matching manifest here.</p>
      <label htmlFor={fieldId('document-shots')} className="block text-sm">Import document shot manifest
        <input id={fieldId('document-shots')} type="file" accept=".json,application/json" disabled={dirty || review.busy || !project.productionReview?.draft || !project.composition.document} className={fieldClass}
          onChange={async e => {
            const file = e.target.files?.[0]; e.target.value = ''; setImportError(null);
            if (!file) return;
            try {
              const input = JSON.parse(await file.text());
              if (await review.importDocumentShots(input)) setLocal(null);
            } catch (error) { setImportError(error.message); }
          }} />
      </label>
      <details><summary className="cursor-pointer py-2 text-sm">Shot manifest format</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{manifestExample}</pre></details>
      <p className="text-xs">{project.productionReview?.documentStoryboard ? `Bound source: ${project.productionReview.documentStoryboard.sourceFile}. Reimporting a document, changing audio or editing these shots requires a new matching manifest.` : 'No document shot manifest bound. Board scenes do not stand in for source shots.'}</p>
    </div>}
    {/* Song content and lyric-timing verification live on the Song step (LyricTimingCheck). */}
    <label htmlFor={fieldId('storyboard-source')} className="block text-sm">Storyboard source
      <select id={fieldId('storyboard-source')} value={draft.storyboardSource || 'board'} onChange={e => set('storyboardSource', e.target.value)} className={fieldClass}>
        <option value="board">Board scenes</option><option value="document">Authored document shot manifest</option>
      </select>
    </label>
    {shots.map(shot => {
      const scene = documentShots ? shot : project.scenes?.find(s => s.sceneId === shot.sceneId);
      return <details key={shotKey(shot)} className="rounded border border-port-border p-2">
        <summary className="cursor-pointer min-h-[44px] text-sm">{scene?.label || shot.id || 'Unbound shot'} — {documentShots ? 'document source shot' : scene ? 'edit choreography' : 'bind to a Board scene'}</summary>
        {!documentShots && <label htmlFor={fieldId(`scene-${shotKey(shot)}`)} className="block text-sm">Board scene
          <select id={fieldId(`scene-${shotKey(shot)}`)} value={shot.sceneId || ''} onChange={e => setShot(shot, 'sceneId', e.target.value || null)} className={fieldClass}>
            <option value="">Unbound draft — no scene selected</option>
            {(project.scenes || []).map(s => <option key={s.sceneId} value={s.sceneId}>{s.label || s.sceneId}</option>)}
          </select>
        </label>}
        {!documentShots && !scene && <button type="button" className={buttonClass} disabled={dirty || review.busy || !shot.id} onClick={() => review.bindShot(shot.id)}>Create Board scene from this draft shot</button>}
        {documentShots ? <div className="flex flex-wrap gap-2">
          {['startSec', 'endSec'].map(key => <label key={key} htmlFor={fieldId(`${shotKey(shot)}-${key}`)} className="text-sm">{key === 'startSec' ? 'Shot start (seconds)' : 'Shot end (seconds)'}<input id={fieldId(`${shotKey(shot)}-${key}`)} type="number" min="0" step="0.01" value={shot[key] ?? ''} onChange={e => setShot(shot, key, e.target.value === '' ? null : Number(e.target.value))} className={fieldClass} /></label>)}
          <p className="text-xs text-port-text-muted">Planning edits do not rewrite source code. Reauthor or reimport in Shots, then import its matching shot manifest before approval.</p>
        </div> : <p className="text-xs text-port-text-muted">{scene && Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) ? `Shot window ${formatTimecode(scene.startSec)}–${formatTimecode(scene.endSec)}. ` : ''}Review exact start/end in Board. Imported timings remain provisional.</p>}
        {['action', 'staging', 'camera', 'transition'].map(key => <label key={key} htmlFor={fieldId(`${shotKey(shot)}-${key}`)} className="block text-sm capitalize">{key}
          <textarea id={fieldId(`${shotKey(shot)}-${key}`)} rows={2} value={shot[key]} placeholder={({ action: 'At a beat or word: subject and prop action; pose, travel and energy change.', staging: 'Depth, blocking, prop trajectory and typography placement through the shot.', camera: 'Timed camera path, framing changes and motivated holds.', transition: 'Exact entry/exit anchor, visual handoff and escalation into the next section.' })[key]} onChange={e => setShot(shot, key, e.target.value)} className={fieldClass} />
        </label>)}
        <fieldset><legend className="text-sm">Lyric anchors</legend>
          {(project.lyricCues || []).filter(c => c.startSec < scene?.endSec && c.endSec > scene?.startSec).map(cue =>
            <label key={cue.id} htmlFor={fieldId(`${shotKey(shot)}-${cue.id}`)} className="flex gap-2 py-2 text-sm"><input id={fieldId(`${shotKey(shot)}-${cue.id}`)} type="checkbox" checked={shot.lyricCueIds.includes(cue.id)}
              onChange={e => setShot(shot, 'lyricCueIds', e.target.checked ? [...shot.lyricCueIds, cue.id] : shot.lyricCueIds.filter(id => id !== cue.id))} />{cue.text}</label>)}
        </fieldset>
      </details>;
    })}
  </>;
}
