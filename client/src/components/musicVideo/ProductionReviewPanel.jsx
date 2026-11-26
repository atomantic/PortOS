import { useCallback, useMemo, useRef, useState } from 'react';
import { openChangeRequests } from '../../lib/musicVideoStages.js';
import ArtDirectionPlanningForm from './ArtDirectionPlanningForm.jsx';
import ProductionApprovalCard from './ProductionApprovalCard.jsx';
import ProductionFeedbackHistory from './ProductionFeedbackHistory.jsx';
import StoryboardPlanningForm from './StoryboardPlanningForm.jsx';
import { reviewAnchorStyle, reviewButtonClass as buttonClass } from './controlClasses.js';

const EMPTY = { cast: '', environments: '', visualLanguage: '', motionLanguage: '', guideArtifactId: null,
  lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] };

function PlanningDisclosure({ stage, dirty, busy, onSave, children }) {
  // Let the browser own subsequent toggles, even after the URL fragment changes.
  const [initialOpen] = useState(() => window.location.hash === '#mv-review-planning');
  return <details id="mv-review-planning" tabIndex={-1} open={initialOpen || undefined} style={reviewAnchorStyle}>
    <summary className="cursor-pointer min-h-[44px] py-2 text-sm">{stage === 'art' ? 'Edit art direction and visual guide' : 'Edit storyboard shots'}</summary>
    <div className="space-y-3">
      {children}
      <button type="button" className={buttonClass} disabled={!dirty || busy} onClick={onSave}>Save planning edits</button>
      {dirty && <p role="status" className="text-sm">Save edits before preparing, approving or rendering.</p>}
    </div>
  </details>;
}

/**
 * One production approval, with its feedback and planning fields. The page
 * can own the planning state so unsaved edits survive a step switch.
 */
export default function ProductionReviewPanel({ project, review, onOpenArtifact, stage, planning = null, onNavigate = null, onSeek = null }) {
  // Two mounted steps can show the same form without sharing input IDs.
  const fieldId = useCallback(key => `mv-review-${project.id}-${stage}-${key}`, [project.id, stage]);
  const feedbackRef = useRef(null);
  const saved = project.productionReview?.draft || EMPTY;
  const [ownLocal, setOwnLocal] = useState(null);
  const [local, setLocal] = planning || [ownLocal, setOwnLocal];
  const draft = local || saved;
  const savedJson = useMemo(() => JSON.stringify(saved), [saved]);
  const dirty = useMemo(() => !!local && JSON.stringify(local) !== savedJson, [local, savedJson]);
  const ready = review.current === false ? null : review.readiness; // approvals require the current revision
  const blocked = dirty || review.busy || !ready;
  const openRequests = useMemo(() => openChangeRequests(project, stage), [project, stage]);

  const { storyboard, storyboardSource } = draft;
  const { scenes } = project;
  const plannedShots = ready?.storyboard.shots;
  const shots = useMemo(() => {
    if (stage !== 'storyboard' || storyboardSource === 'document') return storyboard;
    // A Board scene without a draft shot shows the shot the server derives for it.
    const boundScenes = new Set(storyboard.map(shot => shot.sceneId));
    return [...storyboard, ...(scenes || []).filter(scene => !boundScenes.has(scene.sceneId)).map(scene => ({
      id: scene.sceneId, sceneId: scene.sceneId, lyricCueIds: [], action: '', staging: '', camera: '', transition: '',
      ...plannedShots?.find(shot => shot.sceneId === scene.sceneId),
    }))];
  }, [stage, storyboard, storyboardSource, scenes, plannedShots]);

  const set = (key, value) => setLocal({ ...draft, [key]: value });
  const save = async () => { if (await review.save(draft)) setLocal(null); };
  const requestChanges = () => feedbackRef.current?.requestChanges();

  return <section id="mv-production-review" aria-label="Production review" className="space-y-3">
    {review.error && <p role="alert" className="text-port-error">{review.error}</p>}
    <ProductionApprovalCard project={project} review={review} ready={ready} saved={saved} stage={stage} shots={shots}
      dirty={dirty} blocked={blocked} openRequests={openRequests} fieldId={fieldId} onRequestChanges={requestChanges}
      onOpenArtifact={onOpenArtifact} onNavigate={onNavigate} onSeek={onSeek} />
    {dirty && <p role="status" className="text-sm">Save your planning edits before approving this revision.</p>}
    <ProductionFeedbackHistory ref={feedbackRef} project={project} review={review} ready={ready} stage={stage} fieldId={fieldId}
      blocked={blocked} openRequests={openRequests} />
    {stage !== 'proof' && <PlanningDisclosure stage={stage} dirty={dirty} busy={review.busy} onSave={save}>
      {stage === 'art' ? <ArtDirectionPlanningForm project={project} review={review} draft={draft} dirty={dirty} fieldId={fieldId}
        set={set} setLocal={setLocal} onOpenArtifact={onOpenArtifact} />
        : <StoryboardPlanningForm project={project} review={review} ready={ready} draft={draft} dirty={dirty} fieldId={fieldId}
          shots={shots} set={set} setLocal={setLocal} />}
    </PlanningDisclosure>}
  </section>;
}
