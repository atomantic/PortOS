import { Link } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { updateCreativeDirectorProject } from '../../services/apiCreativeDirector.js';
import toast from '../ui/Toast';

export default function OverviewTab({ project, onProjectUpdate }) {
  const [disableAudio, setDisableAudio] = useState(project.disableAudio === true);
  const [saving, setSaving] = useState(false);
  // Track the project id this tab is currently mounted for. If the user
  // toggles audio and navigates to a different CD project before the PATCH
  // resolves, the late `.then()` would otherwise call onProjectUpdate on
  // the now-different project and silently overwrite its local state.
  // We also reset `saving` on project switch — otherwise the new project
  // inherits the stuck-true flag (the prior project's PATCH cleanup is
  // gated on the old id and never runs the .finally for this instance),
  // leaving the new project's audio checkbox permanently disabled.
  const projectIdRef = useRef(project.id);
  // Guards prop-driven resets while a PATCH is in flight. A stale poll
  // response arriving before the PATCH resolves would otherwise call
  // setSaving(false) and roll back the optimistic toggle.
  const savingRef = useRef(false);
  useEffect(() => {
    projectIdRef.current = project.id;
    setDisableAudio(project.disableAudio === true);
    setSaving(false);
    savingRef.current = false;
  }, [project.id]);
  useEffect(() => {
    if (!savingRef.current) {
      setDisableAudio(project.disableAudio === true);
    }
  }, [project.disableAudio]);

  const handleAudioToggle = (e) => {
    const next = e.target.checked;
    setDisableAudio(next);
    setSaving(true);
    savingRef.current = true;
    const requestProjectId = project.id;
    updateCreativeDirectorProject(requestProjectId, { disableAudio: next })
      .then(() => {
        if (projectIdRef.current === requestProjectId) {
          onProjectUpdate?.({ disableAudio: next });
        }
      })
      .catch((err) => {
        if (projectIdRef.current === requestProjectId) {
          setDisableAudio(!next);
        }
        toast.error(err.message || 'Failed to update audio setting');
      })
      .finally(() => {
        savingRef.current = false;
        if (projectIdRef.current === requestProjectId) {
          setSaving(false);
        }
      });
  };
  const collectionLink = `/media/collections/${project.collectionId}`;
  const final = project.finalVideoId
    ? <Link to={`/media/history?selected=${project.finalVideoId}`} className="text-port-accent">{project.finalVideoId}</Link>
    : <span className="text-port-text-muted">not yet rendered</span>;

  return (
    <div className="space-y-4 max-w-3xl">
      <section className="bg-port-card border border-port-border rounded p-4 space-y-2">
        <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide">Configuration</h2>
        <Field label="Aspect ratio" value={project.aspectRatio} />
        <Field label="Quality" value={project.quality} />
        <Field label="Model" value={project.modelId} />
        <Field label="Target duration" value={`${project.targetDurationSeconds}s (~${Math.round(project.targetDurationSeconds / 60)} min)`} />
        <Field label="Starting image" value={project.startingImageFile || '—'} />
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div className="text-port-text-muted">Audio</div>
          <div className="col-span-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={disableAudio}
                onChange={handleAudioToggle}
                disabled={saving}
                className="accent-port-accent"
              />
              <span className="text-port-text">Disable audio</span>
            </label>
            <div className="text-xs text-port-text-muted mt-1">
              Applies to future scene renders only — already-rendered scenes keep their original audio.
            </div>
          </div>
        </div>
        <Field label="Collection" value={project.collectionId ? <Link to={collectionLink} className="text-port-accent">{project.collectionId}</Link> : <span className="text-port-text-muted">—</span>} />
        <Field label="Final video" value={final} />
        {project.timelineProjectId && (
          <Field label="Timeline" value={<Link to={`/media/timeline/${project.timelineProjectId}`} className="text-port-accent">{project.timelineProjectId}</Link>} />
        )}
      </section>

      {project.styleSpec && (
        <section className="bg-port-card border border-port-border rounded p-4">
          <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide mb-2">Style spec</h2>
          <pre className="whitespace-pre-wrap text-sm text-port-text font-mono">{project.styleSpec}</pre>
        </section>
      )}

      {project.userStory && (
        <section className="bg-port-card border border-port-border rounded p-4">
          <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide mb-2">User-supplied story</h2>
          <pre className="whitespace-pre-wrap text-sm text-port-text font-mono">{project.userStory}</pre>
        </section>
      )}

      {project.failureReason && (
        <section className="bg-port-card border border-port-error rounded p-4">
          <h2 className="text-sm font-semibold text-port-error uppercase tracking-wide mb-2">Failure reason</h2>
          <p className="text-sm text-port-text break-all">{project.failureReason}</p>
        </section>
      )}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-sm">
      <div className="text-port-text-muted">{label}</div>
      <div className="col-span-2 text-port-text break-all">{value}</div>
    </div>
  );
}
