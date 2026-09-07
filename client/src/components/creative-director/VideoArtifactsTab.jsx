import { Link } from 'react-router';
import { formatTimecode } from '../../utils/formatters.js';
import { PLAN_STEP_STATUS_META, stepResultLink } from '../../lib/creativeDirectorPlan.js';

export default function VideoArtifactsTab({ project, basePath }) {
  const treatment = project.treatment;
  const artifact = treatment?.artifact;
  const projectPath = `${basePath}/${encodeURIComponent(project.id)}`;
  const scenes = new Map((treatment?.scenes || []).map(scene => [scene.sceneId, scene]));

  return (
    <div className="max-w-4xl space-y-4">
      <h2 className="text-lg font-medium">Production artifacts</h2>
      <p className="text-sm text-port-text-muted">Saved planning artifacts. Production remains blocked until revision approvals and dispatch controls are available.</p>
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
            <p className="text-sm text-port-text-muted">References belong to this artifact revision. Source availability has not been checked.</p>
            {!artifact.references.length && <p className="text-sm">No attached sources in this revision.</p>}
            <ul className="space-y-2">
              {artifact.references.map(reference => {
                const sourcePath = reference.kind === 'universe' ? `/universes/${encodeURIComponent(reference.id)}`
                  : reference.kind === 'series' ? `/pipeline/series/${encodeURIComponent(reference.id)}` : null;
                return <li key={reference.referenceId} className="bg-port-card border border-port-border rounded p-3 text-sm space-y-1 break-words">
                  <p>{reference.kind}: {reference.id}</p>
                  <p className="text-xs text-port-text-muted">Reference ID: {reference.referenceId}</p>
                  <p>Source revision: {reference.revision || 'Not recorded'}</p>
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
