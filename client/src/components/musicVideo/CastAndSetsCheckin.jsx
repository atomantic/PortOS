import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { castSetsInspectionBlockers, castSetsInspectionInputs, currentCastSetsInspection } from '../../../../server/lib/musicVideo/musicVideoCastSetsInspection.js';
import { castAndSetsGreyboxPending, musicVideoGreyboxReference } from '../../../../server/lib/musicVideo/musicVideoGreybox.js';
import useMusicVideoGreyboxPlaces from '../../hooks/useMusicVideoGreyboxPlaces.js';
import { staleApprovalText } from '../../lib/musicVideoStages.js';
import { formatCount } from '../../utils/formatters.js';
import CastAndSetsActionBar from './CastAndSetsActionBar.jsx';
import CastAndSetsBanners, { CastAndSetsStatus } from './CastAndSetsBanners.jsx';
import CastAndSetsFeedback from './CastAndSetsFeedback.jsx';
import CastAndSetsReferenceProgress from './CastAndSetsReferenceProgress.jsx';
import SceneGreyboxReference from './SceneGreyboxReference.jsx';
import { bareButtonClass as buttonClass } from './controlClasses.js';

const WORKING = new Set(['directing', 'imaging', 'assembling']);
const REVIEWABLE = new Set(['review', 'approved']);

function greyboxNeedsRender(project, stage, sets, greyboxPlaces) {
  const needsLegacyCaptures = stage.greyboxPending && (!Array.isArray(stage.greyboxPendingSetIds) || stage.greyboxLegacyPendingSetIds?.length);
  const liveCaptures = needsLegacyCaptures
    ? Object.fromEntries(sets.filter((set) => set.setReference?.greyboxShotId).map((set) => [set.id, musicVideoGreyboxReference(project, { setReference: set.setReference }, greyboxPlaces)?.reference?.imageId || null])) : {};
  return castAndSetsGreyboxPending(stage, liveCaptures);
}

function CastAndSetsGreyboxes({ project, sets, greyboxPlaces, greyboxesOpen, setGreyboxesOpen, busy, onEditDirection }) {
  const hasGreyboxChoices = (project.concept?.subjects || []).some((s) => s.kind === 'place' && s.ingredientId) || sets.some((s) => s.setReference);
  if (!onEditDirection || !sets.length || !hasGreyboxChoices) return null;
  return (
    <details open={greyboxesOpen} onToggle={(e) => setGreyboxesOpen(e.currentTarget.open)} className="rounded border border-port-border p-2">
      <summary className="min-h-[44px] cursor-pointer text-xs font-medium">Greybox references (optional)</summary>
      <p className="mb-2 text-xs text-port-text-muted">Choose a saved camera only if you want it to guide a set plate.</p>
      <div className="space-y-2">
        {sets.map((set) => (
          <div key={set.id} className="space-y-1">
            <p className="text-xs font-medium">Set plate · {set.name}</p>
            <SceneGreyboxReference project={project} scene={{ sceneId: `plate-${set.id}`, setReference: set.setReference }} places={greyboxPlaces} disabled={busy}
              onChange={async (setReference) => Boolean(await onEditDirection({ sets: [{ id: set.id, setReference }] }))} />
          </div>
        ))}
      </div>
    </details>
  );
}

function VisionRetryNotice({ uncheckedKeys, busy, onReinspectImages }) {
  if (uncheckedKeys.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-port-warning/60 p-2" role="status">
      <p className="min-w-0 flex-1 text-xs text-port-warning">{formatCount(uncheckedKeys.length)} images weren&apos;t checked by vision.</p>
      <button type="button" disabled={busy} onClick={() => onReinspectImages(uncheckedKeys)} className={`${buttonClass} border border-port-border`}>
        <RotateCcw size={14} aria-hidden="true" /> Retry vision on all
      </button>
    </div>
  );
}

function referenceActions(project, stage, working, feedbackPending, busy, images) {
  const { onRegenerateImages, onEditDirection, onUseImage, onEditImage, onAcceptImageEdit, onDiscardImageEdit, onRefresh } = images;
  if (working || feedbackPending || !stage.direction || stage.status === 'skipped' || !onRegenerateImages || !onEditDirection) return null;
  // Mirrors the server's formSubjects: catalog-linked characters outside Cast & Sets' own `cs-` subjects.
  const formSubjects = (project.concept?.subjects || []).filter((s) => s?.kind === 'character' && s.ingredientId && !String(s.id || '').startsWith('cs-'));
  return { projectId: project.id, busy, formSubjects, onRegenerate: onRegenerateImages, onEdit: onEditDirection, onUseImage, onEditImage, onAcceptImageEdit, onDiscardImageEdit, onRefresh };
}

function CheckinFeedback({ stage, working, feedbackPending, busy, feedbackActions }) {
  if (!stage.direction || working) return null;
  if (!REVIEWABLE.has(stage.status) && !stage.feedback?.length && !Object.values(stage.keyNotes || {}).some((notes) => notes.length) && !feedbackPending) return null;
  return <CastAndSetsFeedback stage={stage} busy={busy} {...feedbackActions} allowApply={Boolean(feedbackActions.onApply) && REVIEWABLE.has(stage.status)} />;
}

/**
 * The Cast & Sets check-in's state on the Autopilot card: progress while the
 * server works, "Waiting for your check-in" with the sheet one click away,
 * and the director's actions (Approve & continue, Regenerate,
 * Edit direction on a procedural sheet, Resume, Skip). An approved sheet whose
 * concept, style, subjects or song changed since (`readiness.stale`, from the server's
 * readiness) says what changed and, right under that line, offers Keep approved
 * and Rebuild side by side, each saying what it does, then each Revert (#10141).
 * A sheet built before the director's latest story or guides (`readiness.storyStale`) says so and offers Rebuild from story.
 * Casting changes since the build (from
 * useMusicVideoCastingChanges) are named too: new reference images offer
 * Update to re-render those images and their dependents, a newly linked
 * character with no sheet offers to add them through a direction note.
 * A failed Casting read says so with a Retry and keeps
 * the last notice rather than reading as "nothing changed".
 * Images vision never answered for offer Retry vision, one card at a time or all
 * at once (#14794).
 * Each image card carries its own Regenerate / Edit / Remove while the stage
 * is idle, and Start over clears a check-in that has not been approved.
 * A sheet in review (or approved) takes plain-text feedback below the actions.
 */
export default function CastAndSetsCheckin({
  id, project, busy, readiness = {}, casting = {}, sheetActions = {}, imageActions = {}, feedbackActions = {},
}) {
  const [greyboxesOpen, setGreyboxesOpen] = useState(() => (project.castAndSets?.direction?.sets || []).some((set) => set.setReference?.greyboxShotId));
  const greyboxPlaces = useMusicVideoGreyboxPlaces(project);
  const stage = project.castAndSets;
  if (!stage) return null;
  const working = WORKING.has(stage.status) && !stage.interrupted;
  const feedbackPending = !!stage.feedbackRenderPlan;
  const queuedImages = stage.queuedImagesToCheck ?? Object.values(stage.images || {}).filter((image) => image.status === 'queued' && image.jobId).length;
  const sets = stage.direction?.sets || [];
  const greyboxPending = greyboxNeedsRender(project, stage, sets, greyboxPlaces);
  const inspectionPending = castSetsInspectionBlockers(stage).length > 0;
  const staleText = stage.status === 'approved' ? staleApprovalText(readiness.stale) : null;
  const { onEditDirection, onOpenPreview, onAcknowledgeImage, onReinspectImages, onRegenerateImages } = imageActions;
  const reviewable = REVIEWABLE.has(stage.status);
  // Images vision never answered for (provider down, incomplete reply) can be checked again (#14794).
  const canRetryVision = !!onReinspectImages && !working && !feedbackPending && reviewable;
  const uncheckedKeys = canRetryVision ? Object.keys(stage.plan || {}).filter((key) => castSetsInspectionInputs(stage, key)
    && !['pass', 'mismatch'].includes(currentCastSetsInspection(stage, key)?.verdict)) : [];
  return (
    <div id={id} tabIndex={-1} style={{ scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' }} className={`rounded-lg border bg-port-card p-3 space-y-2 ${stage.status === 'review' ? 'border-port-warning/60' : 'border-port-border'}`} aria-label="Cast & Sets check-in">
      <p className="text-xs text-port-text-muted">Generated check-in evidence records what this production run rendered. These saved images and their submitted inputs do not follow later catalog edits. Use Catalog-linked look above for the current cast, environments and objects.</p>
      <CastAndSetsStatus project={project} stage={stage} staleText={staleText} feedbackPending={feedbackPending} queuedImages={queuedImages} />
      <CastAndSetsBanners stage={stage} readiness={readiness} staleText={staleText} casting={casting} working={working}
        feedbackPending={feedbackPending} busy={busy} sheetActions={sheetActions} onRegenerateImages={onRegenerateImages} />
      {reviewable && !feedbackPending && (
        <CastAndSetsGreyboxes project={project} sets={sets} greyboxPlaces={greyboxPlaces} greyboxesOpen={greyboxesOpen}
          setGreyboxesOpen={setGreyboxesOpen} busy={busy} onEditDirection={onEditDirection} />
      )}
      <VisionRetryNotice uncheckedKeys={uncheckedKeys} busy={busy} onReinspectImages={onReinspectImages} />
      {greyboxPending && <p role="status" className="text-xs text-port-warning">Greybox selection saved. Regenerate to render the set plates with it.</p>}
      <CastAndSetsReferenceProgress stage={stage} onOpenPreview={onOpenPreview} onAcknowledgeImage={feedbackPending ? null : onAcknowledgeImage}
        onReinspectImage={canRetryVision ? (key) => onReinspectImages([key]) : null} busy={busy}
        subjects={project.concept?.subjects || []} olderLookKeys={(casting.changes?.images || []).map((i) => i.key)}
        actions={referenceActions(project, stage, working, feedbackPending, busy, imageActions)} />
      <CastAndSetsActionBar project={project} stage={stage} busy={busy} working={working} feedbackPending={feedbackPending}
        queuedImages={queuedImages} staleText={staleText} approvalBlocked={greyboxPending || inspectionPending} sheetActions={sheetActions} onEditDirection={onEditDirection} />
      <CheckinFeedback stage={stage} working={working} feedbackPending={feedbackPending} busy={busy} feedbackActions={feedbackActions} />
    </div>
  );
}
