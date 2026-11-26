import { RotateCcw, Users } from 'lucide-react';
import Pill from '../ui/Pill.jsx';
import LlmRouteNote from './LlmRouteNote.jsx';
import StaleApprovalActions from './StaleApprovalActions.jsx';
import { changedFieldsText } from '../../lib/musicVideoStages.js';
import { formatCount } from '../../utils/formatters.js';
import { bareButtonClass as buttonClass } from './controlClasses.js';

export const REBUILD_TITLE = "Build a new sheet; the earlier one stays in the sheet's version history";
function progress(stage) {
  const images = Object.values(stage.images || {});
  const keys = Object.keys(stage.plan || {});
  const done = images.filter((img) => img.status === 'done').length;
  return keys.length ? `${done} of ${keys.length} reference images` : '';
}

function statusLine(stage) {
  if (stage.interrupted) return 'Interrupted by a restart — resume to continue.';
  if (stage.feedbackRenderPlan?.phase === 'planning' && stage.status !== 'failed') return 'Preparing the feedback plan — no images are being rendered.';
  if (stage.status === 'review' && stage.feedbackRenderPlan) return 'Feedback planned — images are waiting for your decision.';
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

export function CastAndSetsStatus({ project, stage, staleText, feedbackPending, queuedImages }) {
  const tone = stage.status === 'review' || staleText ? 'warning' : stage.status === 'approved' ? 'success' : stage.status === 'failed' ? 'error' : 'muted';
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Users size={14} className="text-port-accent shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium">Cast &amp; Sets check-in</span>
        <Pill size="xs" tone={tone}>{stage.interrupted ? 'interrupted' : staleText ? 'approved · stale' : stage.status}</Pill>
        {stage.revision > 1 && <span className="text-[11px] text-port-text-muted">revision {stage.revision}</span>}
        <LlmRouteNote route={project.automation?.routes?.castAndSets} prefix="Direction ran on" />
      </div>
      <p className={`text-xs ${stage.status === 'review' ? 'text-port-warning' : 'text-port-text-muted'}`} role="status">{statusLine(stage)}</p>
      {(stage.interrupted || stage.status === 'failed') && <p className="text-xs text-port-text-muted">{feedbackPending
        ? 'Resume retries feedback planning without rendering images. Whole-sheet planning may call the direction provider and incur a charge.'
        : queuedImages ? 'Checking jobs also resumes planning. It may call the direction AI provider (price unavailable); no new images start before the plan is reviewed.'
          : 'Resume prepares remaining images for review. Direction planning may call an AI provider and incur a charge.'}</p>}
    </>
  );
}

export default function CastAndSetsBanners({ stage, readiness, staleText, casting, working, feedbackPending, busy, sheetActions, onRegenerateImages }) {
  const { stale, storyStale } = readiness;
  const { changes: castingChanges, loadError: castingChangesError, retry: onRetryCastingChanges } = casting;
  const { onReconfirm, onRevert, onRebuild, onRebuildFromStory, onRegenerateWithNotes } = sheetActions;
  return (
    <>
      {staleText && <p className="text-xs text-port-warning">{staleText}</p>}
      {staleText && (
        <StaleApprovalActions revertible={stale?.revertible} busy={busy} onKeep={onReconfirm} onRevert={onRevert}
          keepHint="Use these images as they are."
          alternative={onRebuild && !working ? { label: 'Rebuild', hint: 'Redo the direction from the current inputs and re-render what changes. Faces can drift.', onClick: onRebuild, title: REBUILD_TITLE } : null}
          keepTitle="Keep this sheet approved on the current concept, style, subjects and song" />
      )}
      {storyStale && !working && !feedbackPending && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-port-warning/60 p-2">
          <p className="min-w-0 flex-1 text-xs text-port-warning">Built before your latest {changedFieldsText(storyStale.changedFields)}. Rebuild to cast and set it from them.</p>
          <button type="button" disabled={busy} onClick={onRebuildFromStory} className={`${buttonClass} border border-port-border`}>
            <RotateCcw size={14} aria-hidden="true" /> Rebuild from story
          </button>
        </div>
      )}
      {castingChanges && !working && !feedbackPending && (
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
    </>
  );
}
