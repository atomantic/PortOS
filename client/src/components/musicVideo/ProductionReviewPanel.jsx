import { useState } from 'react';
import useMusicVideoProofReview from '../../hooks/useMusicVideoProofReview.js';
import ProofReviewContent, { ProofRenderControls } from './ProofReviewContent.jsx';
import ProductionReviewContext from './ProductionReviewContext.jsx';
import OverlayTextCheck from './OverlayTextCheck.jsx';
import ArtGuideDrafter from './ArtGuideDrafter.jsx';
import { formatTimecode } from '../../utils/formatters.js';
import { ART_DIRECTION_ANCHOR, artDirectionGaps, changeRequestBlocker, openChangeRequests, stageChecklist, summarizeStoryboardProblems } from '../../lib/musicVideoStages.js';

const EMPTY = { cast: '', environments: '', visualLanguage: '', motionLanguage: '', guideArtifactId: null,
  lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] };
const fieldClass = 'mt-1 w-full rounded border border-port-border bg-port-bg p-2 text-sm';
const buttonClass = 'min-h-[44px] rounded border border-port-border px-3 py-2 text-sm disabled:opacity-50';
const approveClass = 'min-h-[44px] rounded bg-port-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
const labels = { art: 'Art direction', storyboard: 'Lyric-timed storyboard', proof: 'Animated proof' };
// The proof is an optional check (the final render doesn't wait on it), so its heading says so.
const OPTIONAL = { proof: true };
// Each approval closes the step that owns its work (#10151); the page passes that step's `stage`.
const STAGE_TABS = { art: 'cast-sets', storyboard: 'produce', proof: 'produce' };
// Approving the storyboard locks every shot's still, so its box says so.
const HEADINGS = { storyboard: { open: 'Lock all stills', approved: 'All stills locked' } };

const FOLD_STYLE = { scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' };
/**
 * The open box that closes a step: heading, then the approval's content and
 * Approve / Request changes, highlighted until approved. A `waiting` box has
 * nothing to review yet, so it is not highlighted either.
 */
function ApprovalBox({ id, stage, label, approved, optional = false, waiting = false, children }) {
  return <section id={id} tabIndex={-1} aria-label={`Approve: ${label}`} style={FOLD_STYLE}
    className={`rounded-lg border p-3 focus:outline focus:outline-2 focus:outline-port-accent ${approved || optional || waiting ? 'border-port-border' : 'border-port-accent bg-port-accent/5'}`}>
    {/* An optional check isn't highlighted: it never competes with the step's real next action. */}
    <h4 className="text-sm font-semibold">{HEADINGS[stage]?.[approved ? 'approved' : 'open'] || (approved ? `${label} approved` : optional ? label : `Approve the ${label.toLowerCase()}`)}{optional && !approved && <span className="ml-2 font-normal text-port-text-muted">Optional</span>}</h4>
    {children}
  </section>;
}

/**
 * One step's production approval, with its feedback and planning fields, for
 * every render mode. `stage` ('art' | 'storyboard' | 'proof') is the approval
 * the step closes. `planning` is an optional `[draft, setDraft]` pair owned by
 * the page so unsaved edits survive a step switch; `onNavigate(step, anchor)`
 * jumps steps.
 */
export default function ProductionReviewPanel({ project, review, onOpenArtifact, stage, planning = null, onNavigate = null, onSeek = null }) {
  const showArt = stage === 'art';
  const showBoard = stage === 'storyboard';
  // Scoped by stage too, so two step panels mounted together never share a field id.
  const fieldId = key => `mv-review-${project.id}-${stage}-${key}`;
  const saved = project.productionReview?.draft || EMPTY;
  const [visibleArt, setVisibleArt] = useState(null);
  const artIdentity = JSON.stringify([project.id, saved.guideArtifactId, project.devArtifacts?.find(a => a.id === saved.guideArtifactId)?.version]);
  const [ownLocal, setOwnLocal] = useState(null);
  const [local, setLocal] = planning || [ownLocal, setOwnLocal];
  const draft = local || saved;
  const dirty = !!local && JSON.stringify(local) !== JSON.stringify(saved);
  const [feedback, setFeedback] = useState({ stage, target: '', text: '', decision: 'request-changes' });
  const [resolutions, setResolutions] = useState({});
  const [importError, setImportError] = useState(null);
  const [savedRequestStage, setSavedRequestStage] = useState(null);
  const ready = review.current === false ? null : review.readiness; // approvals never act on a stale revision
  const set = (key, value) => setLocal({ ...draft, [key]: value });
  const documentShots = draft.storyboardSource === 'document';
  // A Board scene with no draft shot shows the row the server derives for it (its planned action, camera and lyric lines).
  const shots = documentShots ? draft.storyboard : [...draft.storyboard, ...(project.scenes || []).filter(scene => !draft.storyboard.some(s => s.sceneId === scene.sceneId)).map(scene => ({
    id: scene.sceneId, sceneId: scene.sceneId, lyricCueIds: [], action: '', staging: '', camera: '', transition: '',
    ...ready?.storyboard.shots?.find(s => s.sceneId === scene.sceneId),
  }))];
  const shotKey = shot => shot.id || shot.sceneId;
  const setShot = (shot, key, value) => set('storyboard', shots.map(s => shotKey(s) === shotKey(shot) ? { ...s, [key]: value } : s));
  const blocked = dirty || review.busy || !ready;
  const proof = useMusicVideoProofReview({ project, review, ready, blocked });
  const approve = stage => review.approve(stage, stage === 'proof' ? proof.approvalPayload() : undefined);

  // Per-shot storyboard problems arrive one sentence per shot; the card counts them instead (the preview is the review).
  // Open change requests are named in one line (and settled from the step's Feedback row), never repeated as problems.
  const feedbackSentence = /^Resolve (art|storyboard|proof) feedback for /;
  const shownProblems = stage => {
    const problems = (ready[stage].problems || []).filter(problem => !feedbackSentence.test(problem));
    return stage === 'storyboard' ? summarizeStoryboardProblems(problems) : problems;
  };
  // One line under the action buttons saying what approval still needs, or nothing when it can be given.
  const approvalHelp = stage => {
    if (!ready) return 'Loading…';
    if (ready[stage].approved) return null;
    if (dirty) return 'Save your planning edits first.';
    if (review.busy) return 'Working…';
    const problems = shownProblems(stage);
    const requests = openRequests(stage);
    // The Plan checklist lists each open item with its button, so the card names them (planItems) and links there.
    if (stage === 'storyboard' && problems.length) {
      const open = planItems().length || problems.length + (requests.length ? 1 : 0);
      return open > 1 ? `Finish these ${open} items on the Storyboard step first:` : 'Finish this on the Storyboard step first:';
    }
    if (requests.length) return changeRequestBlocker(requests);
    // With no current proof, the Render button already says what to do; repeating it as a warning reads as required.
    if (stage === 'proof' && proof.needsRender) return null;
    if (problems.length) return problems.length > 1 ? `${problems[0]} (+${problems.length - 1} more below)` : problems[0];
    if (stage === 'art' && visibleArt !== artIdentity) return 'Open the visual guide below first.';
    return stage === 'proof' ? proof.approvalBlocker() : null;
  };
  // The Plan checklist's open rows, each with the shots it names, for the storyboard card to list.
  const planItems = () => stageChecklist('board', project, ready).filter(item => !item.done && item.id.startsWith('board-'))
    .map(item => {
      const numbers = (item.shots || []).map(shot => shot.label.replace(/^Shot\s*/, '')).filter(Boolean);
      return { id: item.id, text: numbers.length ? `${item.label} (${numbers.length === 1 ? 'shot' : 'shots'} ${numbers.join(', ')})` : item.label };
    });
  // The problems listed under the help line: all of them, less the first when the help line is showing it
  // (it isn't while edits are unsaved or an action is running). A proof with nothing rendered lists none.
  const listedProblems = stage => {
    if (!ready || ready[stage].approved || stage === 'storyboard' || (stage === 'proof' && proof.needsRender)) return [];
    const problems = shownProblems(stage);
    // The help line names a change request ahead of any problem, so then every problem is listed here.
    return dirty || review.busy || openRequests(stage).length ? problems : problems.slice(1);
  };
  // A link to another step's section crosses steps through the page; within this step it just unfolds the target.
  const jump = (tab, anchor) => event => {
    if (onNavigate && tab !== STAGE_TABS[stage]) { event.preventDefault(); onNavigate(tab, anchor); return; }
    openReviewSection(event);
  };
  const openReviewSection = event => {
    const target = document.getElementById(event.currentTarget.hash.slice(1));
    if (target) { target.open = true; target.focus({ preventScroll: true }); }
  };
  const openRequests = stage => openChangeRequests(project, stage);
  const renderControls = <ProofRenderControls proof={proof} fieldId={fieldId} review={review} ready={ready} blocked={blocked} />;
  const key = stage;
  const label = labels[stage];
  // Art with no written direction or guide has nothing to approve: the box says
  // so in one line, and the step's checklist offers what produces them.
  const artWaiting = key === 'art' && !!ready && !ready.art.approved && !ready.art.stale && !artDirectionGaps(project).ready;
  return <section id="mv-production-review" aria-label="Production review" className="space-y-3">
    {review.error && <p role="alert" className="text-port-error">{review.error}</p>}
    <ApprovalBox id={`mv-review-${key}`} stage={key} label={label} optional={!!OPTIONAL[key]} approved={!!ready?.[key].approved} waiting={artWaiting}>
        {artWaiting ? <p role="status" className="mt-1 text-sm text-port-text-muted">Opens once the art direction is written and a visual guide is chosen.</p> : <>
        {/* The decision comes first, at the top of the box, with one line on what it still needs. */}
        {key === 'proof' && proof.needsRender && !ready?.[key].approved && <div className="mt-2">{renderControls}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
        {!ready?.[key].approved && !(key === 'proof' && proof.needsRender) && <button type="button" className={approveClass} onClick={() => approve(key)}
          aria-describedby={approvalHelp(key) ? fieldId(`${key}-approval-help`) : undefined}
          disabled={key === 'proof' ? proof.approvalDisabled
            : blocked || (key === 'art' && visibleArt !== artIdentity) || ready?.[key].approved || !!ready?.[key].problems.length}>
          {key === 'proof' ? proof.approvalLabel : HEADINGS[key]?.open || `Approve ${label.toLowerCase()}`}
        </button>}
        <button type="button" className={buttonClass} onClick={() => {
          setFeedback({ ...feedback, stage: key, decision: 'request-changes' });
          const input = document.getElementById(fieldId('feedback-text'));
          const fold = input?.closest('details'); if (fold) fold.open = true;
          input?.scrollIntoView({ block: 'center' }); input?.focus({ preventScroll: true });
        }}>Request changes</button>
        </div>
        {approvalHelp(key) && <p id={fieldId(`${key}-approval-help`)} role="status" className="mt-1 text-sm text-port-warning">{approvalHelp(key)}</p>}
        {key === 'storyboard' && !ready?.storyboard.approved && !!ready?.storyboard.problems.length && planItems().length > 0 && <div className="mt-1 text-sm">
          <ul aria-label="Open Storyboard items" className="list-disc pl-5 text-port-text-muted">{planItems().map(item => <li key={item.id}>{item.text}</li>)}</ul>
          {onNavigate && <button type="button" onClick={() => onNavigate('board')} className="mt-1 min-h-[44px] rounded border border-port-border px-2 py-1 text-port-accent sm:min-h-0">Open the Storyboard step</button>}
        </div>}
        {listedProblems(key).length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-port-text-muted">{listedProblems(key).map(problem => <li key={problem}>{problem}</li>)}</ul>}
        {/* Camera variety (#10589) is advice, never a blocker on approval. */}
        {key === 'storyboard' && ready?.storyboard.camera?.notes?.length > 0 && <div role="note" aria-label="Camera variety notes" className="mt-2 text-xs text-port-text-muted">
          <p>Camera notes (they don&apos;t block approval):</p>
          <ul className="list-disc pl-5">{ready.storyboard.camera.notes.map(note => <li key={note}>{note}</li>)}</ul>
        </div>}
        {/* The overlay text pass (document compositions): advice too, shown before the shot list. */}
        {key === 'storyboard' && ready?.storyboard.text && <OverlayTextCheck report={ready.storyboard.text} busy={review.busy}
          onCheck={() => review.checkOverlayText()} onSeek={onSeek} />}
        {key === 'proof' ? <ProofReviewContent proof={proof} fieldId={fieldId} jump={jump} saved={saved} review={review} project={project} ready={ready} blocked={blocked} /> : <ProductionReviewContext stage={key} project={project} shots={shots} onOpenArtifact={onOpenArtifact} onArtReady={available => setVisibleArt(available ? artIdentity : null)} onSeek={onSeek} />}
        </>}
    </ApprovalBox>
    {dirty && <p role="status" className="text-sm">Save your planning edits before approving this revision.</p>}
    <details>
      <summary className="cursor-pointer min-h-[44px] py-2 text-sm">Review feedback and revision history</summary>
      <label htmlFor={fieldId('feedback-target')} className="block text-sm">Feedback target<input id={fieldId('feedback-target')} className={fieldClass} value={feedback.target} placeholder="Cast: operator; shot: chorus; frame: 12.5s" onChange={e => setFeedback({ ...feedback, target: e.target.value })} /></label>
      <label htmlFor={fieldId('feedback-text')} className="block text-sm">Requested change<textarea id={fieldId('feedback-text')} className={fieldClass} rows={3} value={feedback.text} onChange={e => setFeedback({ ...feedback, text: e.target.value })} /></label>
      <label htmlFor={fieldId('feedback-decision')} className="block text-sm">Review decision<select id={fieldId('feedback-decision')} className={fieldClass} value={feedback.decision} onChange={e => setFeedback({ ...feedback, decision: e.target.value })}>
        <option value="request-changes">Request changes — blocks affected approvals</option><option value="comment">Comment</option><option value="structure-accepted">Accept structure only — art remains unapproved</option>
      </select></label>
      <button type="button" className={buttonClass} disabled={blocked || !feedback.target.trim() || !feedback.text.trim()} onClick={async () => {
        if (await review.feedback(feedback)) {
          setFeedback({ ...feedback, text: '' });
          setSavedRequestStage(feedback.decision === 'request-changes' ? feedback.stage : null);
        }
      }}>Save revision feedback</button>
      {savedRequestStage && openRequests(savedRequestStage).length > 0 && <p role="status" className="text-sm">
        Approval stays blocked until these are resolved. Revise from feedback or mark each one resolved from the Feedback row at the top of this step.
      </p>}
      <ul className="mt-3 space-y-3">{(project.productionReview?.feedback || []).filter(item => item.stage === stage).map(item => <li key={item.id} className="rounded border border-port-border p-2">
        <p className="text-sm"><strong>{item.target}</strong> · {item.decision} · {item.resolvedAt ? 'Resolved' : 'Open'}</p>
        <p className="text-sm whitespace-pre-wrap">{item.text}</p>
        <p className="text-xs text-port-text-muted">Reviewed revision {item.basis.slice(0, 12)}{ready?.basis[item.stage] !== item.basis ? ' · content has changed since review' : ' · current revision'}</p>
        <details><summary className="cursor-pointer py-2 text-sm">Original reviewed content</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(project.productionReview.reviewedRevisions?.[item.basis]?.draft, null, 2)}</pre></details>
        {item.resolvedAt ? (item.resolution ? <p className="text-sm">Resolution: {item.resolution}</p> : null) : <>
          <label htmlFor={fieldId(`resolution-${item.id}`)} className="block text-sm">How it was resolved (optional)<textarea id={fieldId(`resolution-${item.id}`)} className={fieldClass} value={resolutions[item.id] || ''} onChange={e => setResolutions({ ...resolutions, [item.id]: e.target.value })} /></label>
          <button type="button" className={buttonClass} disabled={blocked} onClick={async () => {
            await review.resolveFeedback(item.id, resolutions[item.id]?.trim() || '');
          }}>Mark resolved</button>
        </>}
      </li>)}</ul>
    </details>
    {stage !== 'proof' && <details id="mv-review-planning" tabIndex={-1} open={window.location.hash === '#mv-review-planning'} style={{ scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' }}>
      <summary className="cursor-pointer min-h-[44px] py-2 text-sm">{showArt ? 'Edit art direction and visual guide' : 'Edit storyboard shots'}</summary>
      <div className="space-y-3">
        {importError && <p role="alert">{importError}</p>}
        {showArt && <label htmlFor={fieldId('import')} className="block text-sm">Import planning JSON as an unapproved draft
          <input id={fieldId('import')} type="file" accept=".json,application/json" disabled={dirty || review.busy} className={fieldClass}
            onChange={async e => {
              const file = e.target.files?.[0]; e.target.value = ''; setImportError(null);
              if (!file) return;
              try { if (await review.importPlanning(await file.text())) setLocal(null); }
              catch (error) { setImportError(error.message); }
            }} />
        </label>}
        {showBoard && project.composition?.mode === 'document' && <div className="space-y-2 rounded border border-port-border p-2">
          <p className="text-sm">Document shot manifest</p>
          <p className="text-xs text-port-text-muted">Export the composition in Make. Have its author extract the actual shot IDs, timings and choreography from the source (for example timeline.js) into the JSON format below, keeping its documentDirectory and audioBasis from when that source was authored. A generic document section or Board row is not a shot list. Reauthor and reimport the composition after changing lyrics or timing, then import its matching manifest here.</p>
          <label htmlFor={fieldId('document-shots')} className="block text-sm">Import document shot manifest
            <input id={fieldId('document-shots')} type="file" accept=".json,application/json" disabled={dirty || review.busy || !project.productionReview?.draft || !project.composition.document} className={fieldClass}
              onChange={async e => {
                const file = e.target.files?.[0]; e.target.value = ''; setImportError(null);
                if (!file) return;
                try {
                  const input = JSON.parse(await file.text());
                  if (await review.importDocumentShots(input)) setLocal(null);
                } catch (error) { setImportError(error.message); }
              }} />
          </label>
          <details><summary className="cursor-pointer py-2 text-sm">Shot manifest format</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ ...ready?.documentShotImport, sourceFile: 'timeline.js', shots: [{ id: 'source-shot-id', sceneId: null, startSec: 0, endSec: 10, lyricCueIds: [], action: 'Source action', staging: 'Source staging', camera: 'Source camera', transition: 'Source transition' }] }, null, 2)}</pre></details>
          <p className="text-xs">{project.productionReview?.documentStoryboard ? `Bound source: ${project.productionReview.documentStoryboard.sourceFile}. Reimporting a document, changing audio or editing these shots requires a new matching manifest.` : 'No document shot manifest bound. Board scenes do not stand in for source shots.'}</p>
        </div>}
        {showArt && <>
        {draft.sourceArtifactId && <button type="button" className={buttonClass} onClick={() => onOpenArtifact(draft.sourceArtifactId)}>Read preserved original planning draft</button>}
        <button type="button" className={buttonClass} disabled={dirty || review.busy || documentShots} onClick={review.prepare}>Draft art direction and shots</button>
        <p className="text-xs text-port-text-muted">Uses the saved authoring provider and allowed tools. Builds Cast & Sets first, then pauses for art approval before planning shots. Existing edits are retained.</p>
        <ArtGuideDrafter project={project} disabled={review.busy} onUse={fields => setLocal({ ...draft, ...fields })} />
        <div id={ART_DIRECTION_ANCHOR} className="grid gap-3 sm:grid-cols-2" style={FOLD_STYLE}>
          {Object.entries({ cast: 'Cast guide', environments: 'Environment guide', visualLanguage: 'Visual language and mood board' }).map(([key, label]) =>
            <label key={key} htmlFor={fieldId(key)} className="text-sm">{label}<textarea id={fieldId(key)} rows={4} value={draft[key]} onChange={e => set(key, e.target.value)} className={fieldClass} /></label>)}
        </div>
        <label htmlFor={fieldId('motionLanguage')} className="block text-sm">Timed choreography and energy plan
          <textarea id={fieldId('motionLanguage')} rows={7} value={draft.motionLanguage || ''} onChange={e => set('motionLanguage', e.target.value)} className={fieldClass}
            aria-label="Timed choreography and energy plan" aria-describedby={fieldId('motion-help')}
            placeholder={'Energy target: restrained, driving, explosive, or a described arc.\n0:00–0:08 / first downbeat: subject reaches, prop unfolds; camera pushes in; title lands on the vocal.\n0:08–0:16 / chorus hit: full-body turn and prop release; camera arcs; type expands then clears.\nRepeated chorus: preserve the motif, escalate pose range, travel, camera depth or transition scale.'} />
        </label>
        <p id={fieldId('motion-help')} className="text-xs text-port-text-muted">Choose the intended energy explicitly. For each time range and beat, word or section anchor, describe subject and prop actions, pose or travel changes, camera movement, typography and the transition. Name intentional holds and how each repeated chorus develops. The saved plan guides UI authoring and autopilot.</p>
        <label htmlFor={fieldId('implementation')} className="block text-sm">Implementation and feasibility for {project.composition?.mode || 'composed'} rendering
          <textarea id={fieldId('implementation')} rows={5} value={draft.implementationPlan || ''} onChange={e => set('implementationPlan', e.target.value)} className={fieldClass}
            placeholder="Map each timed action to scene graph layers, vector/mesh construction, rig joints, pose limits and prop mechanics; specify camera paths and typography timing, transitions, frame rate, geometry and draw-call budgets." />
        </label>
        <p className="text-xs text-port-text-muted">Concept references establish intent. Document how this renderer can build and animate the look; a raster reference is not code-rendered evidence. Changing the plan invalidates prior art approval.</p>
        <label htmlFor={fieldId('guide')} className="block text-sm">Visual cast and environment sheet
          <select id={fieldId('guide')} value={draft.guideArtifactId || ''} onChange={e => set('guideArtifactId', e.target.value || null)} className={fieldClass}>
            <option value="">Choose a Development artifact</option>
            {(project.devArtifacts || []).filter(a => !a.deleted).map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </label>
        {draft.guideArtifactId && <button type="button" className={buttonClass} onClick={() => onOpenArtifact(draft.guideArtifactId)}>Review visual sheet</button>}
        </>}
        {showBoard && <>
        {/* Song content and lyric-timing verification live on the Song step (LyricTimingCheck). */}
        <label htmlFor={fieldId('storyboard-source')} className="block text-sm">Storyboard source
          <select id={fieldId('storyboard-source')} value={draft.storyboardSource || 'board'} onChange={e => set('storyboardSource', e.target.value)} className={fieldClass}>
            <option value="board">Board scenes</option><option value="document">Authored document shot manifest</option>
          </select>
        </label>
        {shots.map(shot => {
          const scene = documentShots ? shot : project.scenes?.find(s => s.sceneId === shot.sceneId);
          return <details key={shotKey(shot)} className="rounded border border-port-border p-2">
            <summary className="cursor-pointer min-h-[44px] text-sm">{scene?.label || shot.id || 'Unbound shot'} — {documentShots ? 'document source shot' : scene ? 'edit choreography' : 'bind to a Board scene'}</summary>
            {!documentShots && <label htmlFor={fieldId(`scene-${shotKey(shot)}`)} className="block text-sm">Board scene
              <select id={fieldId(`scene-${shotKey(shot)}`)} value={shot.sceneId || ''} onChange={e => setShot(shot, 'sceneId', e.target.value || null)} className={fieldClass}>
                <option value="">Unbound draft — no scene selected</option>
                {(project.scenes || []).map(s => <option key={s.sceneId} value={s.sceneId}>{s.label || s.sceneId}</option>)}
              </select>
            </label>}
            {!documentShots && !scene && <button type="button" className={buttonClass} disabled={dirty || review.busy || !shot.id} onClick={() => review.bindShot(shot.id)}>Create Board scene from this draft shot</button>}
            {documentShots ? <div className="flex flex-wrap gap-2">
              {['startSec', 'endSec'].map(key => <label key={key} htmlFor={fieldId(`${shotKey(shot)}-${key}`)} className="text-sm">{key === 'startSec' ? 'Shot start (seconds)' : 'Shot end (seconds)'}<input id={fieldId(`${shotKey(shot)}-${key}`)} type="number" min="0" step="0.01" value={shot[key] ?? ''} onChange={e => setShot(shot, key, e.target.value === '' ? null : Number(e.target.value))} className={fieldClass} /></label>)}
              <p className="text-xs text-port-text-muted">Planning edits do not rewrite source code. Reauthor or reimport in Make, then import its matching shot manifest before approval.</p>
            </div> : <p className="text-xs text-port-text-muted">{scene && Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) ? `Shot window ${formatTimecode(scene.startSec)}–${formatTimecode(scene.endSec)}. ` : ''}Review exact start/end in Board. Imported timings remain provisional.</p>}
            {['action', 'staging', 'camera', 'transition'].map(key => <label key={key} htmlFor={fieldId(`${shotKey(shot)}-${key}`)} className="block text-sm capitalize">{key}
              <textarea id={fieldId(`${shotKey(shot)}-${key}`)} rows={2} value={shot[key]} placeholder={({ action: 'At a beat or word: subject and prop action; pose, travel and energy change.', staging: 'Depth, blocking, prop trajectory and typography placement through the shot.', camera: 'Timed camera path, framing changes and motivated holds.', transition: 'Exact entry/exit anchor, visual handoff and escalation into the next section.' })[key]} onChange={e => setShot(shot, key, e.target.value)} className={fieldClass} />
            </label>)}
            <fieldset><legend className="text-sm">Lyric anchors</legend>
              {(project.lyricCues || []).filter(c => c.startSec < scene?.endSec && c.endSec > scene?.startSec).map(cue =>
                <label key={cue.id} htmlFor={fieldId(`${shotKey(shot)}-${cue.id}`)} className="flex gap-2 py-2 text-sm"><input id={fieldId(`${shotKey(shot)}-${cue.id}`)} type="checkbox" checked={shot.lyricCueIds.includes(cue.id)}
                  onChange={e => setShot(shot, 'lyricCueIds', e.target.checked ? [...shot.lyricCueIds, cue.id] : shot.lyricCueIds.filter(id => id !== cue.id))} />{cue.text}</label>)}
            </fieldset>
          </details>;
        })}
        </>}
        <button type="button" className={buttonClass} disabled={!dirty || review.busy} onClick={async () => { if (await review.save(draft)) setLocal(null); }}>Save planning edits</button>
        {dirty && <p role="status" className="text-sm">Save edits before preparing, approving or rendering.</p>}
      </div>
    </details>}
  </section>;
}
