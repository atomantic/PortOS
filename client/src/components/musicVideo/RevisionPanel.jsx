import { RotateCcw, Play, X } from 'lucide-react';

const STATUS_LABELS = { open: 'Open', rendering: 'Rendering revised draft…', complete: 'Complete', canceled: 'Cancelled' };
const SLOT = { image: 'referenceImageId', video: 'videoHistoryId' };

// The latest revision worth showing: the active one, else the most recent.
export const currentRevision = (project) => {
  const revisions = Array.isArray(project?.revisions) ? project.revisions : [];
  return revisions.find((r) => r.status === 'open' || r.status === 'rendering') || revisions[revisions.length - 1] || null;
};

// A rejected section's live state, from the board's own record + spinners
// (the server re-derives the authoritative state on every resume).
function sectionState(section, scene, spinning) {
  if (section.verdict !== 'rejected') return { label: 'Kept', tone: 'text-port-success' };
  if (!scene) return { label: 'Scene removed', tone: 'text-port-text-muted' };
  if (scene[SLOT[section.kind]]) return { label: 'New take ready', tone: 'text-port-success' };
  if (spinning) return { label: 'Generating…', tone: 'text-port-warning' };
  return { label: 'Needs a new take', tone: 'text-port-error' };
}

/**
 * Selective section revision (#8987): the revision opened from a reviewed
 * draft — which sections were rejected (regenerated) and which were kept
 * untouched — with Resume (continue from the checkpoint: generate what still
 * lacks a take, else re-render the draft) and Cancel.
 */
export default function RevisionPanel({ project, busy, genScenes = {}, genVideoScenes = {}, onResume, onCancel }) {
  const revision = currentRevision(project);
  if (!revision) return null;
  const scenes = [...(project.scenes || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const byId = new Map(scenes.map((s, i) => [s.sceneId, { scene: s, number: i + 1 }]));
  const active = revision.status === 'open' || revision.status === 'rendering';
  const sections = Array.isArray(revision.sections) ? revision.sections : [];
  const rejected = sections.filter((s) => s.verdict === 'rejected');
  const readyCount = rejected.filter((s) => byId.get(s.sceneId)?.scene?.[SLOT[s.kind]]).length;

  return (
    <div className="rounded border border-port-border p-2 space-y-2 text-xs" aria-label="Section revision">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium flex items-center gap-1">
          <RotateCcw size={12} /> Revision {STATUS_LABELS[revision.status] ? `— ${STATUS_LABELS[revision.status]}` : ''}
          {active && <span className="text-port-text-muted">({readyCount}/{rejected.length} revised sections ready)</span>}
        </span>
        {active && (
          <div className="flex items-center gap-2">
            {revision.status === 'open' && (
              <button type="button" disabled={busy} onClick={() => onResume(revision.id)}
                className="flex items-center gap-1 text-port-accent disabled:opacity-50 min-h-[44px] sm:min-h-0">
                <Play size={12} /> {readyCount === rejected.length ? 'Render revised draft' : 'Resume'}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => onCancel(revision.id)}
              className="flex items-center gap-1 text-port-error disabled:opacity-50 min-h-[44px] sm:min-h-0">
              <X size={12} /> Cancel revision
            </button>
          </div>
        )}
      </div>
      {revision.error && active && <p role="alert" className="text-port-error">{revision.error}</p>}
      <ul className="space-y-1">
        {sections.map((section) => {
          const entry = byId.get(section.sceneId);
          const spinning = section.kind === 'image' ? genScenes[section.sceneId] : genVideoScenes[section.sceneId];
          const state = sectionState(section, entry?.scene, spinning);
          return (
            <li key={section.sceneId} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">{entry ? `Scene ${entry.number}` : section.sceneId} <span className="text-port-text-muted">({section.layer})</span></span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${section.verdict === 'rejected' ? 'bg-port-error/20 text-port-error' : 'bg-port-success/20 text-port-success'}`}>{section.verdict}</span>
              <span className={state.tone}>{state.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
