import { useState } from 'react';
import toast from '../ui/Toast';
import { useModelLifecycle } from '../../hooks/useModelLifecycle';
import {
  addBlenderModelCloseup, attachBlenderModelReferenceImage, createBlenderModelPartsBrief, removeBlenderModelCloseup,
  renderBlenderModelReference, reviewBlenderModelReference, updateBlenderModelReferenceSource,
  buildBlenderModel, cancelBlenderModelBuild, deleteBlenderModelFile, getBlenderModel, getBlenderModelBuildLog, listBlenderModelFiles,
  openBlenderModelBuild, publishBlenderModelBuild, readBlenderModelFile, scaffoldBlenderModel, updateBlenderModel, writeBlenderModelFile,
} from '../../services/apiBlenderModels.js';
import { blenderModelBuildBlocker } from '../../lib/blenderModels.js';

/** What BlenderFilesTab and BlenderJobsTab read through FilmApiContext, answered by a model's routes. */
export const BLENDER_MODEL_FILM_API = Object.freeze({
  listMusicVideoBlenderFiles: listBlenderModelFiles,
  getMusicVideoBlenderFile: readBlenderModelFile,
  getMusicVideoBlenderLog: getBlenderModelBuildLog,
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
  // A build's log is build.log in its folder, read by build id.
  const jobs = (data?.jobs || []).map((job) => ({ ...job, logFile: job.buildId }));

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
      return job ? cancelBuild(job.buildId, `cancel:${jobId}`) : Promise.resolve({ ok: false, answer: null });
    },
    // One build runs per model, so "all" is the one at work.
    cancelAll: () => {
      const job = jobs.find((entry) => entry.status === 'queued' || entry.status === 'running');
      return job ? cancelBuild(job.buildId, 'cancel:all') : Promise.resolve({ ok: false, answer: null });
    },
    publish: (buildId) => run('publish', () => publishBlenderModelBuild(id, buildId, { silent: true }), 'Could not publish the build'),
    openBuild: (buildId) => run(`open:${buildId}`, () => openBlenderModelBuild(id, buildId, { silent: true }), 'Could not open Blender'),
    update: (patch) => run('update', () => updateBlenderModel(id, patch, { silent: true }), 'Could not save the model'),
    updateReferenceSource: (patch) => run('referenceSource', () => updateBlenderModelReferenceSource(id, patch, { silent: true }), 'Could not save the source'),
    addCloseup: (mechanism) => run('closeup', () => addBlenderModelCloseup(id, mechanism, { silent: true }), 'Could not add the plate'),
    removeCloseup: (referenceId) => run(`remove:${referenceId}`, () => removeBlenderModelCloseup(id, referenceId, { silent: true }), 'Could not remove the plate'),
    renderReference: (referenceId, words) => run(`render:${referenceId}`, () => renderBlenderModelReference(id, referenceId, words, { silent: true }), 'Could not queue the render'),
    attachReference: (referenceId, filename) => run(`attach:${referenceId}`, () => attachBlenderModelReferenceImage(id, referenceId, filename, { silent: true }), 'Could not use that image'),
    reviewReference: (referenceId, imageId, body) => run(`review:${imageId}`, () => reviewBlenderModelReference(id, referenceId, imageId, body, { silent: true }), 'Could not save the review'),
    createPartsBrief: () => run('partsBrief', () => createBlenderModelPartsBrief(id, { silent: true }), 'Could not create the parts brief'),
  };
}
