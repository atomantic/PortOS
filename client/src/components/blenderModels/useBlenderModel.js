import { useState } from 'react';
import toast from '../ui/Toast';
import { useModelLifecycle } from '../../hooks/useModelLifecycle';
import {
  addBlenderModelCamera, addBlenderModelDifference, cancelBlenderModelReview, getBlenderModelReviewLog, removeBlenderModelCamera,
  removeBlenderModelDifference, renderBlenderModelReview, updateBlenderModelCamera, updateBlenderModelDifference,
  addBlenderModelCloseup, attachBlenderModelReferenceImage, createBlenderModelPartsBrief, removeBlenderModelCloseup,
  renderBlenderModelReference, reviewBlenderModelReference, updateBlenderModelReferenceSource,
  buildBlenderModel, cancelBlenderModelBake, cancelBlenderModelBuild, deleteBlenderModelFile, getBlenderModel, getBlenderModelBuildLog, listBlenderModelFiles,
  openBlenderModelBuild, publishBlenderModelBuild, readBlenderModelFile, scaffoldBlenderModel, updateBlenderModel, writeBlenderModelFile,
} from '../../services/apiBlenderModels.js';
import { blenderModelBuildBlocker } from '../../lib/blenderModels.js';

const REVIEW_LOG = 'review:';

/** What BlenderFilesTab and BlenderJobsTab read through FilmApiContext, answered by a model's routes. */
export const BLENDER_MODEL_FILM_API = Object.freeze({
  listMusicVideoBlenderFiles: listBlenderModelFiles,
  getMusicVideoBlenderFile: readBlenderModelFile,
  getMusicVideoBlenderLog: (id, logFile, options) => (logFile.startsWith(REVIEW_LOG)
    ? getBlenderModelReviewLog(id, logFile.slice(REVIEW_LOG.length), options) : getBlenderModelBuildLog(id, logFile, options)),
});

const without = (map, key) => Object.fromEntries(Object.entries(map).filter(([entry]) => entry !== key));

/**
 * One Blender model's state (read once, then on `blender-model:changed`) and
 * every action on it, in the shape the film panel's Files and Jobs tabs take
 * (`blender`). Unsaved source edits live here so they outlive the tab. Mount
 * it keyed by the model id: pending flags and drafts belong to one model.
 * Actions resolve to `{ ok, answer }`; a failure is toasted here.
 */
export default function useBlenderModel(id) {
  const { data, error, loading, refetch, updateData } = useModelLifecycle(id, getBlenderModel, { blender: true });
  const [pending, setPending] = useState({});
  const [fileDrafts, setFileDrafts] = useState({});

  const run = async (key, call, fallback) => {
    if (pending[key]) return { ok: false, answer: null };
    setPending((current) => ({ ...current, [key]: true }));
    const result = await call().then((answer) => ({ ok: true, answer }), (err) => {
      // request() already toasted a host-control refusal.
      if (err?.code !== 'HOST_CONTROL_FORBIDDEN') toast.error(err?.message || fallback);
      return { ok: false, answer: null };
    });
    setPending((current) => without(current, key));
    if (result.answer?.workspace && result.answer?.tool) updateData(result.answer);
    // A refusal usually means the state on screen is out of date; a start or a file write answers without the state.
    else refetch();
    return result;
  };

  const editFile = (path, content) => setFileDrafts((current) => ({ ...current, [path]: content }));
  const discardFile = (path) => setFileDrafts((current) => (path in current ? without(current, path) : current));
  const saveFile = async (path, content) => {
    const result = await run(`file:${path}`, () => writeBlenderModelFile(id, path, content, { silent: true }), 'Could not save the file');
    // An edit typed while the save was in flight stays a draft.
    if (result.ok) setFileDrafts((current) => (current[path] === content ? without(current, path) : current));
    return result;
  };
  const deleteFile = async (path) => {
    const result = await run(`file:${path}`, () => deleteBlenderModelFile(id, path, { silent: true }), 'Could not delete the file');
    if (result.ok) discardFile(path);
    return result;
  };

  const cancelBuild = (buildId, key = `cancel:${buildId}`) => run(key, () => cancelBlenderModelBuild(id, buildId, { silent: true }), 'Could not cancel the build');
  const cancelReview = (buildId, key = `cancelReview:${buildId}`) => run(key, () => cancelBlenderModelReview(id, buildId, { silent: true }), 'Could not cancel the review renders');
  const cancelBake = (buildId, setId, key = `cancelBake:${buildId}:${setId}`) => run(key, () => cancelBlenderModelBake(id, buildId, setId, { silent: true }), 'Could not cancel the bake');
  const cancelOne = (job, key) => {
    if (job.kind === 'bake') return cancelBake(job.buildId, job.setId, key);
    return (job.kind === 'review' ? cancelReview : cancelBuild)(job.buildId, key);
  };
  // Logs are read by build id: build.log in its folder (a bake writes there too), or its review's log.
  const jobs = (data?.jobs || []).map((job) => ({ ...job, logFile: job.kind === 'review' ? `${REVIEW_LOG}${job.buildId}` : job.buildId }));

  return {
    projectId: id, error, loading, refetch, updateData, pending, fileDrafts,
    state: data ? { ...data, jobs } : data,
    // BlenderFilesTab re-lists the tree when this changes.
    filesRevision: data?.workspace?.srcHash ?? null,
    buildBlocker: blenderModelBuildBlocker(data, {
      unsavedFiles: Object.keys(fileDrafts), filesSaving: Object.keys(pending).some((key) => key.startsWith('file:')), starting: !!pending.build,
    }),
    editFile, discardFile, saveFile, deleteFile,
    createWorkspace: () => run('workspace', () => scaffoldBlenderModel(id, { silent: true }), 'Could not create the starter'),
    build: (quality) => run('build', () => buildBlenderModel(id, quality, { silent: true }), 'Could not start the build'),
    cancelBuild,
    // The jobs tab names the job.
    cancelJob: (jobId) => {
      const job = jobs.find((entry) => entry.id === jobId);
      return job ? cancelOne(job, `cancel:${jobId}`) : Promise.resolve({ ok: false, answer: null });
    },
    // At most one build (with its bakes, one at a time) and one review run per model.
    cancelAll: () => Promise.all(jobs.filter((entry) => entry.status === 'queued' || entry.status === 'running')
      .map((job, index) => cancelOne(job, index ? `cancel:${job.id}` : 'cancel:all'))),
    publish: (buildId) => run('publish', () => publishBlenderModelBuild(id, buildId, { silent: true }), 'Could not publish the build'),
    openBuild: (buildId) => run(`open:${buildId}`, () => openBlenderModelBuild(id, buildId, { silent: true }), 'Could not open Blender'),
    update: (patch) => run('update', () => updateBlenderModel(id, patch, { silent: true }), 'Could not save the model'),
    updateReferenceSource: (patch) => run('referenceSource', () => updateBlenderModelReferenceSource(id, patch, { silent: true }), 'Could not save the source'),
    addCloseup: (mechanism) => run('closeup', () => addBlenderModelCloseup(id, mechanism, { silent: true }), 'Could not add the plate'),
    removeCloseup: (referenceId) => run(`remove:${referenceId}`, () => removeBlenderModelCloseup(id, referenceId, { silent: true }), 'Could not remove the plate'),
    renderReference: (referenceId, words) => run(`render:${referenceId}`, () => renderBlenderModelReference(id, referenceId, words, { silent: true }), 'Could not queue the render'),
    attachReference: (referenceId, filename) => run(`attach:${referenceId}`, () => attachBlenderModelReferenceImage(id, referenceId, filename, { silent: true }), 'Could not use that image'),
    reviewReference: (referenceId, imageId, body) => run(`review:${imageId}`, () => reviewBlenderModelReference(id, referenceId, imageId, body, { silent: true }), 'Could not save the review'),
    renderReview: (buildId) => run('review', () => renderBlenderModelReview(id, buildId, { silent: true }), 'Could not start the review renders'),
    cancelReview,
    addCamera: (camera) => run('camera', () => addBlenderModelCamera(id, camera, { silent: true }), 'Could not save the camera'),
    updateCamera: (cameraId, patch) => run('camera', () => updateBlenderModelCamera(id, cameraId, patch, { silent: true }), 'Could not save the camera'),
    removeCamera: (cameraId) => run('camera', () => removeBlenderModelCamera(id, cameraId, { silent: true }), 'Could not remove the camera'),
    addDifference: (difference) => run('difference', () => addBlenderModelDifference(id, difference, { silent: true }), 'Could not add the difference'),
    updateDifference: (differenceId, patch) => run(`difference:${differenceId}`, () => updateBlenderModelDifference(id, differenceId, patch, { silent: true }), 'Could not save the difference'),
    removeDifference: (differenceId) => run(`difference:${differenceId}`, () => removeBlenderModelDifference(id, differenceId, { silent: true }), 'Could not delete the difference'),
    createPartsBrief: () => run('partsBrief', () => createBlenderModelPartsBrief(id, { silent: true }), 'Could not create the parts brief'),
  };
}
