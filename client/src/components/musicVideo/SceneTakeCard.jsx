import { ArrowRightLeft, Ban, Bookmark, Check, Loader2, RotateCcw, Eye, X, MessageSquare, PencilLine } from 'lucide-react';
import { findCapturedMakingOfItem, useMakingOfCapture } from './MakingOfCaptureContext.js';
import { musicVideoRenderTierLabel } from '../../../../server/lib/musicVideo/musicVideoRenderTier.js';
import { sequenceTakeLabel, sequenceTakeSummary } from '../../../../server/lib/musicVideo/musicVideoSequenceTake.js';
import { takePreviewKey, takeThumbUrl, takeClipUrl, takeControl } from '../../lib/musicVideoTakes.js';
import { getVideoHistoryItem } from '../../services/apiImageVideo.js';
import AssetReferenceActions from '../media/AssetReferenceActions.jsx';
import { plateVerdict } from './PlateComparison.jsx';
import SceneTakeWarnings, { SceneTakeVerdict, SceneTakeVerdictIssues } from './SceneTakeWarnings.jsx';
import TakeExtend from './TakeExtend.jsx';

async function videoTakeUrl(take) {
  const record = await getVideoHistoryItem(take.assetId, { silent: true });
  const filename = record?.filename;
  if (record?.id !== take.assetId || typeof filename !== 'string' || !filename || /[/\\]/.test(filename) || filename === '.' || filename === '..') return null;
  return `/data/videos/${encodeURIComponent(filename)}`;
}

function TakeThumbnail({ take, kind, isSelected, rejected, playback, onOpenPreview }) {
  const { playingId, setPlayingId } = playback;
  const playKey = take.takeId || take.assetId;
  const playing = kind === 'video' && playingId === playKey;
  return (
    <button
      type="button"
      data-take-focus=""
      onClick={() => onOpenPreview?.(takePreviewKey(take))}
      onMouseEnter={() => setPlayingId(playKey)}
      onFocus={() => setPlayingId(playKey)}
      aria-label={`View ${kind === 'video' ? 'clip' : 'frame'} take full size`}
      className={`relative block w-full rounded overflow-hidden focus:outline-none focus:ring-2 focus:ring-port-accent ${isSelected ? 'border-2 border-port-accent ring-4 ring-port-accent/50' : 'border border-port-border'} ${rejected ? 'opacity-40' : ''}`}
    >
      <img src={takeThumbUrl(take)} alt="" loading="lazy" className="w-full aspect-video object-cover block bg-black" />
      {playing && <video src={takeClipUrl(take)} autoPlay muted loop playsInline className="absolute inset-0 w-full h-full object-cover bg-black" />}
      {/* The take the render uses wears a badge, so it reads at a glance among the others. */}
      {isSelected && (
        <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-port-accent px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
          <Check size={11} aria-hidden="true" /> In use
        </span>
      )}
      {/* #16136: a clip rendered as a draft or a final says which. */}
      {kind === 'video' && musicVideoRenderTierLabel(take.tier) && (
        <span className="port-media-overlay-strong absolute bottom-1 left-1 rounded px-1 text-[10px]" data-testid="take-tier">
          {musicVideoRenderTierLabel(take.tier)}
        </span>
      )}
    </button>
  );
}

function TakeReviewActions({ take, scene, kind, frameTake, isSelected, rejected, busy, saving, move, movable, savingMove, actions, openNote }) {
  const makingOf = useMakingOfCapture();
  if (!take.takeId) return null;
  const { onSelect, onReview, onMark, marks, onCheck, checking } = actions;
  const { moveFor, setMoveFor } = move;
  const bad = marks?.[takePreviewKey(take)] === 'bad';
  const captured = makingOf ? findCapturedMakingOfItem(makingOf.story, kind === 'video' ? 'video' : 'image', take.assetId) : null;
  const takeChecking = Boolean(checking?.has(take.takeId));
  const savingSelect = Boolean(saving?.has(takeControl.select(scene, take)));
  const savingReject = Boolean(saving?.has(takeControl.status(scene, take, 'rejected')));
  const savingRestore = Boolean(saving?.has(takeControl.status(scene, take, 'candidate')));
  const savingDecision = savingSelect || savingReject || savingRestore;
  const savingMark = Boolean(saving?.has(takeControl.mark(take)));
  return (
    <>
      {/* Use, Reject and Restore change the take at once, so the take itself says its decision is saving. */}
      {savingDecision && (
        <p role="status" className="inline-flex items-center gap-1 text-[10px] text-port-text-muted">
          <Loader2 size={10} className="animate-spin" aria-hidden="true" /> Saving…
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {!isSelected && (
          <button type="button" disabled={busy || savingSelect} onClick={() => onSelect?.(take)}
            className="inline-flex items-center gap-0.5 rounded bg-port-accent/20 text-port-accent px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
            title="Use this take for the scene">
            <Check size={11} /> Use
          </button>
        )}
        {rejected ? (
          <button type="button" disabled={busy || savingRestore} onClick={() => onReview?.(take, { status: 'candidate' })}
            className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
            title="Restore this take as a candidate">
            <RotateCcw size={11} /> Restore
          </button>
        ) : (
          <button type="button" disabled={busy || savingReject} onClick={() => { onReview?.(take, { status: 'rejected' }); openNote(take); }}
            className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
            title={isSelected ? 'Not for this shot: clears the selection so the next render fills it. Other shots can still use it.' : 'Not for this shot. Other shots can still use it.'}>
            <X size={11} /> Reject
          </button>
        )}
        {onMark && (
          <button type="button" disabled={busy || savingMark} onClick={() => onMark(take, bad ? null : 'bad')} aria-pressed={bad}
            className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50 ${bad ? 'bg-port-error/20 text-port-error' : 'bg-port-border'}`}
            title={bad ? 'Clear the bad mark' : 'Mark this file bad, to clean up when the project is done. It is also rejected on every shot not using it, and stays counted in the stats.'}>
            {savingMark ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Ban size={11} />} {savingMark ? 'Saving…' : 'Bad'}
          </button>
        )}
        {onCheck && frameTake && !rejected && (
          <button type="button" disabled={takeChecking} onClick={() => onCheck(take)}
            className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
            title={kind === 'endImage' ? 'A vision model checks this end frame against its end-frame prompt and for render defects' : 'A vision model checks this frame against the shot prompt and for render defects'}>
            {takeChecking ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Eye size={11} aria-hidden="true" />} {takeChecking ? 'Checking' : 'Check'}
          </button>
        )}
        {movable && (
          <button type="button" disabled={busy || savingMove} onClick={() => setMoveFor(moveFor === take.takeId ? null : take.takeId)}
            aria-expanded={moveFor === take.takeId}
            className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
            title="Move this take to another shot. It keeps its status and note; the files stay where they are.">
            {savingMove ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <ArrowRightLeft size={11} aria-hidden="true" />} {savingMove ? 'Moving…' : 'Move'}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => openNote(take)}
          aria-label="Edit take note"
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center rounded bg-port-border px-1.5 py-0.5 text-[10px] min-h-[32px] sm:min-h-0 disabled:opacity-50"
          title="Note what to change on the next attempt">
          <MessageSquare size={11} />
        </button>
        {makingOf && (
          <button
            type="button"
            disabled={busy}
            aria-pressed={Boolean(captured)}
            aria-label={captured ? 'Edit Making-Of item' : 'Save take to Making Of'}
            onClick={() => makingOf.openCapture({
              kind: kind === 'video' ? 'video' : 'image',
              assetId: take.assetId,
              sceneId: scene.sceneId,
              label: `${scene.label || `Shot ${(scene.order ?? 0) + 1}`} ${kind === 'video' ? 'clip' : 'frame'}`,
              role: bad || rejected ? 'fail' : isSelected ? 'final' : 'process',
              note: take.note || '',
            })}
            className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] min-h-[32px] sm:min-h-0 disabled:opacity-50 ${captured ? 'bg-port-accent/20 text-port-accent' : 'bg-port-border'}`}
            title={captured ? 'Saved in Making Of — click to edit tags or notes' : 'Save this take to Making Of'}
          >
            <Bookmark size={11} aria-hidden="true" />
          </button>
        )}
      </div>
    </>
  );
}

function TakeMovePicker({ take, scene, move, busy, savingMove }) {
  const { moveTargets, setMoveFor, onMove } = move;
  const moveInputId = `mv-take-move-${scene.sceneId}-${take.takeId}`;
  const shotName = (entry) => `Shot ${(entry.order ?? 0) + 1}${entry.label ? ` · ${entry.label}` : ''}`;
  return (
    <div>
      <label htmlFor={moveInputId} className="sr-only">Move take to shot</label>
      <select id={moveInputId} value="" disabled={busy || savingMove}
        onChange={(e) => { const to = e.target.value; if (!to) return; setMoveFor(null); onMove(take, to); }}
        className="w-full bg-port-bg border border-port-border rounded px-1 py-0.5 text-[11px] min-h-[44px] pointer-fine:sm:min-h-0">
        <option value="">Move to shot…</option>
        {moveTargets.map((entry) => <option key={entry.sceneId} value={entry.sceneId}>{shotName(entry)}</option>)}
      </select>
    </div>
  );
}

function TakeNoteInput({ take, scene, notes }) {
  const { noteDraft, setNoteDraft, noteInputRef, saveNote } = notes;
  const noteInputId = `mv-take-note-${scene.sceneId}-${take.takeId}`;
  return (
    <div>
      <label htmlFor={noteInputId} className="sr-only">Take note</label>
      <input
        ref={noteInputRef}
        id={noteInputId}
        value={noteDraft}
        maxLength={1000}
        onChange={(e) => setNoteDraft(e.target.value)}
        onBlur={() => saveNote(take)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        placeholder="What to change next time"
        className="w-full bg-port-bg border border-port-border rounded px-1 py-0.5 text-[11px] min-h-[44px] pointer-fine:sm:min-h-0"
      />
    </div>
  );
}

export default function SceneTakeCard({ take, scene, project, kind, thumbClass, isSelected, busy, saving, playback, verdict: verdictState, notes, move, actions }) {
  const { openVerdict, setOpenVerdict } = verdictState;
  const { onOpenPreview, onReview } = actions;
  const { noteFor, openNote } = notes;
  const editingNote = noteFor !== null && noteFor === take.takeId;
  const { moveFor, moveTargets } = move;
  const { copyPointer, setPlayingId } = playback;
  const rejected = take.status === 'rejected';
  const frameTake = kind === 'image' || kind === 'endImage';
  const verdict = frameTake ? plateVerdict(scene, take, project) : null;
  const verdictOpen = openVerdict === take.takeId && verdict?.issues.length > 0;
  // The take in use is swapped out first, and a clip covering a run of shots stays with its run.
  const movable = Boolean(take.takeId && !isSelected && !take.sequence && moveTargets.length);
  const savingMove = Boolean(movable && saving?.has(takeControl.move(scene, take)));
  const sequenceLabel = sequenceTakeLabel(take);

  return (
    <li className={`${thumbClass} space-y-1`}
      onPointerDownCapture={(event) => { copyPointer.current = Boolean(event.target.closest('[data-asset-copy-trigger]')); }}
      onPointerUpCapture={() => { if (copyPointer.current) setTimeout(() => { copyPointer.current = false; }, 0); }}
      onPointerCancelCapture={() => { copyPointer.current = false; }}
      onMouseLeave={() => setPlayingId(null)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !copyPointer.current) setPlayingId(null); }}>
      <TakeThumbnail take={take} kind={kind} isSelected={isSelected} rejected={rejected} playback={playback} onOpenPreview={onOpenPreview} />
      <SceneTakeVerdict take={take} verdict={verdict} verdictOpen={verdictOpen} onToggle={() => setOpenVerdict(verdictOpen ? null : take.takeId)} />
      {sequenceLabel && (
        <p className="break-words text-[10px] text-port-text-muted" title={sequenceTakeSummary(take, project?.scenes)} data-testid="sequence-take-label">
          {sequenceLabel}
        </p>
      )}
      {take.parentTakeId && (
        <p className="break-words text-[10px] text-port-text-muted" data-testid="extend-take-label">Extends an earlier take</p>
      )}
      {verdictOpen && <SceneTakeVerdictIssues verdict={verdict} />}
      {take.note && !editingNote && (
        <p className="text-[10px] text-port-warning break-words">{take.note}</p>
      )}
      {take.dependencies?.references?.some((ref) => ref.role === 'clipReferences' && ref.untrackedCastGuides) && (
        <p className="text-[10px] text-port-warning break-words">Cast guide changes are not tracked. Review this take before use.</p>
      )}
      {frameTake && actions.onRefine && (
        <button type="button" disabled={busy || actions.refineDisabled} onClick={() => actions.onRefine(take)}
          className="inline-flex items-center gap-0.5 rounded border border-port-border bg-port-bg px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
          title="Refine this image with an instruction without selecting it">
          <PencilLine size={11} /> Refine take
        </button>
      )}
      <TakeReviewActions take={take} scene={scene} kind={kind} frameTake={frameTake} isSelected={isSelected} rejected={rejected}
        busy={busy} saving={saving} move={move} movable={movable} savingMove={savingMove} actions={actions} openNote={openNote} />
      {kind === 'video' && take.takeId && !rejected && project?.id && (
        <TakeExtend projectId={project.id} scene={scene} take={take} busy={busy} />
      )}
      {/* Secondary: copy the file's ID or URL, after the review actions. */}
      <AssetReferenceActions assetId={take.assetId} compact
        url={kind === 'video' ? null : takeThumbUrl(take)}
        resolveUrl={kind === 'video' ? () => videoTakeUrl(take) : null} />
      <SceneTakeWarnings scene={scene} take={take} project={project} frameTake={frameTake} isSelected={isSelected} onReview={onReview} busy={busy} saving={saving} />
      {movable && moveFor === take.takeId && <TakeMovePicker take={take} scene={scene} move={move} busy={busy} savingMove={savingMove} />}
      {editingNote && <TakeNoteInput take={take} scene={scene} notes={notes} />}
    </li>
  );
}
