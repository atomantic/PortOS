import { useState } from 'react';
import { CheckCircle2, Eye, Play, RotateCcw, SkipForward, Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import CastAndSetsDirectionEditor from './CastAndSetsDirectionEditor.jsx';
import { REBUILD_TITLE } from './CastAndSetsBanners.jsx';
import { bareButtonClass as buttonClass } from './controlClasses.js';

export default function CastAndSetsActionBar({
  project, stage, busy, working, feedbackPending, queuedImages, staleText, approvalBlocked, sheetActions, onEditDirection,
}) {
  const { onOpenSheet, onRegenerate, onApprove, onResume, onRebuild, onDiscard, onSkip } = sheetActions;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const sheet = stage.artifactId ? (project.devArtifacts || []).find((a) => a.id === stage.artifactId && !a.deleted) : null;
  const openNotes = (sheet?.notes || []).filter((n) => !n.resolvedAt).length;
  return (
    <div className="flex flex-wrap gap-2">
      {sheet && (
        <button type="button" onClick={() => onOpenSheet(sheet.id)} className={`${buttonClass} border border-port-border`}>
          <Eye size={14} aria-hidden="true" /> Open sheet{feedbackPending ? ' (previous revision)' : ''}{openNotes ? ` (${openNotes} note${openNotes === 1 ? '' : 's'})` : ''}
        </button>
      )}
      {stage.status === 'review' && !feedbackPending && (
        <>
          <button type="button" disabled={busy} onClick={onRegenerate} title={openNotes ? 'Re-render what your notes touch' : 'Re-render every image — or add a note on the sheet to change just one'}
            className={`${buttonClass} border border-port-border`}>
            <RotateCcw size={14} aria-hidden="true" /> {openNotes ? 'Regenerate with notes' : 'Regenerate'}
          </button>
          {onEditDirection && stage.direction && (
            <CastAndSetsDirectionEditor key={stage.revision} project={project} direction={stage.direction} busy={busy} onSave={onEditDirection} />
          )}
          <button type="button" disabled={busy || approvalBlocked} onClick={onApprove} className={`${buttonClass} bg-port-accent text-white`}>
            <CheckCircle2 size={14} aria-hidden="true" /> Approve &amp; continue
          </button>
        </>
      )}
      {(stage.interrupted || stage.status === 'failed') && (
        <button type="button" disabled={busy} onClick={onResume} className={`${buttonClass} border border-port-border`}>
          <Play size={14} aria-hidden="true" /> {queuedImages ? 'Check jobs & prepare plan' : 'Resume'}
        </button>
      )}
      {/* A stale approval offers Rebuild beside Keep approved, under the stale note. */}
      {onRebuild && ['approved', 'skipped'].includes(stage.status) && !staleText && (
        <button type="button" disabled={busy} onClick={onRebuild} title={REBUILD_TITLE}
          className={`${buttonClass} border border-port-border`}>
          <RotateCcw size={14} aria-hidden="true" /> Rebuild
        </button>
      )}
      {onDiscard && !working && stage.status !== 'approved' && (confirmDiscard ? (
        <ConfirmButtonPair prompt={feedbackPending ? 'Clear this check-in and its saved feedback? Images stay in the gallery.' : 'Clear every cast and set image from this check-in?'} confirmText="Start over" busy={busy} responsiveTouchTargets
          ariaLabel="Start Cast & Sets over" confirmAriaLabel="Start Cast & Sets over" onConfirm={async () => { if (await onDiscard()) setConfirmDiscard(false); }} onCancel={() => setConfirmDiscard(false)} />
      ) : (
        <button type="button" disabled={busy} onClick={() => setConfirmDiscard(true)}
          title="Clear this check-in so you can set up the story and guides first; the images stay in your gallery"
          className={`${buttonClass} border border-port-border`}>
          <Trash2 size={14} aria-hidden="true" /> Start over
        </button>
      ))}
      {!working && !feedbackPending && !['approved', 'skipped'].includes(stage.status) && (
        <button type="button" disabled={busy} onClick={onSkip} className={`${buttonClass} text-port-text-muted`}>
          <SkipForward size={14} aria-hidden="true" /> Skip check-in
        </button>
      )}
    </div>
  );
}
