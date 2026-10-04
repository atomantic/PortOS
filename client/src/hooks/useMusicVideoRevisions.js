import { useState } from 'react';
import toast from '../components/ui/Toast';
import { toastWorkflowError } from '../components/musicVideo/workflowErrorToast.jsx';
import {
  getMusicVideoProject,
  startMusicVideoDependencyRepair,
  startMusicVideoRevision,
  repairMusicVideoPerformance,
  resumeMusicVideoRevision,
  cancelMusicVideoRevision,
  releaseMusicVideoRevisionSection,
} from '../services/apiMusicVideo.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Selective section revision (#8987): reject a reviewed draft excerpt's
 * flagged sections, regenerate ONLY those, and re-render the draft window —
 * resumable from the server's persisted checkpoint and cancelable.
 *
 * The server decides what may be generated: `resume` answers with the rejected
 * sections that still hold no take and have no job in flight
 * (`needsGeneration`), and this hook submits exactly those through the board's
 * normal scene lanes (`sceneMedia.generateSceneVideo` / `generateFrame`),
 * skipping any the board already has spinning. A section holding a take is
 * never in that list, so resuming after a failed or interrupted render
 * re-renders without paying for any generation again. Once every rejected
 * section holds a take, `resume` starts the draft re-render server-side and
 * its job is adopted into the excerpt job slot (`attachRender`) for progress.
 *
 * `revise(excerptId, sceneIds?)` opens a revision and immediately resumes it.
 *
 * Each submission rides tagged with the revision's id (#9011), so the server
 * can cancel or refuse exactly this revision's own generation and never a
 * board render started by hand for the same scene. `resume` awaits every
 * kickoff's confirmed-submission promise (`generateFrame`/`generateSceneVideo`
 * now return one) before counting it as "generating" — a request that never
 * reached the queue also releases its claim (`release`) so the very next
 * resume can hand that section out again immediately instead of waiting out
 * the server's claim lease.
 *
 * Two kinds of failure are told apart (#9940). A SERVER call that refuses or
 * throws means the action did not happen, so it toasts the error. A throw in
 * the client's own step AFTER the server succeeded — the resume that follows an
 * opened repair, applying the response — means the action DID happen: the
 * persisted record is reloaded (the open revision then offers Resume/Cancel
 * under "Needs attention") and a note says so, never a failure toast that
 * invites retrying completed work.
 *
 * `replaceProject(project)` swaps the local record whole; `sceneMedia` is the
 * `useMusicVideoSceneMedia` result; `attachRender(jobId, projectId)` is
 * `useMusicVideoExcerpts().attachRender`.
 */
export default function useMusicVideoRevisions({ project, replaceProject, sceneMedia, attachRender } = {}) {
  const projectId = project?.id || null;
  const [busy, setBusy] = useState(false);

  // The SERVER call: a failure here means the action did not happen.
  const run = (request) => {
    setBusy(true);
    return request()
      .catch((err) => { toastWorkflowError(err, 'Revision request failed', { reload: reloadProject }); return null; })
      .finally(() => setBusy(false));
  };

  // The record the server holds, for when this tab's own follow-up broke after
  // the server succeeded. Best-effort: a failed reload leaves the next socket
  // event or page load to correct the board.
  const reloadProject = () => getMusicVideoProject(projectId, { silent: true }).then(replaceProject).catch(() => {});

  // Run the client's step that FOLLOWS a successful server call. A throw there
  // is not the server failing: reload the persisted record and say so.
  const settle = (res, step, done) => Promise.resolve()
    .then(() => step(res))
    .then(() => res, (err) => {
      console.error(`❌ Music Video revision follow-up failed: ${err?.message || 'unknown error'}`);
      toast.info(`${done} — it is saved; the board was refreshed.`);
      return reloadProject().then(() => res);
    });

  const generateSections = async (next, refs, revisionId) => {
    const scenes = new Map((next.scenes || []).map((s) => [s.sceneId, s]));
    const kicks = [];
    for (const { sceneId, kind } of refs) {
      const scene = scenes.get(sceneId);
      if (!scene) continue;
      if (kind === 'image') {
        if (sceneMedia?.genScenes?.[sceneId]) continue;
        kicks.push(sceneMedia.generateFrame(scene, { revisionId }).then((r) => ({ sceneId, ok: r?.ok !== false })));
      } else {
        if (sceneMedia?.genVideoScenes?.[sceneId]) continue;
        kicks.push(sceneMedia.generateSceneVideo(scene, { revisionId }).then((r) => ({ sceneId, ok: r?.ok !== false })));
      }
    }
    const results = await Promise.all(kicks);
    const failed = results.filter((r) => !r.ok);
    // Best-effort: a release that itself fails just leaves the section claimed
    // for the rest of the lease — the next resume after it lapses still works.
    await Promise.all(failed.map(({ sceneId }) =>
      releaseMusicVideoRevisionSection(projectId, revisionId, sceneId, { silent: true }).catch(() => {})));
    return results.length - failed.length;
  };

  const callResume = (revisionId) => resumeMusicVideoRevision(projectId, revisionId, { silent: true });

  // The client's half of a resume: adopt the record, adopt a started render,
  // or hand out the sections the server says still need a take.
  const applyResume = async (res, revisionId) => {
    replaceProject(res.project);
    if (res.render?.jobId) {
      attachRender?.(res.render.jobId, res.project.id);
      toast.info('Every revised section has a new take — rendering the revised draft');
      return;
    }
    if (res.revision?.sections?.some((section) => section.state === 'review-needed')) {
      toast.info('Repair needs review — its reserved generation has no usable take; it will not submit again');
      return;
    }
    const submitted = await generateSections(res.project, res.needsGeneration || [], revisionId);
    const waiting = (res.generating || []).length;
    const parts = [
      submitted ? `generating ${plural(submitted, 'section')}` : '',
      waiting ? `${plural(waiting, 'section')} still in progress` : '',
    ].filter(Boolean);
    toast.info(`${parts.join('; ') || 'Waiting on the revised sections'} — resume again once their takes land`);
  };

  // A director's own Resume: the resume request is the server call.
  const resume = (revisionId) => run(() => callResume(revisionId))
    .then((res) => (res ? settle(res, (r) => applyResume(r, revisionId), 'The revision resumed') : null));

  // The follow-up of an open/repair/revise step: the revision it opened is
  // saved, so ANY failure resuming it — the request or what follows — leaves it
  // open and recoverable rather than reporting the opening as failed.
  const resumeOpened = (opened) => {
    if (!opened?.revision) return null;
    const revisionId = opened.revision.id;
    setBusy(true);
    return callResume(revisionId)
      .then((res) => applyResume(res, revisionId).then(() => res))
      .catch((err) => {
        console.error(`❌ Music Video revision ${revisionId.slice(4, 12)} could not resume: ${err?.message || 'unknown error'}`);
        toast.info(`The revision is open but could not continue (${err?.message || 'unknown error'}) — resume or cancel it under "Needs attention" above.`);
        return reloadProject().then(() => null);
      })
      .finally(() => setBusy(false));
  };

  const startRevision = (excerptId, sceneIds) => run(() => startMusicVideoRevision(projectId, excerptId, sceneIds ? { sceneIds } : {}, { silent: true }))
    .then((res) => (res ? settle(res, (r) => {
      replaceProject(r.project);
      if (r.skippedSceneIds?.length) toast.info(`Skipped ${plural(r.skippedSceneIds.length, 'title card')} — edit card text instead`);
    }, 'The revision opened') : null));

  // The one-click path from a review: open the revision, then resume it at
  // once, which generates the rejected sections (an explicit director action).
  const revise = (excerptId, sceneIds) => startRevision(excerptId, sceneIds).then(resumeOpened);

  const repairPerformance = (sceneId, input) => run(() => repairMusicVideoPerformance(projectId, sceneId, input, { silent: true }))
    .then((res) => (res ? settle(res, (r) => replaceProject(r.project), 'The repair revision opened') : null))
    .then(resumeOpened);

  const cancel = (revisionId) => run(() => cancelMusicVideoRevision(projectId, revisionId, { silent: true }))
    .then((res) => (res ? settle(res, (r) => {
      replaceProject(r.project);
      const stopped = r.canceledJobIds?.length || 0;
      toast.info(stopped ? `Revision cancelled — stopped ${plural(stopped, 'generation job')}` : 'Revision cancelled');
    }, 'The revision was cancelled') : null));

  const repair = (basis) => run(() => startMusicVideoDependencyRepair(projectId, basis, { silent: true }))
    .then((res) => (res ? settle(res, (r) => replaceProject(r.project), 'The repair revision opened') : null))
    .then(resumeOpened);

  return { busy, repair, repairPerformance, revise, resume, cancel };
}
