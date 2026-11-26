import { useMemo, useState } from 'react';
import { artDirectionGaps, changeRequestBlocker, problemItemsOf, stageChecklist, summarizeStoryboardProblems } from '../../lib/musicVideoStages.js';
import { formatCount } from '../../utils/formatters.js';
import OverlayTextCheck from './OverlayTextCheck.jsx';
import ProductionReviewContext from './ProductionReviewContext.jsx';
import ProofReviewContent, { ProofRenderControls } from './ProofReviewContent.jsx';
import { reviewAnchorStyle, reviewButtonClass as buttonClass } from './controlClasses.js';
import useMusicVideoProofReview from './useMusicVideoProofReview.js';

const approveClass = 'min-h-[44px] rounded bg-port-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
const labels = { art: 'Art direction', storyboard: 'Lyric-timed storyboard', proof: 'Animated proof' };
// Each approval closes the step that owns its work (#10151); the page passes that step's `stage`.
const STAGE_TABS = { art: 'cast-sets', storyboard: 'produce', proof: 'produce' };
const HEADINGS = { storyboard: { open: 'Approve storyboard', approved: 'Storyboard approved' } };

/**
 * The open box that closes a step: heading, then the approval's content and
 * Approve / Request changes, highlighted until approved. A `waiting` box has
 * nothing to review yet, so it is not highlighted either.
 */
function ApprovalBox({ id, stage, label, approved, optional = false, waiting = false, children }) {
  return <section id={id} tabIndex={-1} aria-label={`Approve: ${label}`} style={reviewAnchorStyle}
    className={`rounded-lg border p-3 focus:outline focus:outline-2 focus:outline-port-accent ${approved || optional || waiting ? 'border-port-border' : 'border-port-accent bg-port-accent/5'}`}>
    {/* An optional check isn't highlighted: it never competes with the step's real next action. */}
    <h4 className="text-sm font-semibold">{HEADINGS[stage]?.[approved ? 'approved' : 'open'] || (approved ? `${label} approved` : optional ? label : `Approve the ${label.toLowerCase()}`)}{optional && !approved && <span className="ml-2 font-normal text-port-text-muted">Optional</span>}</h4>
    {children}
  </section>;
}

function storyboardPlanItems(project, ready) {
  return stageChecklist('board', project, ready).filter(item => !item.done && item.id.startsWith('board-'))
    .map(item => {
      const numbers = (item.shots || []).map(shot => shot.label.replace(/^Shot\s*/, '')).filter(Boolean);
      return { id: item.id, text: numbers.length ? `${item.label} (${numbers.length === 1 ? 'shot' : 'shots'} ${numbers.join(', ')})` : item.label };
    });
}

function approvalHelp({ approval, dirty, busy, problems, openRequests, openPlanItems, stage, proof, artReady }) {
  if (!approval) return 'Loading…';
  if (approval.approved) return null;
  if (dirty) return 'Save your planning edits first.';
  if (busy) return 'Working…';
  // The approval points to the open rows from the Storyboard step's checklist.
  if (stage === 'storyboard' && problems.length) {
    const open = openPlanItems.length || problems.length + (openRequests.length ? 1 : 0);
    return open > 1 ? `Finish these ${open} items on the Storyboard step first:` : 'Finish this on the Storyboard step first:';
  }
  if (openRequests.length) return changeRequestBlocker(openRequests);
  // The Render button already says what to do when there is no current proof.
  if (stage === 'proof' && proof.needsRender) return null;
  if (problems.length) return problems.length > 1 ? `${problems[0]} (+${problems.length - 1} more below)` : problems[0];
  if (stage === 'art' && !artReady) return 'Open the visual guide below first.';
  return stage === 'proof' ? proof.approvalBlocker() : null;
}

export default function ProductionApprovalCard({ project, review, ready, saved, stage, shots, dirty, blocked, openRequests,
  fieldId, onRequestChanges, onOpenArtifact, onNavigate, onSeek }) {
  const [visibleArt, setVisibleArt] = useState(null);
  const artIdentity = useMemo(() => JSON.stringify([project.id, saved.guideArtifactId,
    project.devArtifacts?.find(artifact => artifact.id === saved.guideArtifactId)?.version]),
  [project.id, saved.guideArtifactId, project.devArtifacts]);
  const artReady = visibleArt === artIdentity;
  const proof = useMusicVideoProofReview({ project, review, ready, blocked });
  const approval = ready?.[stage];
  const approved = !!approval?.approved;
  const label = labels[stage];
  const showPlanItems = stage === 'storyboard' && !approved && !!approval?.problems.length;
  const problems = useMemo(() => {
    if (!approval || approved) return [];
    const items = problemItemsOf(approval).filter(problem => problem.code !== 'feedback');
    return (stage === 'storyboard' ? summarizeStoryboardProblems(items) : items).map(problem => problem.message);
  }, [approval, approved, stage]);
  const openPlanItems = useMemo(() =>
    stage === 'storyboard' && (showPlanItems || problems.length) ? storyboardPlanItems(project, ready) : [],
  [stage, showPlanItems, problems.length, project, ready]);
  const helpText = approvalHelp({ approval, dirty, busy: review.busy, problems, openRequests, openPlanItems, stage, proof, artReady });
  // During edits, actions or change requests the help line describes the blocker, so list every problem.
  const problemsList = stage === 'storyboard' || (stage === 'proof' && proof.needsRender) ? []
    : dirty || review.busy || openRequests.length ? problems : problems.slice(1);
  const artWaiting = stage === 'art' && !!approval && !approved && !approval.stale && !artDirectionGaps(project).ready;
  const advice = ready?.storyboard?.adviceItems;
  const olderCharacters = useMemo(() => (advice || []).filter(item => item.code === 'character-reference-changed'), [advice]);

  // Route across steps or between the proof and storyboard panels (only one is mounted).
  // Other same-step sections only need unfolding.
  const jump = (tab, anchor) => event => {
    if (onNavigate && (tab !== STAGE_TABS[stage] || (stage === 'proof' && anchor === 'mv-review-storyboard'))) {
      event.preventDefault();
      onNavigate(tab, anchor);
      return;
    }
    const target = document.getElementById(event.currentTarget.hash.slice(1));
    if (target) { target.open = true; target.focus({ preventScroll: true }); }
  };

  return <ApprovalBox id={`mv-review-${stage}`} stage={stage} label={label} optional={stage === 'proof'} approved={approved} waiting={artWaiting}>
    {artWaiting ? <p role="status" className="mt-1 text-sm text-port-text-muted">Opens once the art direction is written and a visual guide is chosen.</p> : <>
      {/* The decision comes first, at the top of the box, with one line on what it still needs. */}
      {stage === 'proof' && proof.needsRender && !approved && <div className="mt-2"><ProofRenderControls proof={proof} fieldId={fieldId} review={review} ready={ready} blocked={blocked} /></div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!approved && !(stage === 'proof' && proof.needsRender) && <button type="button" className={approveClass} onClick={() => review.approve(stage, stage === 'proof' ? proof.approvalPayload() : undefined)}
          aria-describedby={helpText ? fieldId(`${stage}-approval-help`) : undefined}
          disabled={stage === 'proof' ? proof.approvalDisabled
            : blocked || (stage === 'art' && !artReady) || !!approval?.problems.length}>
          {stage === 'proof' ? proof.approvalLabel : HEADINGS[stage]?.open || `Approve ${label.toLowerCase()}`}
        </button>}
        <button type="button" className={buttonClass} onClick={onRequestChanges}>Request changes</button>
      </div>
      {helpText && <p id={fieldId(`${stage}-approval-help`)} role="status" className="mt-1 text-sm text-port-warning">{helpText}</p>}
      {showPlanItems && openPlanItems.length > 0 && <div className="mt-1 text-sm">
        <ul aria-label="Open Storyboard items" className="list-disc pl-5 text-port-text-muted">{openPlanItems.map(item => <li key={item.id}>{item.text}</li>)}</ul>
        {onNavigate && <button type="button" onClick={() => onNavigate('board')} className="mt-1 min-h-[44px] rounded border border-port-border px-2 py-1 text-port-accent pointer-fine:sm:min-h-0">Open the Storyboard step</button>}
      </div>}
      {problemsList.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-port-text-muted">{problemsList.map(problem => <li key={problem}>{problem}</li>)}</ul>}
      {/* Camera variety (#10589) is advice, never a blocker on approval. */}
      {stage === 'storyboard' && ready?.storyboard.camera?.notes?.length > 0 && <div role="note" aria-label="Camera variety notes" className="mt-2 text-xs text-port-text-muted">
        <p>Camera notes (they don&apos;t block approval):</p>
        <ul className="list-disc pl-5">{ready.storyboard.camera.notes.map(note => <li key={note}>{note}</li>)}</ul>
      </div>}
      {/* #16473: shots rendered from an older character reference, grouped by the server's code. Advice too. */}
      {stage === 'storyboard' && olderCharacters.length > 0 && <div role="note" aria-label="Older character references" className="mt-2 text-xs text-port-text-muted">
        <p>{formatCount(olderCharacters.length)} {olderCharacters.length === 1 ? 'shot' : 'shots'} rendered from an older character reference (this doesn&apos;t block approval):</p>
        <ul className="list-disc pl-5">{olderCharacters.map(item => <li key={item.sceneId}>{item.message}</li>)}</ul>
      </div>}
      {/* The overlay text pass (document compositions): advice too, shown before the shot list. */}
      {stage === 'storyboard' && ready?.storyboard.text && <OverlayTextCheck report={ready.storyboard.text} busy={review.busy}
        onCheck={() => review.checkOverlayText()} onSeek={onSeek} />}
      {stage === 'proof' ? <ProofReviewContent proof={proof} fieldId={fieldId} jump={jump} saved={saved} review={review} project={project} ready={ready} blocked={blocked} /> : <ProductionReviewContext stage={stage} project={project} shots={shots} onOpenArtifact={onOpenArtifact} onArtReady={available => setVisibleArt(available ? artIdentity : null)} onSeek={onSeek} />}
    </>}
  </ApprovalBox>;
}
