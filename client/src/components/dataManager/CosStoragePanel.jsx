import { useState, useRef, useEffect } from 'react';
import { useSocketResource } from '../../hooks/useSocketResource';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { formatBytes, formatCount } from '../../utils/formatters';
import * as api from '../../services/apiSystem';

const EVENTS = ['cos:storage:changed'];
const button = 'rounded border border-port-border px-3 py-2 text-sm disabled:opacity-40';
const input = 'rounded border border-port-border bg-port-bg px-2 py-1 text-sm w-full';

export default function CosStoragePanel({ onMaintenanceComplete }) {
  const resource = useSocketResource(({ signal }) => api.getCosStorage({ silent: true, signal }), { namespace: 'cos', events: EVENTS });
  const [filter, setFilter] = useState({ action: 'compress', olderThanDays: 7, model: '', outcome: 'all' });
  const [preview, setPreview] = useState(null);
  const [draft, setDraft] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0);
  const job = resource.data?.job;
  const active = job?.state === 'running';
  const completionRef = useRef(null);
  useEffect(() => {
    if (!job?.id || !job.finishedAt || completionRef.current === job.id) return;
    completionRef.current = job.id;
    onMaintenanceComplete?.();
  }, [job?.id, job?.finishedAt, onMaintenanceComplete]);
  const policy = draft || resource.data?.policy;
  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(resource.data?.policy);
  const changeFilter = (patch) => {
    generation.current++;
    setFilter(previous => ({ ...previous, ...patch }));
    setPreview(null);
    setConfirmed(false);
  };
  const [previewAction, previewing] = useAsyncAction(async (offset = 0) => {
    const request = ++generation.current;
    const result = await api.previewCosStorage(filter, offset, { silent: true });
    if (request === generation.current) { setPreview(result); setConfirmed(false); }
  });
  const [runAction, starting] = useAsyncAction(async () => {
    const result = await api.runCosStorage({ token: preview.token, ...(filter.action === 'purge' ? { confirmation: 'PURGE RAW RECORDINGS' } : {}) }, { silent: true });
    resource.updateData(result);
    setPreview(null);
    setConfirmed(false);
  });
  const [saveAction, saving] = useAsyncAction(async () => {
    const result = await api.saveCosStoragePolicy(policy, { silent: true });
    resource.updateData(result);
    setDraft(null);
  });
  const [cancelAction, cancelling] = useAsyncAction(async () => resource.updateData(await api.cancelCosStorage({ silent: true })));
  const [pinAction, pinning] = useAsyncAction(async (row) => {
    await api.pinCosRecording({ date: row.date, id: row.id, pinned: !row.pinned }, { silent: true });
    setPreview(null); // A new preview must reflect the changed protection before execution.
  });

  return (
    <section className="border-t border-port-border p-3 space-y-4" aria-label="CoS recording cleanup">
      <div>
        <h3 className="font-semibold">Recording cleanup</h3>
        <p className="text-sm text-gray-400">Compress raw terminal recordings without losing their contents. Metadata, summaries, prompts, parsed output, feedback and history remain. Active, recent, pinned and resumable runs are protected.</p>
      </div>
      {resource.error && <p role="alert">Storage settings unavailable. <button className={button} onClick={resource.refetch}>Retry</button></p>}
      {policy && (
        <fieldset disabled={saving} className="border border-port-border rounded p-3 space-y-2">
          <legend className="text-sm">Automatic maintenance</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="flex gap-2" htmlFor="cos-auto-compress"><input id="cos-auto-compress" type="checkbox" checked={policy.autoCompress} onChange={e => setDraft({ ...policy, autoCompress: e.target.checked })} />Compress recordings automatically</label>
              <label htmlFor="cos-compress-days">After days</label>
              <input id="cos-compress-days" className={input} type="number" min="1" max="36500" value={policy.compressAfterDays} onChange={e => setDraft({ ...policy, compressAfterDays: Number(e.target.value) })} />
            </div>
            <div>
              <label className="flex gap-2" htmlFor="cos-auto-purge"><input id="cos-auto-purge" type="checkbox" checked={policy.autoPurge} onChange={e => setDraft({ ...policy, autoPurge: e.target.checked })} />Allow permanent raw recording deletion</label>
              <label htmlFor="cos-purge-days">After days (requires retained summary and output)</label>
              <input id="cos-purge-days" className={input} type="number" min="7" max="36500" value={policy.purgeAfterDays} onChange={e => setDraft({ ...policy, purgeAfterDays: Number(e.target.value) })} />
            </div>
          </div>
          <p className="text-xs text-gray-400">Saving enables the selected policy immediately, then checks hourly in small batches while Chief of Staff is running. Disabling a policy stops further files in its automatic run.</p>
          <button className={button} disabled={!dirty || saving} onClick={saveAction}>{saving ? 'Saving…' : 'Save maintenance policy'}</button>
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <div><label htmlFor="cos-storage-action">Action</label><select id="cos-storage-action" className={input} value={filter.action} onChange={e => changeFilter({ action: e.target.value })}><option value="compress">Lossless compression</option><option value="purge">Delete raw recordings</option></select></div>
        <div><label htmlFor="cos-storage-days">Completed at least days ago</label><input id="cos-storage-days" className={input} type="number" min="1" max="36500" value={filter.olderThanDays} onChange={e => changeFilter({ olderThanDays: Number(e.target.value) })} /></div>
        <div><label htmlFor="cos-storage-model">Exact model (blank for all)</label><input id="cos-storage-model" className={input} list="cos-storage-models" value={filter.model} onChange={e => changeFilter({ model: e.target.value })} /><datalist id="cos-storage-models">{preview?.models.map(model => <option key={model} value={model} />)}</datalist></div>
        <div><label htmlFor="cos-storage-outcome">Outcome</label><select id="cos-storage-outcome" className={input} value={filter.outcome} onChange={e => changeFilter({ outcome: e.target.value })}><option value="all">All outcomes</option><option value="success">Successful</option><option value="failure">Unsuccessful</option></select></div>
      </div>
      <button className={button} disabled={previewing || active || starting || saving || dirty} onClick={() => previewAction()}>{previewing ? 'Scanning recordings…' : 'Preview cleanup'}</button>
      {preview && (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">Matching archived runs: {formatBytes(preview.totals.recordingBytes)} recordings · {formatBytes(preview.totals.metadataBytes)} metadata · {formatBytes(preview.totals.outputBytes)} parsed output · {formatBytes(preview.totals.promptBytes)} prompts.</p>
          <p>{formatCount(preview.totals.eligibleRuns)} eligible runs · {formatBytes(preview.totals.eligibleBytes)} raw recording bytes in this batch. Compression savings are measured after verification.</p>
          <p className="text-xs text-gray-400">Up to {formatCount(preview.batchLimit)} runs per manual batch. {formatCount(preview.totals.unreadable)} unreadable runs were left untouched.</p>
          <ul className="text-xs text-gray-400">{Object.entries(preview.reasons).map(([reason, count]) => <li key={reason}>{reason}: {formatCount(count)}</li>)}</ul>
          <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr><th className="text-left">Run</th><th>Model</th><th>Recording</th><th>Protection</th><th>Actions</th></tr></thead><tbody>
            {preview.rows.map(row => <tr key={row.id} className="border-t border-port-border"><td className="py-2">{row.date}<br />{row.id}</td><td>{row.model}</td><td>{formatBytes(row.bytes)} · {row.state}</td><td>{row.reason || 'Eligible'}</td><td><button className={button} disabled={pinning || active || starting} onClick={() => pinAction(row)}>{row.pinned ? 'Unpin' : 'Pin'}</button>{['plain', 'compressed'].includes(row.state) && <a className="ml-2 text-port-accent" href={`/api/data/cos/storage/recording/${encodeURIComponent(row.date)}/${encodeURIComponent(row.id)}`} download>Download</a>}</td></tr>)}
          </tbody></table></div>
          <div className="flex gap-2"><button className={button} disabled={!preview.offset || previewing} onClick={() => previewAction(Math.max(0, preview.offset - 25))}>Previous runs</button><button className={button} disabled={preview.offset + preview.rows.length >= preview.matching || previewing} onClick={() => previewAction(preview.offset + 25)}>Next runs</button></div>
          {filter.action === 'purge' && <label className="flex gap-2" htmlFor="cos-confirm-purge"><input id="cos-confirm-purge" type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Permanently delete eligible raw recordings. I understand they cannot be recovered from history; parsed output and metadata remain.</label>}
          <button className={button} disabled={!preview.totals.eligibleRuns || starting || active || pinning || previewing || saving || dirty || (filter.action === 'purge' && !confirmed)} onClick={runAction}>{filter.action === 'purge' ? 'Delete eligible raw recordings' : 'Compress eligible recordings'}</button>
        </div>
      )}
      {job && <div role="status" className="text-sm border border-port-border rounded p-3">
        {job.action}: {job.state} · {formatCount(job.processed)}/{formatCount(job.total)} processed · {formatBytes(job.reclaimedBytes)} reclaimed · {formatCount(job.skipped)} skipped · {formatCount(job.failed)} failed
        {job.failed > 0 && <p>Some recordings could not be processed. Their history remains; preview again to inspect remaining files.</p>}
        {active && <button className={`${button} ml-2`} disabled={cancelling} onClick={cancelAction}>Cancel maintenance</button>}
      </div>}
    </section>
  );
}
