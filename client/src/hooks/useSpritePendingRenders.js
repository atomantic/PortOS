import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import { getMediaJob, listMediaJobs } from '../services/apiMediaJobs.js';
import { useSocketResource } from './useSocketResource.js';

const JOB_EVENTS = ['sprites:jobs-changed'];
const terminal = job => ['completed', 'failed', 'canceled'].includes(job?.status);

/**
 * Queue-backed sprite render tracking. Reconcile on entry, scoped queue events,
 * reconnect and tab show. A submit's sentinel wins over an older snapshot;
 * resolveSubmit reconciles again because a terminal event may beat HTTP.
 * Persisted sprite assets refresh independently through sprites:changed.
 */
export function useSpritePendingRenders({
  recordId, kind, tagKey, tagField,
  failMessage = (key, job) => `Render failed for ${key}: ${job?.error || 'see media jobs'}`,
}) {
  const [pendingJobs, setPendingJobs] = useState({});
  const pendingRef = useRef({});
  const failRef = useRef(failMessage);
  failRef.current = failMessage;
  const update = useCallback(fn => {
    pendingRef.current = fn(pendingRef.current);
    setPendingJobs(pendingRef.current);
  }, []);

  useEffect(() => { update(() => ({})); }, [recordId, kind, tagKey, tagField, update]);

  const { data: snapshot, refetch } = useSocketResource(async () => {
    if (!recordId) return null;
    const tracked = { ...pendingRef.current };
    const jobs = await listMediaJobs({ kind, owner: 'sprites' }, { silent: true });
    const byId = new Map((jobs || []).map(job => [job.id, job]));
    // A known job absent from the list may have aged out, or be a TUI run id.
    // Only a confirmed 404 releases it; a transient read failure preserves it.
    await Promise.all(Object.values(tracked).filter(id => id !== 'submitting' && !byId.has(id)).map(async id => {
      const job = await getMediaJob(id).catch(error => error?.status === 404 ? { id, status: 'gone' } : null);
      if (job) byId.set(id, job);
    }));
    return { jobs: [...byId.values()] };
  }, {
    events: JOB_EVENTS,
    resourceKey: JSON.stringify([recordId, kind, tagKey, tagField]),
    matchesEvent: payload => Boolean(recordId) && payload?.recordId === recordId
      && payload.kind === kind && payload.tagKey === tagKey,
  });

  useEffect(() => {
    if (!snapshot) return;
    const active = {};
    for (const job of snapshot.jobs) {
      const tag = job.params?.[tagKey];
      if (tag?.recordId === recordId && ['queued', 'running'].includes(job.status)) {
        active[tag[tagField]] = job.id;
      }
    }
    const failures = [];
    update(prev => {
      const next = { ...active, ...prev };
      for (const job of snapshot.jobs) {
        if (!terminal(job) && job.status !== 'gone') continue;
        for (const [key, id] of Object.entries(next)) {
          if (id !== job.id || next[key] !== id) continue;
          delete next[key];
          if (job.status === 'failed') failures.push([key, job]);
        }
      }
      return next;
    });
    for (const [key, job] of failures) toast.error(failRef.current(key, job));
  }, [snapshot, recordId, tagKey, tagField, update]);

  const beginSubmit = useCallback(key => update(prev => ({ ...prev, [key]: 'submitting' })), [update]);
  const resolveSubmit = useCallback((key, jobId) => {
    update(prev => ({ ...prev, [key]: jobId }));
    refetch();
  }, [update, refetch]);
  const cancelSubmit = useCallback(key => update(prev => {
    const next = { ...prev };
    if (next[key] === 'submitting') delete next[key];
    return next;
  }), [update]);

  return { pendingJobs, beginSubmit, resolveSubmit, cancelSubmit };
}

export default useSpritePendingRenders;
