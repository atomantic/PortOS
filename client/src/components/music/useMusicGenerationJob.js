/**
 * Active music-render lifecycle for one track: queue discovery over the socket,
 * per-job progress, completion retry (the track record can lag the terminal
 * event) and the elapsed timer.
 */

import { useEffect, useRef, useState } from 'react';
import useMounted from '../../hooks/useMounted';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { useSocketResource } from '../../hooks/useSocketResource';
import toast from '../ui/Toast';
import { getActiveProcessing } from '../../services/apiSystem.js';
import { getMediaJob, cancelMediaJob } from '../../services/apiMediaJobs.js';
import { getTrack } from '../../services/apiTracks.js';

const MUSIC_QUEUE_EVENTS = ['media-jobs:changed'];

export default function useMusicGenerationJob({ track, onGenerated, onDiscoveredInstrumental }) {
  const [generating, setGenerating] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  const [activeJobId, setActiveJobId] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const mountedRef = useMounted();

  // Queue discovery and per-job progress have separate lifetimes. An empty
  // active queue must not detach the job before its terminal event is handled.
  const settledJobRef = useRef(null);
  const { data: discoveredJob } = useSocketResource(async () => {
    const snapshot = await getActiveProcessing({ silent: true });
    return (snapshot?.jobs || []).find((job) => {
      const tag = job.params?.musicStudio;
      return job.kind === 'audio' && (track?.id ? tag?.trackId === track.id : tag && !tag.trackId);
    }) || null;
  }, { events: MUSIC_QUEUE_EVENTS, resourceKey: track?.id || null });

  useEffect(() => {
    setActiveJob(null);
    setActiveJobId(null);
    setGenerating(false);
    settledJobRef.current = null;
  }, [track?.id]);

  useEffect(() => {
    if (!discoveredJob || discoveredJob.id === settledJobRef.current) return;
    setActiveJob(discoveredJob);
    setActiveJobId(discoveredJob.id);
    if (typeof discoveredJob.params?.musicStudio?.instrumentalOnly === 'boolean') {
      onDiscoveredInstrumental?.(discoveredJob.params.musicStudio.instrumentalOnly);
    }
    setGenerating(true);
  }, [discoveredJob]);

  const progress = useMediaJobProgress(activeJobId, { kind: 'audio' });
  const isGenerating = generating || ['queued', 'running'].includes(activeJob?.status) || ['queued', 'running'].includes(progress.status);

  useEffect(() => {
    if (!activeJobId || progress.status !== 'completed') return undefined;
    let canceled = false;
    const finish = async () => {
      let targetId = track?.id || progress.trackId;
      if (!targetId) {
        const job = await getMediaJob(activeJobId).catch(() => null);
        targetId = job?.result?.trackId;
      }
      if (canceled) return;
      let updated = null;
      for (let attempt = 0; targetId && attempt < 4 && !updated && !canceled; attempt += 1) {
        updated = await getTrack(targetId, { silent: true }).catch(() => null);
        if (!updated && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (canceled || !mountedRef.current) return;
      settledJobRef.current = activeJobId;
      setGenerating(false);
      setActiveJob(null);
      setActiveJobId(null);
      if (updated) onGenerated?.(updated);
      toast.success('Track generated');
    };
    finish();
    return () => { canceled = true; };
  }, [activeJobId, progress.status, progress.trackId, track?.id]);

  useEffect(() => {
    if (!activeJobId || !['failed', 'canceled'].includes(progress.status)) return;
    settledJobRef.current = activeJobId;
    setGenerating(false);
    setActiveJob(null);
    setActiveJobId(null);
    if (progress.status === 'failed') toast.error(progress.error || 'Music generation failed');
  }, [activeJobId, progress.status, progress.error]);

  useEffect(() => {
    if (!isGenerating) return undefined;
    const startedAt = activeJob?.startedAt ? Date.parse(activeJob.startedAt) : Date.now();
    setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    // biome-ignore lint/plugin/lint-no-view-interval: Elapsed-time clock for a running generation (job state arrives through socket events).
    const timer = setInterval(() => {
      if (mountedRef.current) setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isGenerating, activeJob?.startedAt]);

  // Keep observing until the server confirms cancellation. A failed request or
  // an in-flight cancellation must not re-enable a duplicate paid render.
  const cancel = async () => {
    if (!activeJobId) return;
    await cancelMediaJob(activeJobId, { silent: true }).catch((err) => toast.error(err.message || 'Cancel failed'));
  };

  const trackQueuedJob = (job) => {
    setActiveJob(job);
    setActiveJobId(job.id);
  };

  return { isGenerating, activeJob, activeJobId, elapsedSec, setGenerating, trackQueuedJob, cancel };
}
