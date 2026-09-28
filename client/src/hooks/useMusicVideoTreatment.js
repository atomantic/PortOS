import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  getMusicVideoProject,
  updateMusicVideoTreatment,
  compileMusicVideoTreatment,
  previewMusicVideoTreatmentApply,
  applyMusicVideoTreatment,
  reviewMusicVideoTreatmentProof,
} from '../services/apiMusicVideo.js';

const AI_SKIP_LABELS = {
  'no-provider': 'no AI provider is configured',
  'provider-disabled': 'the AI provider is disabled',
  'llm-failed': 'the AI call failed',
  'unparsable-response': 'the AI answer was unusable',
  'too-many-shots': 'too many shots for one AI pass',
};

/**
 * The Music Video pre-production treatment (#8980): brief/arc/shot-direction
 * edits, compile, the Apply review and proof verdicts.
 *
 * Every write names the treatment revision it was based on. Writes run one at
 * a time and each reads the revision the previous response returned, so quick
 * successive blurs never conflict with each other; a 409 from a genuinely
 * newer copy (another tab, a peer) reloads the project instead of retrying.
 *
 * `onProjectPatch(projectId, patch)` merges fields into the local record;
 * `replaceProject(project)` swaps it whole (Apply and a conflict reload touch
 * scenes and composition too).
 */
export default function useMusicVideoTreatment({ project, onProjectPatch, replaceProject } = {}) {
  const projectId = project?.id || null;
  const storedRevision = project?.treatment?.revision ?? 0;
  const revisionRef = useRef(storedRevision);
  const chainRef = useRef(Promise.resolve());
  const [compiling, setCompiling] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);

  const projectRef = useRef(projectId);
  // A newer revision can arrive from outside this hook (a peer update, a
  // reload); within one project never move the ref backwards past a write this
  // hook already made. A project switch adopts that project's revision.
  useEffect(() => {
    if (projectRef.current !== projectId) {
      projectRef.current = projectId;
      revisionRef.current = storedRevision;
    } else {
      revisionRef.current = Math.max(revisionRef.current, storedRevision);
    }
  }, [projectId, storedRevision]);
  useEffect(() => { setPreview(null); }, [projectId]);

  const adopt = (id, treatment) => {
    revisionRef.current = treatment?.revision ?? revisionRef.current;
    onProjectPatch?.(id, { treatment });
  };

  const handleConflict = (id, err, fallback) => {
    if (err?.status === 409 && err?.code === 'TREATMENT_REVISION_CONFLICT') {
      toast.error('The treatment changed elsewhere — reloaded the latest version');
      return getMusicVideoProject(id, { silent: true }).then((fresh) => {
        revisionRef.current = fresh?.treatment?.revision ?? 0;
        replaceProject?.(fresh);
      }).catch(() => {});
    }
    toast.error(err?.message || fallback);
    return null;
  };

  // Serialize treatment writes; each reads the latest known revision when it runs.
  const enqueue = (work, fallback) => {
    const id = projectId;
    const run = chainRef.current.then(() => work(id, revisionRef.current));
    chainRef.current = run.catch((err) => handleConflict(id, err, fallback));
    return run.catch(() => null);
  };

  const save = (patch) => enqueue(
    (id, baseRevision) => updateMusicVideoTreatment(id, { ...patch, baseRevision }, { silent: true })
      .then(({ treatment }) => { adopt(id, treatment); setPreview(null); return treatment; }),
    'Failed to save the treatment',
  );

  const compile = ({ useAi, providerId, model }) => {
    setCompiling(true);
    return enqueue(
      (id, baseRevision) => compileMusicVideoTreatment(id, {
        baseRevision,
        useAi,
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
      }, { silent: true }).then(({ treatment, aiUsed, aiSkippedReason }) => {
        adopt(id, treatment);
        setPreview(null);
        const shots = treatment.shotDirections.length;
        if (useAi && !aiUsed) toast.error(`Drafted without AI — ${AI_SKIP_LABELS[aiSkippedReason] || aiSkippedReason}`);
        else toast.success(`Treatment compiled for ${shots} shot${shots === 1 ? '' : 's'}${aiUsed ? ' with AI' : ''}`);
        return treatment;
      }),
      'Treatment compile failed',
    ).finally(() => setCompiling(false));
  };

  const loadPreview = () => {
    const id = projectId;
    setPreviewing(true);
    return previewMusicVideoTreatmentApply(id, { silent: true })
      .then((data) => { if (id === projectRef.current) setPreview(data); })
      .catch((err) => toast.error(err?.message || 'Could not review the treatment'))
      .finally(() => setPreviewing(false));
  };

  const apply = ({ overwrite = [], addTextCues = false } = {}) => {
    if (!preview) return Promise.resolve(null);
    const id = projectId;
    const { revision } = preview;
    setApplying(true);
    return chainRef.current
      .then(() => applyMusicVideoTreatment(id, { revision, overwrite, addTextCues }, { silent: true }))
      .then(({ project: next, result }) => {
        replaceProject?.(next);
        setPreview(null);
        const kept = result.promptsKept.length + result.conflicted.length;
        toast.success(`Applied direction to ${result.directed} scene${result.directed === 1 ? '' : 's'}${kept ? ` — ${kept} hand-edited prompt${kept === 1 ? '' : 's'} kept` : ''}${result.textCuesAdded ? `, ${result.textCuesAdded} text cues added` : ''}`);
        return result;
      })
      .catch((err) => {
        // A stale review re-reads the preview so the director sees what changed.
        if (err?.status === 409) loadPreview();
        toast.error(err?.message || 'Apply failed');
        return null;
      })
      .finally(() => setApplying(false));
  };

  const reviewProof = (proofId, review) => enqueue(
    (id, baseRevision) => reviewMusicVideoTreatmentProof(id, proofId, { ...review, baseRevision }, { silent: true })
      .then(({ treatment }) => { adopt(id, treatment); return treatment; }),
    'Failed to record the proof review',
  );

  return {
    compiling, preview, previewing, applying,
    save, compile, loadPreview, apply, reviewProof,
    clearPreview: () => setPreview(null),
  };
}
