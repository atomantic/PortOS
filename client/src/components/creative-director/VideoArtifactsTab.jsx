import { Link } from 'react-router';
import { useEffect, useState } from 'react';
import { getCreativeDirectorSources } from '../../services/apiCreativeDirector.js';
import { formatTimecode } from '../../utils/formatters.js';
import { PLAN_STEP_STATUS_META, stepResultLink } from '../../lib/creativeDirectorPlan.js';

export default function VideoArtifactsTab({ project, basePath }) {
  const treatment = project.treatment;
  const artifact = treatment?.artifact;
  const projectPath = `${basePath}/${encodeURIComponent(project.id)}`;
  const scenes = new Map((treatment?.scenes || []).map(scene => [scene.sceneId, scene]));
  const [sourceState, setSourceState] = useState(null);
  const [sourceError, setSourceError] = useState(false);
  const [check, setCheck] = useState(0);
  useEffect(() => {
    let current = true;
    setSourceState(null);
    setSourceError(false);
    getCreativeDirectorSources(project.id, { silent: true }).then(result => {
      if (current) setSourceState(result);
    }).catch(() => { if (current) setSourceError(true); });
    return () => { current = false; };
  }, [project.id, project.updatedAt, check]);
  const repairPath = `${projectPath}/overview?draft=1&videoDraftTab=sources`;

  return (
    <div className="max-w-4xl space-y-4">
      <h2 className="text-lg font-medium">Production artifacts</h2>
      <p className="text-sm text-port-text-muted">Saved planning artifacts. Production remains blocked until revision approvals and dispatch controls are available.</p>
      <section aria-label="Source availability" className="bg-port-card border border-port-border rounded p-4 space-y-2 text-sm">
        <h3 className="font-medium">Source availability</h3>
        {sourceError ? <p role="alert">Unable to check sources. Availability is unknown; no references were changed.</p>
          : !sourceState ? <p role="status">Checking sources…</p>
            : <>
              <p>Current draft: {sourceState.draft.filter(source => !source.available).length} missing sources. Saved revisions are unchanged by this check.</p>
              <ul>{sourceState.draft.filter(source => !source.available).map(source => <li key={source.referenceId} className="text-port-warning break-words">Missing {source.kind}: {source.id}</li>)}</ul>
            </>}
        <div className="flex flex-wrap gap-3">
          <button disabled={!sourceState && !sourceError} onClick={() => setCheck(value => value + 1)} className="text-port-accent disabled:opacity-50">Check again</button>
          {project.status === 'draft' && <Link className="text-port-accent hover:underline" to={repairPath}>Edit source attachments</Link>}
        </div>
        <p className="text-port-text-muted">Remove or replace missing sources in the draft, then save a revised treatment to repair saved references. Music references identify tracks; voice references identify local voice profiles.</p>
      </section>
      {!artifact ? (
        <p className="text-sm text-port-text-muted">
          No compiled artifact yet. A saved Video treatment with a script and shots totaling the exact target will appear here.
          {' '}<Link className="text-port-accent hover:underline" to={`${projectPath}/overview`}>Review the brief</Link>
        </p>
      ) : (
        <>
          <section aria-label="Artifact revision" className="bg-port-card border border-port-border rounded p-4 space-y-2">
            <p className="font-medium">Revision {artifact.revision} · {artifact.targetDurationSeconds} seconds · {artifact.aspectRatio}</p>
            <p className="text-xs text-port-text-muted break-words">Script ID: {artifact.scriptId}</p>
            {artifact.stale && <p role="status" className="text-sm text-port-warning">
              This artifact is out of date. The brief, sources, or production settings changed after it was compiled.
              {' '}<Link className="underline" to={`${projectPath}/overview`}>Review the current draft</Link>
              {' '}and save a revised treatment before production.
            </p>}
          </section>
          <section aria-labelledby="video-artifact-script" className="space-y-2">
            <h3 id="video-artifact-script" className="font-medium">Script</h3>
            <p className="bg-port-card border border-port-border rounded p-4 text-sm whitespace-pre-wrap break-words">{treatment.script || 'No script text saved in this revision.'}</p>
          </section>
          <section aria-labelledby="video-artifact-shots" className="space-y-2">
            <h3 id="video-artifact-shots" className="font-medium">Timed shots ({artifact.shots.length})</h3>
            <ol className="space-y-2">
              {artifact.shots.map(shot => {
                const scene = scenes.get(shot.sceneId);
                return <li key={shot.shotId} className="bg-port-card border border-port-border rounded p-3 space-y-1 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    {scene ? <Link className="text-port-accent hover:underline break-words" to={`${projectPath}/segments/${encodeURIComponent(shot.sceneId)}`}>{shot.shotId}</Link>
                      : <span className="break-words">{shot.shotId}</span>}
                    <span>{formatTimecode(shot.startSeconds)}–{formatTimecode(shot.endSeconds)} · {shot.durationSeconds}s</span>
                  </div>
                  <p className="text-xs text-port-text-muted break-words">Scene ID: {shot.sceneId}</p>
                  {scene ? <p className="break-words">{scene.intent}</p>
                    : <p className="text-port-warning">Scene missing. Save a revised treatment to repair this shot.</p>}
                </li>;
              })}
            </ol>
          </section>
          <section aria-labelledby="video-artifact-references" className="space-y-2">
            <h3 id="video-artifact-references" className="font-medium">Saved references ({artifact.references.length})</h3>
            <p className="text-sm text-port-text-muted">References belong to this artifact revision. Source revision stamps are checked against this install. Older references or sources without revision metadata have unknown freshness.</p>
            {!artifact.references.length && <p className="text-sm">No attached sources in this revision.</p>}
            <ul className="space-y-2">
              {artifact.references.map(reference => {
                const status = sourceState?.artifact.find(source => source.referenceId === reference.referenceId);
                const available = status?.available;
                const sourcePath = reference.kind === 'universe' ? `/universes/${encodeURIComponent(reference.id)}`
                  : reference.kind === 'series' ? `/pipeline/series/${encodeURIComponent(reference.id)}` : null;
                return <li key={reference.referenceId} className="bg-port-card border border-port-border rounded p-3 text-sm space-y-1 break-words">
                  <p>{reference.kind}: {reference.id}</p>
                  <p className="text-xs text-port-text-muted">Reference ID: {reference.referenceId}</p>
                  <p>Source revision: {reference.revision || 'Not recorded'}</p>
                  <p className={available === false ? 'text-port-warning' : 'text-port-text-muted'}>
                    {available === true ? 'Source available'
                      : available === false ? 'Source missing — repair the draft and save a revised treatment' : 'Source availability unknown'}
                  </p>
                  {available && <p className={status?.revisionChanged ? 'text-port-warning' : 'text-port-text-muted'}>
                    {status?.revisionChanged === true ? 'Source changed since this artifact was saved. Review the source and save a revised treatment before production.'
                      : status?.revisionChanged === false ? 'Source revision stamp matches the saved artifact' : 'Source revision freshness unknown. Review the source before saving a revised treatment.'}
                  </p>}
                  {sourcePath && <Link className="text-port-accent hover:underline" to={sourcePath}>Open {reference.kind}</Link>}
                </li>;
              })}
            </ul>
          </section>
        </>
      )}
      <section aria-labelledby="video-artifact-tools" className="space-y-2">
        <h3 id="video-artifact-tools" className="font-medium">Tool summaries</h3>
        {!project.plan?.steps?.length && <p className="text-sm text-port-text-muted">No tool plan saved.</p>}
        <ul className="space-y-2">
          {(project.plan?.steps || []).map(step => {
            const resultLink = stepResultLink(step);
            return <li key={step.stepId} className="bg-port-card border border-port-border rounded p-3 text-sm space-y-1 break-words">
              <p>{step.toolName} · {PLAN_STEP_STATUS_META[step.status || 'pending']?.label || 'Unknown status'}</p>
              <p className="text-xs text-port-text-muted">Step ID: {step.stepId}</p>
              {step.dependsOn?.length > 0 && <p>Depends on: {step.dependsOn.join(', ')}</p>}
              {resultLink && <Link className="text-port-accent hover:underline" to={resultLink.to}>{resultLink.label}</Link>}
            </li>;
          })}
        </ul>
      </section>
    </div>
  );
}
