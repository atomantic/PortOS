import { useState } from 'react';
import { ART_DIRECTION_ANCHOR } from '../../lib/musicVideoStages.js';
import ArtGuideDrafter from './ArtGuideDrafter.jsx';
import { reviewAnchorStyle, reviewButtonClass as buttonClass, reviewFieldClass as fieldClass } from './controlClasses.js';

export default function ArtDirectionPlanningForm({ project, review, draft, dirty, fieldId, set, setLocal, onOpenArtifact }) {
  const [importError, setImportError] = useState(null);
  const documentShots = draft.storyboardSource === 'document';

  return <>
    {importError && <p role="alert">{importError}</p>}
    <label htmlFor={fieldId('import')} className="block text-sm">Import planning JSON as an unapproved draft
      <input id={fieldId('import')} type="file" accept=".json,application/json" disabled={dirty || review.busy} className={fieldClass}
        onChange={async e => {
          const file = e.target.files?.[0]; e.target.value = ''; setImportError(null);
          if (!file) return;
          try { if (await review.importPlanning(await file.text())) setLocal(null); }
          catch (error) { setImportError(error.message); }
        }} />
    </label>
    {draft.sourceArtifactId && <button type="button" className={buttonClass} onClick={() => onOpenArtifact(draft.sourceArtifactId)}>Read preserved original planning draft</button>}
    <button type="button" className={buttonClass} disabled={dirty || review.busy || documentShots} onClick={review.prepare}>Draft art direction and shots</button>
    <p className="text-xs text-port-text-muted">Uses the saved authoring provider and allowed tools. Builds Cast & Sets first, then pauses for art approval before planning shots. Existing edits are retained.</p>
    <ArtGuideDrafter project={project} disabled={review.busy} onUse={fields => setLocal({ ...draft, ...fields })} />
    <div id={ART_DIRECTION_ANCHOR} className="grid gap-3 sm:grid-cols-2" style={reviewAnchorStyle}>
      {Object.entries({ cast: 'Cast guide', environments: 'Environment guide', visualLanguage: 'Visual language and mood board' }).map(([key, label]) =>
        <label key={key} htmlFor={fieldId(key)} className="text-sm">{label}<textarea id={fieldId(key)} rows={4} value={draft[key]} onChange={e => set(key, e.target.value)} className={fieldClass} /></label>)}
    </div>
    <label htmlFor={fieldId('motionLanguage')} className="block text-sm">Timed choreography and energy plan
      <textarea id={fieldId('motionLanguage')} rows={7} value={draft.motionLanguage || ''} onChange={e => set('motionLanguage', e.target.value)} className={fieldClass}
        aria-label="Timed choreography and energy plan" aria-describedby={fieldId('motion-help')}
        placeholder={'Energy target: restrained, driving, explosive, or a described arc.\n0:00–0:08 / first downbeat: subject reaches, prop unfolds; camera pushes in; title lands on the vocal.\n0:08–0:16 / chorus hit: full-body turn and prop release; camera arcs; type expands then clears.\nRepeated chorus: preserve the motif, escalate pose range, travel, camera depth or transition scale.'} />
    </label>
    <p id={fieldId('motion-help')} className="text-xs text-port-text-muted">Choose the intended energy explicitly. For each time range and beat, word or section anchor, describe subject and prop actions, pose or travel changes, camera movement, typography and the transition. Name intentional holds and how each repeated chorus develops. The saved plan guides UI authoring and autopilot.</p>
    <label htmlFor={fieldId('implementation')} className="block text-sm">Implementation and feasibility for {project.composition?.mode || 'composed'} rendering
      <textarea id={fieldId('implementation')} rows={5} value={draft.implementationPlan || ''} onChange={e => set('implementationPlan', e.target.value)} className={fieldClass}
        placeholder="Map each timed action to scene graph layers, vector/mesh construction, rig joints, pose limits and prop mechanics; specify camera paths and typography timing, transitions, frame rate, geometry and draw-call budgets." />
    </label>
    <p className="text-xs text-port-text-muted">Concept references establish intent. Document how this renderer can build and animate the look; a raster reference is not code-rendered evidence. Changing the plan invalidates prior art approval.</p>
    <label htmlFor={fieldId('guide')} className="block text-sm">Visual cast and environment sheet
      <select id={fieldId('guide')} value={draft.guideArtifactId || ''} onChange={e => set('guideArtifactId', e.target.value || null)} className={fieldClass}>
        <option value="">Choose a Development artifact</option>
        {(project.devArtifacts || []).filter(a => !a.deleted).map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
      </select>
    </label>
    {draft.guideArtifactId && <button type="button" className={buttonClass} onClick={() => onOpenArtifact(draft.guideArtifactId)}>Review visual sheet</button>}
  </>;
}
