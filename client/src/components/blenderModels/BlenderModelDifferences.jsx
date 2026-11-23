import { useState } from 'react';
import { Check, Plus, RotateCcw, Trash2 } from 'lucide-react';
import Pill from '../ui/Pill';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { blenderModelBuilds, referenceLabel } from '../../lib/blenderModels.js';
import { formatCount, formatDateTime } from '../../utils/formatters.js';
import { buttonCls, inputCls, labelCls, primaryCls } from '../musicVideo/blender/blenderStyles.js';

const STATUS = { open: ['Open', 'warning'], fixed: ['Fixed', 'success'], accepted: ['Accepted', 'muted'] };

function Difference({ model, difference, buildId }) {
  const { state, pending } = model;
  const [accepting, setAccepting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState('');
  const busy = !!pending[`difference:${difference.id}`];
  const [label, tone] = STATUS[difference.status] || [difference.status, 'muted'];
  const reference = state.references.find((slot) => slot.id === difference.referenceId);
  const closedOn = blenderModelBuilds(state).find((build) => build.id === difference.closedBuildId);
  const close = (patch) => model.updateDifference(difference.id, { ...patch, ...(buildId ? { buildId } : {}) });
  const accept = async (event) => {
    event.preventDefault();
    if (reason.trim() && (await close({ status: 'accepted', reason: reason.trim() })).ok) { setAccepting(false); setReason(''); }
  };
  const about = [difference.partId, reference ? referenceLabel(reference) : null].filter(Boolean).join(' · ');
  return (
    <li className="min-w-0 space-y-1.5 px-2 py-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Pill size="xs" tone={tone}>{label}</Pill>
        <span className="min-w-0 flex-1 basis-48 break-words">{difference.text}</span>
        {difference.status === 'open' ? (
          <>
            <button type="button" className={buttonCls} disabled={busy || !buildId} onClick={() => close({ status: 'fixed' })}><Check size={14} aria-hidden="true" /> Fixed</button>
            <button type="button" className={buttonCls} disabled={busy || !buildId} onClick={() => setAccepting(true)}>Accept…</button>
          </>
        ) : (
          <button type="button" className={buttonCls} disabled={busy} onClick={() => model.updateDifference(difference.id, { status: 'open' })}><RotateCcw size={14} aria-hidden="true" /> Reopen</button>
        )}
        <button type="button" className={buttonCls} disabled={busy} aria-label={`Delete "${difference.text}"`} onClick={() => setRemoving(true)}><Trash2 size={14} aria-hidden="true" /></button>
      </div>
      {(about || difference.reason || difference.closedBuildId) && (
        <p className="break-words text-xs text-port-text-muted">
          {[about, difference.reason, difference.closedBuildId ? `closed on ${closedOn ? `the build of ${formatDateTime(closedOn.startedAt)}` : difference.closedBuildId}` : null].filter(Boolean).join(' · ')}
        </p>
      )}
      {accepting && (
        <form onSubmit={accept} className="flex min-w-0 flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor={`bm-reason-${difference.id}`} className={labelCls}>Why is this intended?</label>
            <input id={`bm-reason-${difference.id}`} className={inputCls} value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} />
          </div>
          <button type="submit" className={primaryCls} disabled={!reason.trim() || busy}>Accept</button>
          <button type="button" className={buttonCls} onClick={() => setAccepting(false)}>Cancel</button>
        </form>
      )}
      {removing && (
        <InlineConfirmRow autoFocus aria-label="Confirm deleting this difference" question="Delete this difference?"
          onConfirm={() => { setRemoving(false); model.removeDifference(difference.id); }} onCancel={() => setRemoving(false)} />
      )}
    </li>
  );
}

/** What the comparison shows missing. Closing records the shown build; open ones go into the agent brief. */
export default function BlenderModelDifferences({ model, buildId, parts, referenceId }) {
  const { state, pending } = model;
  const [text, setText] = useState('');
  const [partId, setPartId] = useState('');
  const order = Object.keys(STATUS);
  const differences = [...state.differences].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const open = differences.filter((difference) => difference.status === 'open').length;
  const add = async (event) => {
    event.preventDefault();
    if (!text.trim() || pending.difference) return;
    const result = await model.addDifference({ text: text.trim(), ...(partId ? { partId } : {}), ...(referenceId ? { referenceId } : {}) });
    if (result.ok) { setText(''); setPartId(''); }
  };
  return (
    <section aria-label="Differences" className="min-w-0 space-y-2 border-t border-port-border pt-3">
      <h2 className="text-sm font-medium">Differences{open ? ` · ${formatCount(open)} open` : ''}</h2>
      <p className="text-xs text-port-text-muted">What the build is missing or gets wrong. Open ones go into the agent brief as the second pass; accept one that is intended.</p>
      <form onSubmit={add} className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="min-w-0 flex-[3] basis-56">
          <label htmlFor="bm-difference" className={labelCls}>Difference</label>
          <input id="bm-difference" className={inputCls} value={text} maxLength={1000} onChange={(event) => setText(event.target.value)} />
        </div>
        <div className="min-w-0 flex-1 basis-40">
          <label htmlFor="bm-difference-part" className={labelCls}>Part (optional)</label>
          <select id="bm-difference-part" className={inputCls} value={partId} onChange={(event) => setPartId(event.target.value)}>
            <option value="">Any part</option>
            {parts.map((part, index) => <option key={`${part.id}:${index}`} value={part.id}>{part.label || part.id}</option>)}
          </select>
        </div>
        <button type="submit" className={primaryCls} disabled={!text.trim() || !!pending.difference}><Plus size={14} aria-hidden="true" /> Add</button>
      </form>
      {differences.length === 0 ? <p className="text-xs text-port-text-muted">None recorded.</p> : (
        <ul aria-label="Recorded differences" className="min-w-0 divide-y divide-port-border rounded border border-port-border">
          {differences.map((difference) => <Difference key={difference.id} model={model} difference={difference} buildId={buildId} />)}
        </ul>
      )}
    </section>
  );
}
