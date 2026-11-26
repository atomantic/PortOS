import { useEffect, useRef, useState } from 'react';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import { cancelCatalogPhotorealRender, getCatalogPhotoreal } from '../../services/apiCatalog';
import { useVisibilityEvent } from '../../hooks/useVisibilityEvent';

const STATUS_TIMEOUT_MS = 15_000;

/** Keep the Photoreal job and scene availability current across socket and HTTP updates. */
export default function usePhotorealStatus(ingredientId, onRendered) {
  const [status, setStatus] = useState(null);
  const [statusRefreshing, setStatusRefreshing] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [cancelingJobId, setCancelingJobId] = useState(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  const controls = useRef(null);

  useEffect(() => {
    // Ids seen running here let a reconnect act on a finish it missed.
    const seenRunning = new Set();
    const finished = new Set();
    let live = true;
    let request = 0;
    let jobFrames = 0;
    let currentJob = null;
    let reconcileNeeded = false;
    let activeRequest = null;
    const cancelStatus = () => {
      activeRequest?.abort();
      activeRequest = null;
    };
    const refreshStatus = () => loadStatus('refresh');
    // The server emits a frame when a job starts or settles, so a
    // finish seen while the tab is open is news: act on it once, whatever order
    // the start response, status read or a reconnect read land in.
    const settle = (next) => {
      if (next.state === 'running') { seenRunning.add(next.id); return; }
      if (finished.has(next.id)) return;
      finished.add(next.id);
      if (next.state === 'done') {
        onRenderedRef.current?.();
        refreshStatus();
      } else if (next.state === 'failed') {
        toast.error(`Blender render failed: ${next.error || 'unknown error'}`);
      }
    };
    const loadStatus = (kind) => {
      const sequence = ++request;
      const framesAtStart = jobFrames;
      if (kind === 'reconcile') reconcileNeeded = true;
      cancelStatus();
      const controller = new AbortController();
      activeRequest = controller;
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Scene status request canceled')), { once: true }));
      const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
      setStatusRefreshing(true);
      return Promise.race([getCatalogPhotoreal(ingredientId, { silent: true, signal: controller.signal }), aborted])
        .then((fresh) => {
          if (!live || sequence !== request) return;
          setStatusRefreshing(false);
          setStatusError('');
          const newerJobFrame = framesAtStart !== jobFrames;
          const reconcileJob = reconcileNeeded;
          reconcileNeeded = false;
          const preserveJob = newerJobFrame || (!reconcileJob && kind === 'refresh');
          currentJob = preserveJob ? currentJob ?? fresh.job : fresh.job;
          if (currentJob?.state === 'running') seenRunning.add(currentJob.id);
          setStatus({ ...fresh, job: currentJob });
          if (reconcileJob && fresh?.job && seenRunning.has(fresh.job.id)) {
            // A newer frame owns the visible job, but an older, different job
            // may still need its missed completion handled once.
            if (!newerJobFrame || currentJob?.id !== fresh.job.id) settle(fresh.job);
          }
        })
        .catch(() => {
          if (!live || sequence !== request) return;
          setStatusRefreshing(false);
          setStatusError('Could not refresh the scene status. Try again before opening or rendering.');
        })
        .finally(() => {
          clearTimeout(timer);
          if (activeRequest === controller) activeRequest = null;
        });
    };
    const receiveJob = (next, expectedJobId) => {
      if (expectedJobId !== undefined && (currentJob?.id ?? null) !== expectedJobId && currentJob?.id !== next.id) return;
      if (next.state === 'running' && finished.has(next.id)) return;
      jobFrames += 1;
      currentJob = next;
      setStatus((cur) => ({ ...cur, job: next }));
      settle(next);
    };
    loadStatus('initial');
    const onFrame = (frame) => {
      if (frame?.ingredientId === ingredientId && frame.job) receiveJob(frame.job);
    };
    const onScene = (frame) => { if (frame?.ingredientId === ingredientId) refreshStatus(); };
    // A sleeping laptop or dropped socket can miss the one finish frame: re-read
    // the server's job and settle a render this tab saw running.
    const reconcile = () => loadStatus('reconcile');
    controls.current = { reconcile, receiveJob };
    const onConnect = () => { void reconcile(); };
    socket.on('catalog:photoreal', onFrame);
    socket.on('catalog:photoreal-scene', onScene);
    socket.on('connect', onConnect);
    return () => {
      live = false;
      cancelStatus();
      controls.current = null;
      socket.off('catalog:photoreal', onFrame);
      socket.off('catalog:photoreal-scene', onScene);
      socket.off('connect', onConnect);
    };
  }, [ingredientId]);
  const reconcile = () => controls.current?.reconcile();
  useVisibilityEvent((state) => { if (state === 'visible') void reconcile(); });

  const job = status?.job ?? null;
  const canCancel = job?.state === 'running' && job.id !== cancelingJobId;
  const acceptStarted = (started) => controls.current?.receiveJob(started, job?.id ?? null);
  const acceptOpened = (opened) => {
    setStatus((cur) => ({ ...cur, sceneBuilding: false, blendUrl: opened.blendUrl || cur?.blendUrl }));
  };
  const cancel = async () => {
    const handlers = controls.current;
    if (!canCancel || !handlers) return;
    const { id } = job;
    setCancelingJobId(id);
    try {
      const settled = await cancelCatalogPhotorealRender(ingredientId, id, { silent: true });
      if (controls.current === handlers) handlers.receiveJob(settled, id);
    } catch (err) {
      if (controls.current !== handlers) return;
      toast.error(err?.message || 'Could not cancel the Blender render');
      void reconcile();
    } finally {
      if (controls.current === handlers) setCancelingJobId((current) => current === id ? null : current);
    }
  };

  return { status, statusError, statusRefreshing, job, reconcile, acceptOpened, acceptStarted,
    cancel, canCancel, canceling: job !== null && job.id === cancelingJobId };
}
