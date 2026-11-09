import { useEffect, useState } from 'react';
import { getCatalogPrevizJobs } from '../services/apiCatalog.js';
import socket from '../services/socket.js';

/**
 * The server's Previz jobs that belong to a music video: greybox drafts of its
 * linked sets and AI previz proposals for it, whoever started them (this tab,
 * another tab or an agent on the API). Returns
 * `{ running, finished, drafted, setCount, step }`: `finished` is the latest
 * job that settled (summary or error), `drafted` how many of the video's sets
 * were drafted lately, and `step` the progress line for what runs now, or null.
 */
export default function usePrevizJobs(project) {
  const [jobs, setJobs] = useState([]);
  useEffect(() => {
    let active = true;
    const load = () => getCatalogPrevizJobs({ silent: true }).then((snapshot) => { if (active) setJobs(snapshot?.jobs || []); }).catch(() => {});
    const onJobs = (snapshot) => { if (Array.isArray(snapshot?.jobs)) setJobs(snapshot.jobs); };
    load();
    socket.on('catalog:previz-jobs', onJobs);
    // A dropped socket can miss a settle frame; re-read on reconnect.
    socket.on('connect', load);
    return () => { active = false; socket.off('catalog:previz-jobs', onJobs); socket.off('connect', load); };
  }, []);
  return previzJobsFor(jobs, project);
}

/** Pure: pick a project's jobs out of the server snapshot. */
export function previzJobsFor(jobs, project) {
  const placeIds = new Set((project?.concept?.subjects || []).filter((s) => s.kind === 'place' && s.ingredientId).map((s) => s.ingredientId));
  const mine = jobs.filter((job) => (job.kind === 'greybox-draft' ? placeIds.has(job.ingredientId) : job.projectId === project?.id));
  const running = mine.filter((job) => job.state === 'running');
  const settled = mine.filter((job) => job.state !== 'running').sort((a, b) => b.endedAt - a.endedAt);
  const drafted = new Set(settled.filter((job) => job.kind === 'greybox-draft' && job.state === 'done').map((job) => job.ingredientId)).size;
  const setCount = placeIds.size;
  const draft = running.find((job) => job.kind === 'greybox-draft');
  let step = null;
  if (draft) {
    const position = drafted + 1;
    step = { label: `Drafting greybox ${position} of ${Math.max(position, setCount)}: ${draft.label}`, value: position - 1, max: Math.max(position, setCount) };
  } else if (running.length) {
    step = { label: `${running[0].label} in progress`, value: null, max: null };
  }
  return { running, finished: settled[0] || null, drafted, setCount, step };
}
