import { CheckCircle2, Eye, Play, RotateCcw, SkipForward, Users } from 'lucide-react';
import Pill from '../ui/Pill.jsx';

const WORKING = new Set(['directing', 'imaging', 'assembling']);
const buttonClass = 'flex items-center gap-1 rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

function progress(stage) {
  const images = Object.values(stage.images || {});
  const keys = Object.keys(stage.plan || {});
  const done = images.filter((img) => img.status === 'done').length;
  return keys.length ? `${done} of ${keys.length} reference images` : '';
}

function statusLine(stage) {
  if (stage.interrupted) return 'Interrupted by a restart — resume to continue.';
  switch (stage.status) {
    case 'directing': return 'Reading the song and writing the creative direction…';
    case 'imaging': return `Rendering the cast and sets: ${progress(stage)}…`;
    case 'assembling': return 'Assembling the check-in sheet…';
    case 'review': return 'Waiting for your check-in.';
    case 'approved': return 'Approved — the references now condition the storyboard frames.';
    case 'skipped': return 'Skipped — the autopilot plans without it.';
    case 'failed': return `Stopped: ${stage.stopReason || stage.error || 'unknown error'}`;
    default: return '';
  }
}

/**
 * The Cast & Sets check-in's state on the Autopilot card: progress while the
 * server works, "Waiting for your check-in" with the sheet one click away,
 * and the director's actions (Approve & continue, Regenerate with notes,
 * Resume, Skip).
 */
export default function CastAndSetsCheckin({ project, busy, onOpenSheet, onApprove, onRegenerate, onResume, onSkip }) {
  const stage = project.castAndSets;
  if (!stage) return null;
  const working = WORKING.has(stage.status) && !stage.interrupted;
  const sheet = stage.artifactId ? (project.devArtifacts || []).find((a) => a.id === stage.artifactId && !a.deleted) : null;
  const openNotes = (sheet?.notes || []).filter((n) => !n.resolvedAt).length;
  const tone = stage.status === 'review' ? 'warning' : stage.status === 'approved' ? 'success' : stage.status === 'failed' ? 'error' : 'muted';
  return (
    <div className={`rounded border p-2 space-y-2 ${stage.status === 'review' ? 'border-port-warning/60' : 'border-port-border'}`} aria-label="Cast & Sets check-in">
      <div className="flex flex-wrap items-center gap-2">
        <Users size={14} className="text-port-accent shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium">Cast &amp; Sets check-in</span>
        <Pill size="xs" tone={tone}>{stage.interrupted ? 'interrupted' : stage.status}</Pill>
        {stage.revision > 1 && <span className="text-[11px] text-port-text-muted">revision {stage.revision}</span>}
      </div>
      <p className={`text-xs ${stage.status === 'review' ? 'text-port-warning' : 'text-port-text-muted'}`} role="status">{statusLine(stage)}</p>
      <div className="flex flex-wrap gap-2">
        {sheet && (
          <button type="button" onClick={() => onOpenSheet(sheet.id)} className={`${buttonClass} border border-port-border`}>
            <Eye size={14} aria-hidden="true" /> Open sheet{openNotes ? ` (${openNotes} note${openNotes === 1 ? '' : 's'})` : ''}
          </button>
        )}
        {stage.status === 'review' && (
          <>
            <button type="button" disabled={busy || !openNotes} onClick={onRegenerate} title={openNotes ? 'Re-render what your notes touch' : 'Add a note on the sheet first'}
              className={`${buttonClass} border border-port-border`}>
              <RotateCcw size={14} aria-hidden="true" /> Regenerate with notes
            </button>
            <button type="button" disabled={busy} onClick={onApprove} className={`${buttonClass} bg-port-accent text-white`}>
              <CheckCircle2 size={14} aria-hidden="true" /> Approve &amp; continue
            </button>
          </>
        )}
        {(stage.interrupted || stage.status === 'failed') && (
          <button type="button" disabled={busy} onClick={onResume} className={`${buttonClass} border border-port-border`}>
            <Play size={14} aria-hidden="true" /> Resume
          </button>
        )}
        {!working && !['approved', 'skipped'].includes(stage.status) && (
          <button type="button" disabled={busy} onClick={onSkip} className={`${buttonClass} text-port-text-muted`}>
            <SkipForward size={14} aria-hidden="true" /> Skip check-in
          </button>
        )}
      </div>
    </div>
  );
}
