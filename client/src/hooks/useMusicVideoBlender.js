import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import { useVisibilityEvent } from './useVisibilityEvent.js';
import {
  assembleMusicVideoBlenderCut, cancelMusicVideoBlenderJob, cancelMusicVideoBlenderJobs, clearMusicVideoBlenderFrames, createMusicVideoBlenderWorkspace,
  deleteMusicVideoBlenderFile, getMusicVideoBlender, openMusicVideoBlenderShot, renderMusicVideoBlender,
  saveMusicVideoBlenderFile, saveMusicVideoBlenderSettings, saveMusicVideoBlenderShotNote, syncMusicVideoBlender,
} from '../services/apiMusicVideo.js';
import {
  blenderOptionChanges, blenderOptionFields, blenderRenderBlocker, blenderShotRenderBlocker, changedBlenderSettings, isBlenderJobTerminal, mergeBlenderJob,
} from '../lib/musicVideoBlender.js';

const EMPTY_DRAFTS = Object.freeze({ settings: {}, options: {}, notes: {}, files: {} });
// What a settings save sends: the changed fields, plus the changed film options under `options`.
const settingsSaveBody = (state, drafts) => {
  const changes = changedBlenderSettings(state?.settings, drafts.settings);
  const options = blenderOptionChanges(state?.manifest?.options, state?.settings?.options, drafts.options);
  return Object.keys(options).length ? { ...changes, options } : changes;
};
const isBlenderState = (answer) => !!answer && typeof answer === 'object' && 'settings' in answer && 'workspace' in answer;
const without = (map, key) => {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
};

/**
 * A project's Blender film: the server's state, live job progress and every
 * action on it. The state is read once, then kept current by the
 * `music-video:blender` socket channel — a `job` message folds into the job
 * list at once, and a finished job, a `state` message, a reconnect or the tab
 * coming back re-reads it. Never polled.
 *
 * One read runs at a time (a request for another while it is in flight runs
 * once it settles), and a job frame that arrived after a read was issued
 * outlives that read's older answer. Unsaved form state lives here too
 * (`drafts`: changed settings, shot notes, source files), so it survives the
 * panel unmounting when the director changes step. Off (`state` null, no
 * request, no listener) while `enabled` is false.
 *
 * Actions resolve to `{ ok, answer, error }`; a failure is toasted here.
 */
export default function useMusicVideoBlender(projectId, { enabled = true } = {}) {
  const [state, setState] = useState(null);
  const [status, setStatus] = useState(enabled && projectId ? 'loading' : 'idle');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState({});
  const [drafts, setDrafts] = useState(EMPTY_DRAFTS);
  // Bumped when the source tree may have changed under the Files list.
  const [filesRevision, setFilesRevision] = useState(0);
  // Bumped when what the workspace holds on disk may have changed (a job ended, frames were cleared).
  const [usageRevision, setUsageRevision] = useState(0);

  // Bumps when the project changes or the hook goes away: late answers are dropped.
  const generation = useRef(0);
  // Logical time shared by reads, mutations and socket frames, so "which is newer" is strict.
  const clock = useRef(0);
  const appliedAt = useRef(0);
  // Job frames newer than the state on screen: jobId -> { job, at }.
  const liveJobs = useRef(new Map());
  const reading = useRef(null);
  const rereadQueued = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const applyState = (next, issuedAt) => {
    if (issuedAt < appliedAt.current) return false;
    appliedAt.current = issuedAt;
    const newer = [...liveJobs.current].filter(([, entry]) => entry.at > issuedAt);
    liveJobs.current = new Map(newer);
    // A socket frame newer than this read wins over its copy of the job. A start's answer only
    // fills in a job the read does not list: a read that lists it was served after the start.
    const listed = new Set((next.jobs || []).map((job) => job.id));
    const jobs = newer.reduce((list, [, entry]) => (entry.queued && listed.has(entry.job.id) ? list : mergeBlenderJob(list, entry.job)), next.jobs || []);
    setState({ ...next, jobs });
    return true;
  };

  const read = useRef(null);
  read.current = () => {
    if (!projectId || !enabled) return Promise.resolve(null);
    if (reading.current) {
      rereadQueued.current = true;
      return reading.current;
    }
    const issued = generation.current;
    const issuedAt = ++clock.current;
    const request = getMusicVideoBlender(projectId, { silent: true })
      .then((next) => {
        if (issued !== generation.current) return null;
        applyState(next, issuedAt);
        setStatus('ready');
        setError(null);
        return next;
      })
      .catch((err) => {
        if (issued !== generation.current) return null;
        setError(err?.message || 'Could not read the Blender film');
        // A failed refresh keeps the last good state on screen.
        setStatus((current) => (current === 'ready' ? current : 'error'));
        return null;
      })
      .finally(() => {
        if (issued !== generation.current) return;
        reading.current = null;
        if (rereadQueued.current) {
          rereadQueued.current = false;
          read.current();
        }
      });
    reading.current = request;
    return request;
  };
  const refresh = useCallback(() => read.current(), []);

  useEffect(() => {
    generation.current += 1;
    appliedAt.current = 0;
    liveJobs.current = new Map();
    reading.current = null;
    rereadQueued.current = false;
    setState(null);
    setError(null);
    setPending({});
    setDrafts(EMPTY_DRAFTS);
    if (!projectId || !enabled) {
      setStatus('idle');
      return undefined;
    }
    setStatus('loading');
    read.current();
    const onMessage = (message) => {
      if (message?.projectId !== projectId) return;
      if (message.kind === 'job' && message.job?.id) {
        liveJobs.current.set(message.job.id, { job: message.job, at: ++clock.current });
        setState((current) => (current ? { ...current, jobs: mergeBlenderJob(current.jobs, message.job) } : current));
        // A finished job changed the renders, cuts or manifest it wrote.
        if (isBlenderJobTerminal(message.job)) {
          setUsageRevision((revision) => revision + 1);
          read.current();
        }
        return;
      }
      if (message.kind === 'state') {
        setFilesRevision((revision) => revision + 1);
        setUsageRevision((revision) => revision + 1);
        read.current();
      }
    };
    // A terminal message sent while the socket was down is never replayed.
    const onConnect = () => {
      setFilesRevision((revision) => revision + 1);
      read.current();
    };
    socket.on('music-video:blender', onMessage);
    socket.on('connect', onConnect);
    return () => {
      generation.current += 1;
      socket.off('music-video:blender', onMessage);
      socket.off('connect', onConnect);
    };
  }, [projectId, enabled]);

  // Scripts edited on disk raise no event: staleness is recomputed when the director comes back.
  useVisibilityEvent((visibility) => { if (visibility === 'visible') read.current(); });

  const applyAnswer = (answer, issuedAt) => {
    if (isBlenderState(answer)) {
      // A newer read already landed: read again instead of painting this older answer over it.
      if (!applyState(answer, issuedAt)) read.current();
      return;
    }
    // A start answers with the jobs it queued. A socket frame that beat this response is the
    // newer reading of that job. Otherwise the job is held as known from now, so a read still in
    // flight that was served before the start cannot drop it (and re-enable its Render button).
    const queued = [...(Array.isArray(answer?.jobs) ? answer.jobs : []), ...(answer?.job ? [answer.job] : [])]
      .filter((job) => job?.id && !liveJobs.current.has(job.id));
    if (!queued.length) return;
    for (const job of queued) liveJobs.current.set(job.id, { job, at: ++clock.current, queued: true });
    setState((current) => {
      if (!current) return current;
      const unseen = queued.filter((job) => !(current.jobs || []).some((entry) => entry.id === job.id));
      return unseen.length ? { ...current, jobs: unseen.reduce(mergeBlenderJob, current.jobs) } : current;
    });
  };

  const run = (key, call, fallback, { reread = false, quiet = [] } = {}) => {
    const issued = generation.current;
    const issuedAt = ++clock.current;
    setPending((current) => ({ ...current, [key]: true }));
    // The request leaves in this tick (so a click is on the wire before anything re-renders); a
    // synchronous throw still lands in the catch below.
    return new Promise((resolve) => { resolve(call()); })
      .then((answer) => {
        if (issued !== generation.current) return { ok: false, answer: null, error: null };
        applyAnswer(answer, issuedAt);
        if (reread && !isBlenderState(answer)) read.current();
        return { ok: true, answer, error: null };
      })
      .catch((err) => {
        if (issued !== generation.current) return { ok: false, answer: null, error: err };
        // request() already toasted a host-control refusal; the caller shows the quiet codes itself.
        if (err?.code !== 'HOST_CONTROL_FORBIDDEN' && !quiet.includes(err?.code)) toast.error(err?.message || fallback);
        // A refusal about the workspace or Blender setup means the state on screen is out of date.
        if (err?.status === 409) read.current();
        return { ok: false, answer: null, error: err };
      })
      .finally(() => {
        if (issued === generation.current) setPending((current) => without(current, key));
      });
  };

  // ---- settings ------------------------------------------------------------
  const savedSettings = state?.settings;
  const declaredOptions = state?.manifest?.options;
  const settingsChanges = useMemo(() => settingsSaveBody({ settings: savedSettings, manifest: { options: declaredOptions } }, drafts),
    [savedSettings, declaredOptions, drafts]);
  const settingsDirty = Object.keys(settingsChanges).length > 0;
  const settings = useMemo(() => ({ ...(savedSettings || {}), ...drafts.settings }), [savedSettings, drafts.settings]);
  // The film's options as the form shows them: value in effect, dirty, and why a value would be refused.
  const optionFields = useMemo(() => blenderOptionFields(declaredOptions, savedSettings?.options, drafts.options),
    [declaredOptions, savedSettings, drafts.options]);
  const editSettings = useCallback((patch) => setDrafts((current) => ({ ...current, settings: { ...current.settings, ...patch } })), []);
  const editOption = useCallback((key, value) => setDrafts((current) => ({ ...current, options: { ...current.options, [key]: value } })), []);
  const discardSettings = useCallback(() => setDrafts((current) => ({ ...current, settings: {}, options: {} })), []);
  const saveSettings = async () => {
    const drafted = draftsRef.current;
    const changes = settingsSaveBody(stateRef.current, drafted);
    if (!Object.keys(changes).length || pending.settings) return { ok: false, answer: null, error: null };
    const result = await run('settings', () => saveMusicVideoBlenderSettings(projectId, changes, { silent: true }), 'Could not save the render settings');
    if (!result.ok) return result;
    // Every settings save answers with the film state; a server that did not is re-read rather than guessed at.
    if (!isBlenderState(result.answer)) read.current();
    // Fields edited again while the save was in flight stay as drafts.
    const unsent = (now, sent) => Object.fromEntries(Object.entries(now).filter(([field, value]) => value !== sent[field]));
    setDrafts((current) => ({ ...current, settings: unsent(current.settings, drafted.settings), options: unsent(current.options, drafted.options) }));
    return result;
  };

  // ---- shot notes ----------------------------------------------------------
  const editNote = useCallback((shotId, patch) => setDrafts((current) => ({
    ...current, notes: { ...current.notes, [shotId]: { ...current.notes[shotId], ...patch } },
  })), []);
  const discardNote = useCallback((shotId) => setDrafts((current) => ({ ...current, notes: without(current.notes, shotId) })), []);
  const noteChanges = (shotId) => {
    const saved = stateRef.current?.notes?.[shotId] || {};
    const draft = draftsRef.current.notes[shotId] || {};
    const changes = {};
    if (draft.text !== undefined && draft.text !== (saved.text || '')) changes.text = draft.text;
    if (draft.status !== undefined && draft.status !== (saved.status || 'todo')) changes.status = draft.status;
    return changes;
  };
  const saveNote = async (shotId) => {
    const changes = noteChanges(shotId);
    if (!Object.keys(changes).length || pending[`note:${shotId}`]) return { ok: false, answer: null, error: null };
    const result = await run(`note:${shotId}`, () => saveMusicVideoBlenderShotNote(projectId, shotId, changes, { silent: true }), 'Could not save the note');
    if (!result.ok) return result;
    if (!isBlenderState(result.answer)) {
      setState((current) => (current ? {
        ...current,
        notes: { ...current.notes, [shotId]: { status: 'todo', text: '', ...current.notes?.[shotId], ...changes, updatedAt: new Date().toISOString() } },
      } : current));
    }
    setDrafts((current) => {
      const draft = current.notes[shotId] || {};
      const rest = Object.fromEntries(Object.entries(draft).filter(([field, value]) => !(field in changes) || value !== changes[field]));
      return { ...current, notes: Object.keys(rest).length ? { ...current.notes, [shotId]: rest } : without(current.notes, shotId) };
    });
    return result;
  };

  // ---- source files --------------------------------------------------------
  const editFile = useCallback((path, content) => setDrafts((current) => ({ ...current, files: { ...current.files, [path]: content } })), []);
  const discardFile = useCallback((path) => setDrafts((current) => ({ ...current, files: without(current.files, path) })), []);
  const saveFile = async (path, content) => {
    if (pending[`file:${path}`]) return { ok: false, answer: null, error: null };
    const result = await run(`file:${path}`, () => saveMusicVideoBlenderFile(projectId, { path, content }, { silent: true }), 'Could not save the file', { reread: true });
    if (!result.ok) return result;
    setDrafts((current) => (current.files[path] === content ? { ...current, files: without(current.files, path) } : current));
    setFilesRevision((revision) => revision + 1);
    return result;
  };
  const deleteFile = async (path) => {
    const result = await run(`file:${path}`, () => deleteMusicVideoBlenderFile(projectId, path, { silent: true }), 'Could not delete the file', { reread: true });
    if (!result.ok) return result;
    discardFile(path);
    setFilesRevision((revision) => revision + 1);
    return result;
  };

  // ---- runs ----------------------------------------------------------------
  const createWorkspace = () => run('workspace', () => createMusicVideoBlenderWorkspace(projectId, { template: 'starter' }, { silent: true }),
    'Could not create the starter workspace', { reread: true }).then((result) => {
    if (result.ok) setFilesRevision((revision) => revision + 1);
    return result;
  });
  // A sync is a background job: this resolves once it is queued, and its end arrives on the socket
  // like a render's. One that would drop storyboard scenes it does not own is refused before it
  // starts; the caller asks, then passes `replaceScenes`.
  const sync = ({ replaceScenes = false } = {}) => run('sync', () => syncMusicVideoBlender(projectId, replaceScenes ? { replaceScenes: true } : {}, { silent: true }),
    'Could not start the sync', { quiet: ['MUSIC_VIDEO_BLENDER_SCENES_CONFLICT'] });
  const render = (body, key = 'bulk') => run(`render:${key}:${body.quality}`, () => renderMusicVideoBlender(projectId, body, { silent: true }), 'Could not start the render')
    .then((result) => {
      // The server decides what a request covers; when that is nothing, say so instead of doing nothing.
      if (result.ok && Array.isArray(result.answer?.jobs) && !result.answer.jobs.length) toast.info('Nothing to render: every shot in this request is already up to date.');
      return result;
    });
  // Answers `{ freedBytes, usage }`: the caller shows the new numbers from the answer itself.
  const clearFrames = () => run('frames:clear', () => clearMusicVideoBlenderFrames(projectId, { silent: true }), 'Could not clear the rendered frames', { reread: true });
  const cancelJob = (jobId) => run(`cancel:${jobId}`, () => cancelMusicVideoBlenderJob(projectId, jobId, { silent: true }), 'Could not cancel the job', { reread: true });
  const cancelAll = () => run('cancel:all', () => cancelMusicVideoBlenderJobs(projectId, { silent: true }), 'Could not cancel the jobs', { reread: true });
  const assembleCut = (body) => run(`cut:${body.quality}`, () => assembleMusicVideoBlenderCut(projectId, body, { silent: true }), 'Could not start the cut');
  const openShot = (shotId) => run(`open:${shotId}`, () => openMusicVideoBlenderShot(projectId, shotId, { silent: true }), 'Could not open Blender');

  // One answer for every "can a sync or a render start?" control, so they cannot disagree.
  const settingsSaving = !!pending.settings;
  const filesSaving = Object.keys(pending).some((key) => key.startsWith('file:'));
  const runBlocker = useMemo(
    () => blenderRenderBlocker(state, { settingsDirty, settingsSaving, unsavedFiles: Object.keys(drafts.files), filesSaving }),
    [state, settingsDirty, settingsSaving, drafts.files, filesSaving],
  );
  // A render also waits for a sync when the frame rate moved off the one the shots were synced at.
  const renderBlocker = useMemo(() => blenderShotRenderBlocker(state, runBlocker), [state, runBlocker]);

  return {
    projectId, state, status, error, refresh, pending, filesRevision, usageRevision, runBlocker, renderBlocker,
    settings, settingsChanges, settingsDirty, settingsSaving, editSettings, discardSettings, saveSettings,
    optionFields, editOption,
    noteDrafts: drafts.notes, editNote, discardNote, saveNote,
    fileDrafts: drafts.files, editFile, discardFile, saveFile, deleteFile,
    createWorkspace, sync, render, cancelJob, cancelAll, assembleCut, openShot, clearFrames,
  };
}
