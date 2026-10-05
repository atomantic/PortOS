import { useMusicVideoReviewDraft } from '../../hooks/useMusicVideoReviewDraft.js';
import DevArtifactPreview from './DevArtifactPreview.jsx';

/** Playback of the recorded animatic version does not change native readiness. */
export default function ReviewDraftPanel({ project, onOpen, draftState }) {
  const localState = useMusicVideoReviewDraft(project, { enabled: !draftState });
  const { draft, checking, unavailableCount } = draftState || localState;
  if (checking) return <p role="status">Finding an available review draft…</p>;
  if (!draft) return unavailableCount ? <p role="alert">Imported drafts are unavailable. Choose an available development file below.</p> : null;
  const artifact = project.devArtifacts.find(item => item.id === draft.artifactId);
  return <section aria-label="Imported review draft" className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-card p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">Review draft · v{draft.version}</h3>
      <button type="button" onClick={() => onOpen(draft.artifactId)} className="min-h-[44px] rounded bg-port-accent px-3 text-sm text-white">Review &amp; add notes</button>
    </div>
    <DevArtifactPreview key={draft.src} projectId={project.id} artifact={artifact} version={draft.version} />
    {unavailableCount > 0 && <p role="status" className="text-xs text-port-warning">Newer draft unavailable · showing {artifact.title} v{draft.version}.</p>}
    <p className="text-xs text-port-text-muted">Imported animatic · {draft.reviewStatus === 'approved' ? 'Draft reviewed' : draft.reviewStatus === 'changes-requested' ? 'Changes requested' : 'Pending review'}. Native storyboard and proof approvals are separate.</p>
  </section>;
}
