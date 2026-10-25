import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { RefreshCw, Trash2 } from 'lucide-react';
import Modal from '../ui/Modal';
import { request } from '../../services/apiCore';
import { formatBytes, formatCount } from '../../utils/formatters';

const api = (path = '', options = {}) => request(`/data-maintenance${path}`, { ...options, silent: true });

export default function DataMaintenanceTab() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    inFlight.current = true;
    setBusy(true);
    api().then(result => { if (active) setItems(result); }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) { inFlight.current = false; setBusy(false); } });
    return () => { active = false; generation.current += 1; };
  }, []);

  async function act(work) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const current = generation.current;
    try { await work(() => current === generation.current); }
    catch (err) { if (current === generation.current) { setError(err.message); setPreview(null); setConfirmation(''); } }
    finally { inFlight.current = false; if (current === generation.current) setBusy(false); }
  }

  function refresh() {
    setPreview(null);
    setConfirmation('');
    setNotice('');
    void act(async valid => { const result = await api(); if (valid()) setItems(result); });
  }

  function begin(operationId) {
    void act(async valid => {
      const result = await api('/preview', { method: 'POST', body: JSON.stringify({ operationId }) });
      if (valid()) { setPreview(result); setConfirmation(''); }
    });
  }

  function remove() {
    if (!preview || confirmation !== preview.confirmation) return;
    void act(async valid => {
      const result = await api('/execute', { method: 'POST', body: JSON.stringify({ token: preview.token, confirmation }) });
      if (!valid()) return;
      setItems(previous => previous.map(item => item.id === result.operationId ? { ...item, status: result.status === 'deleted' ? 'absent' : result.status, bytes: result.remainingBytes, files: result.remainingFiles, actions: result.status === 'retained' ? ['delete'] : [] } : item));
      setNotice(`Removed ${formatCount(result.removedFiles)} files (${formatBytes(result.removedBytes)}). Run history and installed adapters were retained.${result.status === 'retained' ? ' New files appeared during removal; refresh and preview them separately.' : result.status === 'unavailable' ? ' Inventory could not be read after removal; refresh to check remaining files.' : ''}`);
      setPreview(null);
      setConfirmation('');
    });
  }

  return <div className="max-w-5xl space-y-4">
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="text-lg font-semibold">Data Maintenance</h2><p className="text-sm text-port-text-muted">Inspect retained data from retired features and review supported maintenance actions.</p></div>
      <button type="button" onClick={refresh} disabled={busy} className="flex items-center gap-2 px-3 py-2 border border-port-border rounded disabled:opacity-50"><RefreshCw className="w-4 h-4" />Refresh</button>
    </div>
    <p className="text-sm text-port-text-muted">LoRA training is retired. Existing files and configuration remain intact until you explicitly remove files here. There is no automatic conversion of training data to reference images. Use <Link to="/media/image" className="text-port-accent">reference-image generation</Link> for new work. <Link to="/system-resources/queues" className="text-port-accent">Review or cancel active media jobs</Link> before maintenance. Backup settings are unchanged; check your backups before removing unique data.</p>
    {error && <div role="alert" className="text-port-error border border-port-error rounded p-3">{error}</div>}
    {notice && <p role="status" className="text-port-success">{notice}</p>}
    {!items && !error && <p role="status">Measuring retained data…</p>}
    {items?.map(item => <section key={item.id} className="border border-port-border rounded-lg bg-port-card p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">{item.label}</h3><span className="text-sm text-port-text-muted">{item.status}</span></div>
      <div className="flex flex-wrap gap-x-5 text-sm"><code>{item.path}</code><span>{item.category}</span><span>{item.bytes === null ? 'Size unavailable' : formatBytes(item.bytes)} · {formatCount(item.files)} files</span></div>
      <p className="text-sm text-port-text-muted">{item.warning}</p>
      {item.error && <p role="alert" className="text-port-error">{item.error}</p>}
      {item.id === 'shared-lora-adapters' && <Link to="/models/loras" className="text-port-accent text-sm">Manage installed adapters</Link>}
      {item.actions.includes('delete') && <button type="button" disabled={busy} onClick={() => begin(item.id)} className="flex items-center gap-2 text-port-error border border-port-border rounded px-3 py-2 disabled:opacity-50"><Trash2 className="w-4 h-4" />Preview deletion</button>}
    </section>)}
    {preview && <Modal open panelClassName="bg-port-card border border-port-border rounded-lg shadow-xl" ariaLabel="Review permanent deletion" usePortal onClose={() => { if (!busy) { setPreview(null); setConfirmation(''); } }} closeOnEsc={!busy} closeOnBackdrop={!busy}>
      <div className="p-5 space-y-4"><h3 className="font-semibold">Review permanent deletion</h3><p><code>{preview.path}</code> · {formatBytes(preview.bytes)} · {formatCount(preview.files)} files</p><p className="text-port-error">{preview.warning} This removal cannot be undone by PortOS.</p><p className="text-sm">Preview expires after five minutes. Changed files or active work require a new preview.</p>
        <label htmlFor="maintenance-confirmation" className="block text-sm">Type <code>{preview.confirmation}</code> to confirm<input id="maintenance-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} className="mt-2 w-full rounded border border-port-border bg-port-bg px-3 py-2" /></label>
        <div className="flex justify-end gap-3"><button type="button" disabled={busy} onClick={() => { setPreview(null); setConfirmation(''); }}>Cancel</button><button type="button" onClick={remove} disabled={busy || confirmation !== preview.confirmation} className="rounded bg-port-error px-3 py-2 text-white disabled:opacity-50">{busy ? 'Removing…' : 'Permanently delete'}</button></div>
      </div>
    </Modal>}
  </div>;
}
