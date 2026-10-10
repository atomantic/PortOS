import { CheckCircle2, Eye, Play, RotateCcw, SkipForward, Users } from 'lucide-react';
import LlmRouteNote from './LlmRouteNote.jsx';
import Pill from '../ui/Pill.jsx';
import { staleApprovalText } from '../../lib/musicVideoStages.js';
import CastAndSetsDirectionEditor from './CastAndSetsDirectionEditor.jsx';
import CastAndSetsReferenceProgress from './CastAndSetsReferenceProgress.jsx';

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
 * and the director's actions (Approve & continue, Regenerate,
 * Edit direction on a procedural sheet, Resume, Skip). An approved sheet whose
 * concept, style, subjects or song changed since (`stale`, from the server's
 * readiness) says what changed and offers Keep approved beside Rebuild (#10141).
 */
export default function CastAndSetsCheckin({ id, project, stale = null, busy, onOpenSheet, onApprove, onRegenerate, onEditDirection, onResume, onRebuild, onReconfirm, onRevert, onSkip }) {
  const stage = project.castAndSets;
  if (!stage) return null;
  const working = WORKING.has(stage.status) && !stage.interrupted;
  const sheet = stage.artifactId ? (project.devArtifacts || []).find((a) => a.id === stage.artifactId && !a.deleted) : null;
  const openNotes = (sheet?.notes || []).filter((n) => !n.resolvedAt).length;
  const staleText = stage.status === 'approved' ? staleApprovalText(stale) : null;
  const tone = stage.status === 'review' || staleText ? 'warning' : stage.status === 'approved' ? 'success' : stage.status === 'failed' ? 'error' : 'muted';
  return (
    <div id={id} tabIndex={-1} style={{ scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' }} className={`rounded-lg border bg-port-card p-3 space-y-2 ${stage.status === 'review' ? 'border-port-warning/60' : 'border-port-border'}`} aria-label="Cast & Sets check-in">
      <div className="flex flex-wrap items-center gap-2">
        <Users size={14} className="text-port-accent shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium">Cast &amp; Sets check-in</span>
        <Pill size="xs" tone={tone}>{stage.interrupted ? 'interrupted' : staleText ? 'approved · stale' : stage.status}</Pill>
        {stage.revision > 1 && <span className="text-[11px] text-port-text-muted">revision {stage.revision}</span>}
        <LlmRouteNote route={project.automation?.routes?.castAndSets} prefix="Direction ran on" />
      </div>
      <p className={`text-xs ${stage.status === 'review' ? 'text-port-warning' : 'text-port-text-muted'}`} role="status">{statusLine(stage)}</p>
      {staleText && (
        <p className="text-xs text-port-warning">
          {staleText} Keep the sheet approved as it is, or rebuild it from the current inputs.
        </p>
      )}
      {staleText && onRevert && stale?.revertible?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {stale.revertible.map((field) => (
            <button key={field} type="button" disabled={busy} onClick={() => onRevert(field)} title="Put this back to the value you approved"
              className={`${buttonClass} border border-port-border`}>
              <RotateCcw size={14} aria-hidden="true" /> Revert {field}
            </button>
          ))}
        </div>
      )}
      <CastAndSetsReferenceProgress stage={stage} />
      <div className="flex flex-wrap gap-2">
        {sheet && (
          <button type="button" onClick={() => onOpenSheet(sheet.id)} className={`${buttonClass} border border-port-border`}>
            <Eye size={14} aria-hidden="true" /> Open sheet{openNotes ? ` (${openNotes} note${openNotes === 1 ? '' : 's'})` : ''}
          </button>
        )}
        {stage.status === 'review' && (
          <>
            <button type="button" disabled={busy} onClick={onRegenerate} title={openNotes ? 'Re-render what your notes touch' : 'Re-render every image — or add a note on the sheet to change just one'}
              className={`${buttonClass} border border-port-border`}>
              <RotateCcw size={14} aria-hidden="true" /> {openNotes ? 'Regenerate with notes' : 'Regenerate'}
            </button>
            {onEditDirection && stage.direction?.medium === 'procedural' && (
              <CastAndSetsDirectionEditor key={stage.revision} project={project} direction={stage.direction} busy={busy} onSave={onEditDirection} />
            )}
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
        {staleText && onReconfirm && (
          <button type="button" disabled={busy} onClick={onReconfirm} title="Keep this sheet approved on the current concept, style, subjects and song"
            className={`${buttonClass} border border-port-border`}>
            <CheckCircle2 size={14} aria-hidden="true" /> Keep approved
          </button>
        )}
        {onRebuild && ['approved', 'skipped'].includes(stage.status) && (
          <button type="button" disabled={busy} onClick={onRebuild} title="Build a new sheet; the earlier one stays in the sheet's version history"
            className={`${buttonClass} border border-port-border`}>
            <RotateCcw size={14} aria-hidden="true" /> Rebuild
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
