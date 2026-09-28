import { useState } from 'react';
import toast from '../components/ui/Toast';
import {
  startMusicVideoRevision,
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
 * `replaceProject(project)` swaps the local record whole; `sceneMedia` is the
 * `useMusicVideoSceneMedia` result; `attachRender(jobId, projectId)` is
 * `useMusicVideoExcerpts().attachRender`.
 */
export default function useMusicVideoRevisions({ project, replaceProject, sceneMedia, attachRender } = {}) {
  const projectId = project?.id || null;
  const [busy, setBusy] = useState(false);

  const run = (request) => {
    setBusy(true);
    return request()
      .catch((err) => { toast.error(err?.message || 'Revision request failed'); return null; })
      .finally(() => setBusy(false));
  };

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

  const resume = (revisionId) => run(() => resumeMusicVideoRevision(projectId, revisionId, { silent: true })
    .then(async (res) => {
      replaceProject(res.project);
      if (res.render?.jobId) {
        attachRender?.(res.render.jobId, res.project.id);
        toast.info('Every revised section has a new take — rendering the revised draft');
        return res;
      }
      const submitted = await generateSections(res.project, res.needsGeneration || [], revisionId);
      const waiting = (res.generating || []).length;
      const parts = [
        submitted ? `generating ${plural(submitted, 'section')}` : '',
        waiting ? `${plural(waiting, 'section')} still in progress` : '',
      ].filter(Boolean);
      toast.info(`${parts.join('; ') || 'Waiting on the revised sections'} — resume again once their takes land`);
      return res;
    }));

  const startRevision = (excerptId, sceneIds) => run(() => startMusicVideoRevision(projectId, excerptId, sceneIds ? { sceneIds } : {}, { silent: true })
    .then((res) => {
      replaceProject(res.project);
      if (res.skippedSceneIds?.length) toast.info(`Skipped ${plural(res.skippedSceneIds.length, 'title card')} — edit card text instead`);
      return res;
    }));

  // The one-click path from a review: open the revision, then resume it at
  // once, which generates the rejected sections (an explicit director action).
  const revise = (excerptId, sceneIds) => startRevision(excerptId, sceneIds)
    .then((res) => (res?.revision ? resume(res.revision.id) : null));

  const cancel = (revisionId) => run(() => cancelMusicVideoRevision(projectId, revisionId, { silent: true })
    .then((res) => {
      replaceProject(res.project);
      const stopped = res.canceledJobIds?.length || 0;
      toast.info(stopped ? `Revision cancelled — stopped ${plural(stopped, 'generation job')}` : 'Revision cancelled');
      return res;
    }));

  return { busy, revise, resume, cancel };
}
