import { useEffect, useId, useRef, useState } from 'react';
import { getPeerCatalogReview, getPeerCatalogReviews, savePeerCatalogReview } from '../../services/api';
import useMounted from '../../hooks/useMounted';
import { formatBytes } from '../../utils/formatters';

const FIELDS = [
  { key: 'sourceRevision', label: 'Pinned source commit', pattern: '[a-f0-9]{40}', hint: 'Full 40-character commit SHA from the source repository.' },
  { key: 'fileName', label: 'GGUF file name', pattern: '[A-Za-z0-9][A-Za-z0-9._-]*\\.gguf', hint: 'One GGUF file name only, without a directory or URL.' },
  { key: 'artifactDigest', label: 'Artifact SHA-256', pattern: '[a-f0-9]{64}', hint: 'Exact 64-character digest of the reviewed file.' },
  { key: 'downloadBytes', label: 'Exact download size (bytes)', type: 'number', hint: 'The exact file size from the pinned source.' },
  { key: 'license', label: 'Reviewed license', maxLength: 256, hint: 'License identifier or name verified at the pinned source.' },
  { key: 'runtimeMemoryBytes', label: 'Required runtime memory (bytes)', type: 'number', hint: 'Reviewed memory requirement, including runtime overhead; at least the download size.' },
];

function LocalReview({ catalogKey, hostInstanceId, onSaved }) {
  const [observation, setObservation] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [fields, setFields] = useState({});
  const [sourceReviewed, setSourceReviewed] = useState(false);
  const [runtimeReviewed, setRuntimeReviewed] = useState(false);
  const mounted = useMounted();
  const id = useId();
  useEffect(() => {
    let active = true;
    getPeerCatalogReview('lmstudio', catalogKey, { silent: true }).then(value => {
      if (active) setObservation(value);
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [catalogKey]);

  const save = async event => {
    event.preventDefault();
    if (saving.current || !observation || !sourceReviewed || !runtimeReviewed) return;
    const downloadBytes = Number(fields.downloadBytes);
    const runtimeMemoryBytes = Number(fields.runtimeMemoryBytes);
    if (!Number.isSafeInteger(downloadBytes) || downloadBytes <= 0
      || !Number.isSafeInteger(runtimeMemoryBytes) || runtimeMemoryBytes < downloadBytes) {
      setError('Use positive whole byte counts; runtime memory must cover at least the download size.');
      return;
    }
    saving.current = true;
    setBusy(true);
    setError('');
    await savePeerCatalogReview({
      backend: 'lmstudio', catalogKey,
      sourceRevision: fields.sourceRevision, fileName: fields.fileName, artifactDigest: fields.artifactDigest,
      downloadBytes, license: fields.license, runtimeMemoryBytes, runtime: observation.runtime,
      sourceLicenseReviewed: true, runtimeCompatibilityReviewed: true,
    }, { silent: true }).then(value => {
      if (mounted.current) onSaved(value);
    }).catch(err => { if (mounted.current) setError(err.message); });
    saving.current = false;
    if (mounted.current) setBusy(false);
  };

  return <div className="rounded border border-port-border p-3 space-y-3">
    <p className="font-medium">Review installation on this host</p>
    <p className="text-gray-400 break-all">Receiving host: {hostInstanceId}. This review applies only here. To install on the remote peer, complete its review there.</p>
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {!observation && !error && <p role="status">Reading local catalog and runtime…</p>}
    {observation && <form onSubmit={save} className="space-y-3">
      <dl className="text-xs text-gray-400 break-all space-y-1">
        <dt>Catalog source</dt><dd><a href={`https://huggingface.co/${observation.sourceRepo}`} target="_blank" rel="noreferrer" className="text-port-accent">{observation.sourceRepo}</a></dd>
        <dt>Observed local runtime fingerprint</dt><dd>{observation.runtime}</dd>
        <dt>Managed models folder</dt><dd>{observation.modelsDirectory || 'Receiver-configured models folder'}</dd>
        <dt>Managed destination fingerprint</dt><dd>{observation.destinationDigest}</dd>
      </dl>
      <p className="text-gray-400">Inspect the pinned source, file digest, license and compatibility with this installed runtime before recording the review. Saving does not download or execute a model.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map(field => <div key={field.key} className="min-w-0">
          <label htmlFor={`${id}-${field.key}`} className="block text-sm">{field.label}</label>
          <input id={`${id}-${field.key}`} type={field.type || 'text'} required disabled={busy}
            pattern={field.pattern} maxLength={field.maxLength} min={field.type === 'number' ? 1 : undefined}
            step={field.type === 'number' ? 1 : undefined} value={fields[field.key] || ''}
            onChange={event => setFields(current => ({ ...current, [field.key]: event.target.value }))}
            className="w-full min-w-0 rounded border border-port-border bg-port-bg p-2" />
          <p className="text-xs text-gray-400">{field.hint}</p>
        </div>)}
      </div>
      <div className="flex items-start gap-2">
        <input id={`${id}-source`} type="checkbox" checked={sourceReviewed} disabled={busy} onChange={event => setSourceReviewed(event.target.checked)} />
        <label htmlFor={`${id}-source`}>I reviewed this pinned source, exact artifact and license for installation on this host.</label>
      </div>
      <div className="flex items-start gap-2">
        <input id={`${id}-runtime`} type="checkbox" checked={runtimeReviewed} disabled={busy} onChange={event => setRuntimeReviewed(event.target.checked)} />
        <label htmlFor={`${id}-runtime`}>I reviewed compatibility and memory requirements against the observed local runtime.</label>
      </div>
      <button type="submit" disabled={busy || !sourceReviewed || !runtimeReviewed}
        className="min-h-[44px] text-port-accent disabled:opacity-50">Save local catalog review</button>
    </form>}
  </div>;
}

export default function PeerCatalogControls({ hostInstanceId, disabled, onPrepare }) {
  const [expanded, setExpanded] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    getPeerCatalogReviews({ silent: true }).then(value => {
      if (active) setCatalog(value);
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [expanded]);
  const review = catalog?.reviews.find(entry => entry.backend === 'lmstudio' && entry.catalogKey === selected);
  return <div className="space-y-3">
    <button type="button" className="min-h-[44px] text-port-accent" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>Choose a catalog model</button>
    {expanded && <>
      <p className="text-gray-400">Supported LM Studio catalog entries use one pinned GGUF artifact. The receiving host must have its own reviewed source, license and runtime requirements.</p>
      {error && <p role="alert" className="text-port-error">{error}</p>}
      {catalog && <>
        <label htmlFor={`${id}-catalog`} className="block">Catalog model (LM Studio)</label>
        <select id={`${id}-catalog`} value={selected} disabled={disabled}
          className="w-full max-w-lg rounded border border-port-border bg-port-bg p-2"
          onChange={event => { setSelected(event.target.value); setReviewing(false); }}>
          <option value="">Choose a catalog entry</option>
          {catalog.candidates.map(entry => <option key={entry.catalogKey} value={entry.catalogKey}>{entry.name}</option>)}
        </select>
        {selected && <>
          {review && <p role="status" className="text-xs text-gray-400 break-all">Local review saved: {review.fileName} · {formatBytes(review.downloadBytes)} · {review.license} · commit {review.sourceRevision}</p>}
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={disabled} className="min-h-[44px] text-port-accent disabled:opacity-50"
              onClick={() => setReviewing(value => !value)}>Review catalog source on this host</button>
            <button type="button" disabled={disabled} className="min-h-[44px] text-port-accent disabled:opacity-50"
              onClick={() => onPrepare({ action: 'catalog.install', backend: 'lmstudio', catalogKey: selected })}>Prepare catalog installation on remote peer</button>
          </div>
          {reviewing && <LocalReview key={selected} catalogKey={selected} hostInstanceId={hostInstanceId} onSaved={value => {
            setCatalog(current => ({ ...current, reviews: [...current.reviews.filter(entry => !(entry.backend === value.backend && entry.catalogKey === value.catalogKey)), value] }));
            setReviewing(false);
          }} />}
        </>}
      </>}
    </>}
  </div>;
}
