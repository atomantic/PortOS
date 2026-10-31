import useMusicVideoGreyboxPlaces from '../../hooks/useMusicVideoGreyboxPlaces.js';
import SceneGreyboxReference from './SceneGreyboxReference.jsx';
import { useState } from 'react';
import { CheckCircle2, Eye, Play, RotateCcw, SkipForward, Trash2, Users } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import LlmRouteNote from './LlmRouteNote.jsx';
import Pill from '../ui/Pill.jsx';
import { changedFieldsText, staleApprovalText } from '../../lib/musicVideoStages.js';
import { formatCount } from '../../utils/formatters.js';
import CastAndSetsDirectionEditor from './CastAndSetsDirectionEditor.jsx';
import CastAndSetsFeedback from './CastAndSetsFeedback.jsx';
import CastAndSetsReferenceProgress from './CastAndSetsReferenceProgress.jsx';
import StaleApprovalActions from './StaleApprovalActions.jsx';

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

// The changed images plus every image conditioned on them: what a keyed regenerate renders.
function withDependents(plan, keys) {
  const out = new Set(keys);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of Object.values(plan || {})) {
      if (!out.has(item.key) && (item.deps || []).some((d) => out.has(d))) { out.add(item.key); grew = true; }
    }
  }
  return out.size;
}

// A linked character with no sheet needs the direction revised (a note, so a
// production run's check-in and standing feedback both carry over); changed
// images only a re-render of those images and what depends on them.
function CastingChangesNotice({ changes, plan, busy, rebuildOffered, onUpdate, onAddCast }) {
  const images = changes.images || [];
  const cast = changes.cast || [];
  const lines = [
    images.length > 0 && `New Casting images for ${changedFieldsText(images.map((i) => i.label))}.`,
    cast.length > 0 && `${changedFieldsText(cast)} ${cast.length === 1 ? 'is' : 'are'} linked in Casting but ${cast.length === 1 ? 'has' : 'have'} no sheet yet.`,
  ].filter(Boolean);
  const note = `Add ${cast.join(', ')} to the cast from Casting, each with a cast sheet.`;
  const renders = withDependents(plan, images.map((i) => i.key));
  // Rebuild from story (offered above for the story) also casts them and re-renders with the new images.
  const action = rebuildOffered ? null : cast.length
    ? onAddCast && { label: `Add ${cast.length === 1 ? cast[0] : `${formatCount(cast.length)} cast`} to the sheet`, title: `Revises the direction with the note "${note}" and renders what changed`, onClick: () => onAddCast([{ text: note }]) }
    : onUpdate && { label: `Update ${renders === 1 ? '1 image' : `${formatCount(renders)} images`}`, title: 'Re-renders the images whose Casting references changed, and the images built on them', onClick: () => onUpdate(images.map((i) => i.key)) };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-port-warning/60 p-2" role="status">
      <p className="min-w-0 flex-1 text-xs text-port-warning">Casting changed since this sheet was built. {lines.join(' ')}</p>
      {action && (
        <button type="button" disabled={busy} onClick={action.onClick} title={action.title} className={`${buttonClass} border border-port-border`}>
          <RotateCcw size={14} aria-hidden="true" /> {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * The Cast & Sets check-in's state on the Autopilot card: progress while the
 * server works, "Waiting for your check-in" with the sheet one click away,
 * and the director's actions (Approve & continue, Regenerate,
 * Edit direction on a procedural sheet, Resume, Skip). An approved sheet whose
 * concept, style, subjects or song changed since (`stale`, from the server's
 * readiness) says what changed and offers Keep approved beside each Revert,
 * right under that line (#10141). A sheet built before the director's latest
 * story or guides (`storyStale`) says so and offers Rebuild from story.
 * Casting changes since the build (`castingChanges`, from
 * useMusicVideoCastingChanges) are named too: new reference images offer
 * Update to re-render those images and their dependents, a newly linked
 * character with no sheet offers to add them through a direction note.
 * A failed Casting read says so with a Retry (`castingChangesError`) and keeps
 * the last notice rather than reading as "nothing changed".
 * Each image card carries its own Regenerate / Edit / Remove while the stage
 * is idle, and Start over clears a check-in that has not been approved.
 * A sheet in review (or approved) takes plain-text feedback below the actions.
 */
export default function CastAndSetsCheckin({ id, project, stale = null, storyStale = null, castingChanges = null, castingChangesError = false, onRetryCastingChanges, busy, onOpenSheet, onOpenPreview, onApprove, onRegenerate, onRegenerateImages, onEditDirection, onRefresh, onApplyFeedback, onRemoveFeedback, onRegenerateWithNotes, onResume, onRebuild, onReconfirm, onRevert, onSkip, onDiscard, onRebuildFromStory }) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const greyboxPlaces = useMusicVideoGreyboxPlaces(project);
  const stage = project.castAndSets;
  // Mirrors the server's formSubjects: catalog-linked characters outside Cast & Sets' own `cs-` subjects.
  const formSubjects = (project.concept?.subjects || []).filter((s) => s?.kind === 'character' && s.ingredientId && !String(s.id || '').startsWith('cs-'));
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
      {staleText && (
        <StaleApprovalActions revertible={stale?.revertible} busy={busy} onKeep={onReconfirm} onRevert={onRevert}
          keepTitle="Keep this sheet approved on the current concept, style, subjects and song" />
      )}
      {storyStale && !working && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-port-warning/60 p-2">
          <p className="min-w-0 flex-1 text-xs text-port-warning">Built before your latest {changedFieldsText(storyStale.changedFields)}. Rebuild to cast and set it from them.</p>
          <button type="button" disabled={busy} onClick={onRebuildFromStory} className={`${buttonClass} border border-port-border`}>
            <RotateCcw size={14} aria-hidden="true" /> Rebuild from story
          </button>
        </div>
      )}
      {castingChanges && !working && (
        <CastingChangesNotice changes={castingChanges} plan={stage.plan} busy={busy} rebuildOffered={!!storyStale}
          onUpdate={onRegenerateImages} onAddCast={onRegenerateWithNotes} />
      )}
      {castingChangesError && !working && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-port-border p-2" role="status">
          <p className="min-w-0 flex-1 text-xs text-port-text-muted">Couldn&apos;t check Casting for changes since this sheet was built.</p>
          <button type="button" onClick={onRetryCastingChanges} className={`${buttonClass} border border-port-border`}>
            <RotateCcw size={14} aria-hidden="true" /> Retry
          </button>
        </div>
      )}
      {['review', 'approved'].includes(stage.status) && onEditDirection && (stage.direction?.sets || []).map((set) => (
        <div key={set.id} className="space-y-1">
          <p className="text-xs font-medium">Set plate · {set.name}</p>
          <SceneGreyboxReference project={project} scene={{ sceneId: `plate-${set.id}`, setReference: set.setReference }} places={greyboxPlaces} disabled={busy}
            onChange={(setReference) => onEditDirection({ sets: [{ id: set.id, setReference }] })} />
        </div>
      ))}
      {stage.greyboxPending && <p role="status" className="text-xs text-port-warning">Greybox selection saved. Regenerate to render the set plates with it.</p>}
      <CastAndSetsReferenceProgress stage={stage} onOpenPreview={onOpenPreview}
        subjects={project.concept?.subjects || []} olderLookKeys={(castingChanges?.images || []).map((i) => i.key)}
        actions={!working && stage.direction && stage.status !== 'skipped' && onRegenerateImages && onEditDirection
          ? { projectId: project.id, busy, formSubjects, onRegenerate: onRegenerateImages, onEdit: onEditDirection, onRefresh } : null} />
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
            <button type="button" disabled={busy || stage.greyboxPending} onClick={onApprove} className={`${buttonClass} bg-port-accent text-white`}>
              <CheckCircle2 size={14} aria-hidden="true" /> Approve &amp; continue
            </button>
          </>
        )}
        {(stage.interrupted || stage.status === 'failed') && (
          <button type="button" disabled={busy} onClick={onResume} className={`${buttonClass} border border-port-border`}>
            <Play size={14} aria-hidden="true" /> Resume
          </button>
        )}
        {onRebuild && ['approved', 'skipped'].includes(stage.status) && (
          <button type="button" disabled={busy} onClick={onRebuild} title="Build a new sheet; the earlier one stays in the sheet's version history"
            className={`${buttonClass} border border-port-border`}>
            <RotateCcw size={14} aria-hidden="true" /> Rebuild
          </button>
        )}
        {onDiscard && !working && stage.status !== 'approved' && (confirmDiscard ? (
          <ConfirmButtonPair prompt="Clear every cast and set image from this check-in?" confirmText="Start over" busy={busy} responsiveTouchTargets
            ariaLabel="Start Cast & Sets over" confirmAriaLabel="Start Cast & Sets over" onConfirm={async () => { if (await onDiscard()) setConfirmDiscard(false); }} onCancel={() => setConfirmDiscard(false)} />
        ) : (
          <button type="button" disabled={busy} onClick={() => setConfirmDiscard(true)}
            title="Clear this check-in so you can set up the story and guides first; the images stay in your gallery"
            className={`${buttonClass} border border-port-border`}>
            <Trash2 size={14} aria-hidden="true" /> Start over
          </button>
        ))}
        {!working && !['approved', 'skipped'].includes(stage.status) && (
          <button type="button" disabled={busy} onClick={onSkip} className={`${buttonClass} text-port-text-muted`}>
            <SkipForward size={14} aria-hidden="true" /> Skip check-in
          </button>
        )}
      </div>
      {onApplyFeedback && stage.direction && !working && ['review', 'approved'].includes(stage.status) && (
        <CastAndSetsFeedback stage={stage} busy={busy} onApply={onApplyFeedback} onRemove={onRemoveFeedback} />
      )}
    </div>
  );
}
