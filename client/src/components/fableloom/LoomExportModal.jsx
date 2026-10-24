import { useEffect, useRef, useState } from 'react';
import Modal from '../ui/Modal';
import * as api from '../../services/apiFableLoom.js';
import socket from '../../services/socket';
import { useSocketSubscription } from '../../hooks/useSocketSubscription.js';
import useMounted from '../../hooks/useMounted.js';
import { downloadBlob } from '../../lib/downloadBlob.js';
import { formatBytes, formatCount } from '../../utils/formatters.js';

const gates = ['graph', 'outline', 'production', 'media', 'approval', 'cast'];
const terminal = job => ['completed', 'failed', 'cancelled'].includes(job?.status);

export default function LoomExportModal({ loom, onClose }) {
  const [options, setOptions] = useState({ episodeIds: loom.episodes.map(e => e.id), includePlayer: true,
    includeCharacters: false, includeVoice: false, allowDraft: false, mediaProfile: 'source' });
  const [preflight, setPreflight] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  const identity = JSON.stringify([loom, options]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const controller = useRef(null);
  useSocketSubscription('fableloom', { onResubscribe: () => controller.current?.() });

  useEffect(() => {
    let active = true;
    setPreflight(null);
    setError('');
    if (options.episodeIds.length) {
      api.preflightLoomExport(loom.id, options, { silent: true }).then(result => {
        if (active) setPreflight({ identity, ...result });
      }).catch(err => { if (active) setError(err.message); });
    }
    return () => { active = false; };
  }, [loom.id, identity, options]);

  useEffect(() => {
    let active = true;
    setJob(null);
    const accept = next => {
      if (!active || next.loomId !== loom.id || next.jobId !== jobId) return;
      setJob(previous => previous && previous.revision >= next.revision ? previous : next);
    };
    const read = () => jobId && api.getLoomExport(loom.id, jobId, { silent: true }).then(accept)
      .catch(err => { if (active) setError(err.message); });
    controller.current = read;
    socket.on('fableloom:export:job', accept);
    read();
    return () => { active = false; controller.current = null; socket.off('fableloom:export:job', accept); };
  }, [loom.id, jobId]);

  const change = patch => setOptions(previous => ({ ...previous, ...patch }));
  const start = async () => {
    if (busy || !preflight?.canBuild || preflight.identity !== identity) return;
    setBusy(true);
    setError('');
    const startedIdentity = identity;
    await api.startLoomExport(loom.id, options, { silent: true }).then(result => {
      if (mounted.current && currentIdentity.current === startedIdentity) setJobId(result.jobId);
    }).catch(err => { if (mounted.current) setError(err.message); });
    if (mounted.current) setBusy(false);
  };
  const download = async () => {
    setBusy(true);
    await api.downloadLoomExport(loom.id, jobId, { silent: true }).then(blob => {
      if (mounted.current) downloadBlob(blob, `fableloom-${jobId}.zip`);
    }).catch(err => { if (mounted.current) setError(err.message); });
    if (mounted.current) setBusy(false);
  };
  const checked = preflight?.identity === identity ? preflight : null;
  const findings = checked?.findings || [];
  const running = jobId && (!job || !terminal(job));
  return <Modal open onClose={onClose} size="lg" ariaLabel="Export story" panelClassName="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
    <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-semibold">Export story</h2><button onClick={onClose}>Close</button></div>
    <p className="text-sm text-port-text-muted">Build a static ZIP for handoff. Draft assets are refused by default. Voice requires character opt-in and approved voice references.</p>
    <fieldset disabled={busy || !!running} className="space-y-3">
      <legend>Episodes in package order</legend>
      {options.episodeIds.map((id, index) => <div key={id} className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 break-words">{loom.episodes.find(e => e.id === id)?.title || id}</span>
        <button disabled={index === 0} aria-label={`Move episode ${index + 1} up`} onClick={() => {
          const ids = [...options.episodeIds]; [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; change({ episodeIds: ids });
        }}>Up</button>
        <button onClick={() => change({ episodeIds: options.episodeIds.filter(value => value !== id) })}>Remove</button>
      </div>)}
      {loom.episodes.filter(e => !options.episodeIds.includes(e.id)).map(e => <button key={e.id} className="text-sm mr-2" onClick={() => change({ episodeIds: [...options.episodeIds, e.id] })}>Add {e.title || e.id}</button>)}
      <div className="flex flex-wrap gap-4">
        {[['includePlayer', 'Reference player'], ['includeCharacters', 'Character inputs'], ['includeVoice', 'Approved voice references'], ['includeWebm', 'WebM alternative (web profiles only)'], ['allowDraft', 'Allow draft assets (not production approval)']].map(([key, label]) => <label key={key} htmlFor={`export-${key}`} className="flex items-center gap-2 text-sm">
          <input id={`export-${key}`} type="checkbox" checked={!!options[key]} disabled={(key === 'includeVoice' && !options.includeCharacters) || (key === 'includeWebm' && options.mediaProfile === 'source')}
            onChange={e => change({ [key]: e.target.checked, ...(key === 'includeCharacters' && !e.target.checked ? { includeVoice: false } : {}) })} />{label}
        </label>)}
      </div>
      <label htmlFor="export-profile" className="block text-sm">Media profile</label>
      <select id="export-profile" value={options.mediaProfile} onChange={e => change({ mediaProfile: e.target.value, ...(e.target.value === 'source' ? { includeWebm: false } : {}) })} className="bg-port-bg border border-port-border rounded p-2">
        <option value="source">Source</option><option value="web-720p">Web 720p</option><option value="web-1080p">Web 1080p</option>
      </select>
    </fieldset>
    <div aria-live="polite" className="space-y-2 text-sm">
      <p>{!options.episodeIds.length ? 'Select at least one episode.' : !checked ? 'Checking server gates…' : checked.canBuild ? 'Preflight passed. Build rechecks source files and gates.' : 'Resolve the findings before building.'}</p>
      <div className="flex flex-wrap gap-2">{gates.map(gate => <span key={gate} className="border border-port-border rounded px-2 py-1">{gate}: {!checked ? 'checking' : findings.some(f => f.gate === gate && f.severity === 'error') ? 'blocked' : findings.some(f => f.gate === gate) ? 'warning' : 'passed'}</span>)}</div>
      {findings.map((finding, index) => <p key={index} className="break-words">{finding.severity}: {finding.message}</p>)}
      {job && <p>Job {job.jobId}: {job.status} · {formatCount(job.progress.completed)} / {formatCount(job.progress.total)} assets{job.sizeReport ? ` · ZIP ${formatBytes(job.sizeReport.archiveBytes)}` : ''}</p>}
      {!!job?.findings?.length && <div><p>Selected job findings</p>{job.findings.map((finding, index) => <p key={index}>{finding.severity}: {finding.message}</p>)}</div>}
      {job?.error && <p role="alert">{job.error.message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="flex flex-wrap gap-3">
      <button disabled={busy || !!running || !preflight?.canBuild || preflight.identity !== identity} onClick={start} className="rounded bg-port-accent px-3 py-2 text-white disabled:opacity-50">Build ZIP</button>
      {jobId && error && <button onClick={() => { setError(''); controller.current?.(); }} className="rounded border border-port-border px-3 py-2">Refresh selected job</button>}
      {job?.jobId === jobId && job?.status === 'completed' && <button disabled={busy} onClick={download} className="rounded border border-port-border px-3 py-2">Download selected ZIP</button>}
    </div>
  </Modal>;
}
