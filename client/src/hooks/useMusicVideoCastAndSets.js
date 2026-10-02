import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import { subscribeVisibility } from './useVisibilityEvent';
import {
  getMusicVideoProject,
  startMusicVideoCastAndSets,
  regenerateMusicVideoCastAndSets,
  editMusicVideoCastAndSetsDirection,
  resumeMusicVideoCastAndSets,
  approveMusicVideoCastAndSets,
  skipMusicVideoCastAndSets,
} from '../services/apiMusicVideo.js';

// Where a stage stops needing the server: the autopilot continues past an
// approved or skipped one, and waits for the director at `review` or `failed`.
const CHECKPOINTS = new Set(['review', 'approved', 'skipped', 'failed']);

/**
 * The Cast & Sets check-in (runs before the shot plan). The server does the
 * work — direction, reference images, the sheet — and pushes every step over
 * `music-video:cast-and-sets` (and artifact edits over
 * `music-video:dev-artifact`); this hook applies the project it pushes (no
 * polling) and exposes the director's actions.
 *
 * `runToCheckpoint(project)` is the autopilot kickoff's step: it starts the
 * check-in when there is none and resolves with the project once the stage
 * reaches a checkpoint (`review`, `approved`, `skipped`, `failed`), or null
 * when it could not start.
 *
 * Returns `{ busy, start, regenerate, editDirection, resume, approve, skip, runToCheckpoint }`.
 */
export default function useMusicVideoCastAndSets({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const [busy, setBusy] = useState(false);
  const replaceRef = useRef(replaceProject);
  const snapshotRevision = useRef(0);
  const waiter = useRef(null);
  useEffect(() => {
    replaceRef.current = replaceProject;
  }, [replaceProject]);
  useEffect(() => {
    snapshotRevision.current += 1;
  }, [project]);

  useEffect(() => {
    if (!projectId) return undefined;
    let active = true;
    let pending = null;
    const applyProject = (next) => {
      snapshotRevision.current += 1;
      replaceRef.current?.(next);
      const w = waiter.current;
      if (w && w.projectId === projectId && CHECKPOINTS.has(next.castAndSets?.status)) {
        waiter.current = null;
        w.resolve(next);
      }
    };
    const onStage = (data) => {
      if (data?.projectId !== projectId || !data.project) return;
      applyProject(data.project);
    };
    const onArtifact = (data) => {
      if (data?.projectId === projectId && data.project) applyProject(data.project);
    };
    // Recover events missed while disconnected or hidden, once per transition.
    // A newer socket snapshot or a project switch wins over an in-flight read.
    const refresh = () => {
      if (pending) return pending;
      const revision = snapshotRevision.current;
      pending = getMusicVideoProject(projectId, { silent: true }).then((next) => {
        if (active && next?.id === projectId && revision === snapshotRevision.current) applyProject(next);
      }).catch(() => {}).finally(() => { pending = null; });
      return pending;
    };
    socket.on('music-video:cast-and-sets', onStage);
    socket.on('music-video:dev-artifact', onArtifact);
    socket.on('connect', refresh);
    let visibility = document.visibilityState;
    const unsubscribeVisibility = subscribeVisibility((next) => {
      const changed = visibility !== next;
      visibility = next;
      if (changed && next === 'visible') refresh();
    });
    return () => {
      active = false;
      unsubscribeVisibility();
      socket.off('music-video:cast-and-sets', onStage);
      socket.off('music-video:dev-artifact', onArtifact);
      socket.off('connect', refresh);
      // A kickoff waiting on this project ends rather than hanging.
      if (waiter.current?.projectId === projectId) {
        waiter.current.resolve(null);
        waiter.current = null;
      }
    };
  }, [projectId]);

  const call = (request, success) => {
    setBusy(true);
    return request()
      .then((res) => {
        if (res?.project) replaceRef.current?.(res.project);
        if (success) toast.success(success);
        return res;
      })
      .catch((err) => { toast.error(err?.message || 'Cast & Sets request failed'); return null; })
      .finally(() => setBusy(false));
  };

  const start = () => call(() => startMusicVideoCastAndSets(projectId, {}, { silent: true }));
  const regenerate = (notes) => call(() => regenerateMusicVideoCastAndSets(projectId, notes ? { notes } : {}, { silent: true }), 'Regenerating with your notes');
  const editDirection = (edits) => call(() => editMusicVideoCastAndSetsDirection(projectId, edits, { silent: true }), 'Direction saved — re-rendering what changed');
  const resume = () => call(() => resumeMusicVideoCastAndSets(projectId, { silent: true }));
  const approve = () => call(() => approveMusicVideoCastAndSets(projectId, { silent: true }), 'Cast & Sets approved');
  const skip = () => call(() => skipMusicVideoCastAndSets(projectId, { silent: true }), 'Cast & Sets check-in skipped');

  const runToCheckpoint = (target) => {
    if (!target?.id) return Promise.resolve(null);
    const status = target.castAndSets?.status;
    if (CHECKPOINTS.has(status)) return Promise.resolve(target);
    const reached = new Promise((resolve) => { waiter.current = { projectId: target.id, resolve }; });
    // A stage already underway just needs watching; otherwise start one.
    if (status) return reached;
    return startMusicVideoCastAndSets(target.id, {}, { silent: true })
      .then((res) => {
        if (res?.project) replaceRef.current?.(res.project);
        return reached;
      })
      .catch((err) => {
        waiter.current = null;
        toast.error(err?.message || 'Could not start the Cast & Sets check-in');
        return null;
      });
  };

  return { busy, start, regenerate, editDirection, resume, approve, skip, runToCheckpoint };
}
