import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { getMusicVideoFestivalPacket, previewMusicVideoFestivalPacket, saveMusicVideoFestivalPacket } from '../../services/apiMusicVideo.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { downloadBlob } from '../../lib/downloadBlob.js';
import { formatCount } from '../../utils/formatters.js';
import PublishCard from './PublishCard.jsx';
import CollapsibleListItem from '../ui/CollapsibleListItem.jsx';

const inputClass = 'w-full rounded border border-port-border bg-port-bg p-2 text-sm';
const buttonClass = 'rounded border border-port-border px-3 py-2 text-sm min-h-[44px] disabled:opacity-50';

function PacketEditor({ project }) {
  const [data, setData] = useState(null);
  const [packet, setPacket] = useState(null);
  const [saved, setSaved] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [removing, setRemoving] = useState(null);
  const previewGeneration = useRef(0);
  const renderId = project.renderHistoryId ?? null;
  useEffect(() => {
    let active = true;
    previewGeneration.current += 1;
    setPreview(null);
    getMusicVideoFestivalPacket(project.id, { silent: true }).then(result => {
      if (!active) return;
      setData({ ...result, renderId });
      setPacket(previous => previous ?? result.packet);
      setSaved(previous => previous ?? JSON.stringify(result.packet));
      setError('');
    }).catch(err => { if (active) setError(err.message || 'Could not load the festival packet.'); });
    return () => { active = false; };
  }, [project.id, renderId, retry]);

  const edit = next => { setPacket(next); setPreview(null); };
  const run = action => {
    setBusy(true); setError('');
    return action().catch(err => setError(err.message || 'Festival packet action failed.')).finally(() => setBusy(false));
  };
  const save = () => run(async () => {
    const result = await saveMusicVideoFestivalPacket(project.id, packet, { silent: true });
    setPacket(result.packet);
    setSaved(JSON.stringify(result.packet));
  });
  const makePreview = () => run(async () => {
    const generation = previewGeneration.current;
    const result = await previewMusicVideoFestivalPacket(project.id, packet, { silent: true });
    if (generation === previewGeneration.current) setPreview({ ...result, renderId });
  });
  const selected = id => packet.include.includes(id);
  const toggle = id => edit({ ...packet, include: selected(id) ? packet.include.filter(value => value !== id) : [...packet.include, id] });
  const fieldId = id => `festival-${project.id}-${id}`;
  const validPreview = preview?.renderId === renderId ? preview : null;
  const measured = validPreview?.measurements;
  const missing = data && packet ? data.fields.filter(field => !packet.fields[field.id]?.trim()) : [];

  return <div className="space-y-3">
    <p>Prepare reusable festival information. Eligibility is unverified. Keep passwords, access tokens, payment details and private paths out of this packet. Public links must use HTTPS without access credentials.</p>
    <p className="text-port-text-muted">The packet follows your existing opted-in project peer sync. Preview, copy and download share only the checked fields; no submission or payment is made.</p>
    {error && <div role="alert" className="text-port-error">{error} {!data && <button type="button" onClick={() => setRetry(value => value + 1)} className={buttonClass}>Retry packet load</button>}</div>}
    {!packet || !data ? <p>Loading festival packet…</p> : <>
      <p role="status">{saved === JSON.stringify(packet) ? 'Packet saved' : 'Unsaved packet changes'}</p>
      <fieldset disabled={busy || removing !== null} className="min-w-0 space-y-3">
        <p>Current final render: {measured?.status === 'current'
          ? `${formatCount(measured.width)} × ${formatCount(measured.height)} pixels; ${measured.durationSec} seconds (measured)`
          : 'Unknown — preview to measure the selected master'}</p>
        <label htmlFor={fieldId('measurements')} className="flex gap-2 items-center">
          <input id={fieldId('measurements')} type="checkbox" checked={selected('measurements')} onChange={() => toggle('measurements')} /> Include current measured dimensions and runtime
        </label>
        <p className="text-port-text-muted">Local asset inventory: {Object.entries(data.assets).map(([kind, available]) => `${kind}: ${data.renderId === renderId && available ? 'recorded' : 'unknown'}`).join(' · ')}. Supply a public URL below to include an asset reference. Files are not uploaded or embedded.</p>
        {data.suggestions.length > 0 && <details><summary>Suggestions from project sources</summary><ul className="space-y-2">
          {data.suggestions.map(suggestion => <li key={suggestion.field}>
            <p>{suggestion.source}: {suggestion.value}</p>
            <button type="button" className={buttonClass} onClick={() => edit({ ...packet, fields: { ...packet.fields, [suggestion.field]: suggestion.value } })}>Apply {suggestion.source} suggestion</button>
          </li>)}
        </ul><p>Applying replaces that field in this draft. Save to keep it.</p></details>}
        {[...new Set(data.fields.map(field => field.group))].map(group => <details key={group} open={group === 'Film'} className="rounded border border-port-border p-3">
          <summary>{group}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {data.fields.filter(field => field.group === group).map(field => <div key={field.id} className="space-y-1">
              <label htmlFor={fieldId(field.id)}>{field.label}</label>
              <textarea id={fieldId(field.id)} rows={2} maxLength={12000} value={packet.fields[field.id] || ''} placeholder="Unknown — not provided" className={inputClass}
                onChange={event => edit({ ...packet, fields: { ...packet.fields, [field.id]: event.target.value } })} />
              <label htmlFor={fieldId(`include-${field.id}`)} className="flex items-center gap-2 pointer-coarse:min-h-11">
                <input id={fieldId(`include-${field.id}`)} type="checkbox" checked={selected(field.id)} onChange={() => toggle(field.id)} /> Include {field.label}
              </label>
            </div>)}
          </div>
        </details>)}
        <div className="grid gap-3 sm:grid-cols-3">{Object.entries(data.rightsLabels).map(([id, label]) => <div key={id}>
          <label htmlFor={fieldId(id)}>{label}</label>
          <select id={fieldId(id)} value={packet[id]} onChange={event => edit({ ...packet, [id]: event.target.value })} className={inputClass}>
            <option value="unknown">Unknown</option><option value="confirmed">Confirmed by me</option><option value="not-cleared">Not cleared</option>
          </select>
          <label htmlFor={fieldId(`include-${id}`)} className="flex gap-2 items-center pointer-coarse:min-h-11"><input id={fieldId(`include-${id}`)} type="checkbox" checked={selected(id)} onChange={() => toggle(id)} /> Include {label}</label>
        </div>)}</div>
        <details><summary>Festival-specific notes ({formatCount(packet.festivals.length)})</summary>
          <p>Organizational notes only. Check each festival&apos;s current rules independently.</p>
          <div tabIndex={-1}>
          {packet.festivals.map((festival, index) => <CollapsibleListItem key={index} removing={removing === index} onExited={() => {
            edit({ ...packet, festivals: packet.festivals.filter((_, i) => i !== index) });
            setRemoving(null);
          }}><fieldset className="grid gap-2 rounded border border-port-border p-3 sm:grid-cols-2">
            <legend>Festival {formatCount(index + 1)}</legend>
            {data.festivalFields.map(field => <div key={field.id}>
              <label htmlFor={fieldId(`note-${index}-${field.id}`)}>{field.label}</label>
              <textarea id={fieldId(`note-${index}-${field.id}`)} value={festival[field.id] || ''} maxLength={12000} className={inputClass} placeholder="Unknown — not provided"
                onChange={event => edit({ ...packet, festivals: packet.festivals.map((item, i) => i === index ? { ...item, [field.id]: event.target.value } : item) })} />
            </div>)}
            <label htmlFor={fieldId(`note-${index}-include`)} className="flex gap-2 items-center"><input id={fieldId(`note-${index}-include`)} type="checkbox" checked={festival.include} onChange={event => edit({ ...packet, festivals: packet.festivals.map((item, i) => i === index ? { ...item, include: event.target.checked } : item) })} /> Include these festival notes</label>
            <button type="button" className={buttonClass} onClick={() => { setRemoving(index); setPreview(null); }}>Remove festival {formatCount(index + 1)} notes</button>
          </fieldset></CollapsibleListItem>)}
          </div>
          <button type="button" className={buttonClass} disabled={packet.festivals.length >= 50} onClick={() => edit({ ...packet, festivals: [...packet.festivals, { include: false }] })}>Add festival notes</button>
        </details>
        <details><summary>Missing fields checklist ({formatCount(missing.length)})</summary><ul>{missing.map(field => <li key={field.id}>{field.label}: unknown</li>)}</ul><p>Rights, music rights and consent: {packet.rights}, {packet.musicRights}, {packet.consent}. Eligibility: unverified.</p></details>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={save} disabled={saved === JSON.stringify(packet)}>Save festival packet</button>
          <button type="button" className={buttonClass} onClick={makePreview}>Preview selected export</button>
        </div>
      </fieldset>
      {validPreview && <div className="space-y-2">
        <label htmlFor={fieldId('preview')}>Exact text to copy or download</label>
        <textarea id={fieldId('preview')} value={validPreview.text} readOnly rows={14} className={inputClass} />
      </div>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!validPreview || busy} className={buttonClass} onClick={() => copyToClipboard(validPreview.text)}>Copy selected packet</button>
        <button type="button" disabled={!validPreview || busy} className={buttonClass} onClick={() => downloadBlob(validPreview.text, 'festival-packet.txt', 'text/plain;charset=utf-8')}>Download selected packet</button>
      </div>
    </>}
  </div>;
}

export default function FestivalPacketPanel({ project }) {
  return <PublishCard projectId={project.id} cardId="festival" label="Festival packet" icon={FileText}>
    <PacketEditor key={project.id} project={project} />
  </PublishCard>;
}
