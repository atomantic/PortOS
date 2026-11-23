import { useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import { buttonCls, inputCls, labelCls } from '../musicVideo/blender/blenderStyles.js';
import BlenderModelReferenceSource from './BlenderModelReferenceSource.jsx';
import BlenderModelReferenceSlot from './BlenderModelReferenceSlot.jsx';

/** Reference images before modeling: the source, the overall sheet, one plate per mechanism, and the parts brief. */
export default function BlenderModelReferencesTab({ model, onOpenTab }) {
  const { state, pending } = model;
  const [mechanism, setMechanism] = useState('');
  const overall = state.references.find((slot) => slot.role === 'overall');
  const closeups = state.references.filter((slot) => slot.role === 'closeup');
  const add = async (event) => {
    event.preventDefault();
    if (mechanism.trim() && (await model.addCloseup(mechanism.trim())).ok) setMechanism('');
  };

  return (
    <div className="@container min-w-0 space-y-5">
      <BlenderModelReferenceSource model={model} />
      <BlenderModelReferenceSlot model={model} slot={overall} title="Overall sheet"
        hint="The whole object from six directions at one scale. Close-ups unlock when one is approved." />
      <section aria-label="Close-up plates" className="min-w-0 space-y-3 border-t border-port-border pt-3">
        <div>
          <h2 className="text-sm font-medium">Close-up plates</h2>
          <p className="text-xs text-port-text-muted">One image per mechanism, square-on and from the side.{overall.approvedImageId ? '' : ' Approve the overall sheet to render them.'}</p>
        </div>
        <form onSubmit={add} className="flex min-w-0 flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor="bm-mechanism" className={labelCls}>Mechanism (hinge, latch, wheel hub)</label>
            <input id="bm-mechanism" className={inputCls} value={mechanism} maxLength={80} onChange={(event) => setMechanism(event.target.value)} />
          </div>
          <button type="submit" className={buttonCls} disabled={!mechanism.trim() || !!pending.closeup}><Plus size={14} aria-hidden="true" /> Add plate</button>
        </form>
        {closeups.map((slot) => <BlenderModelReferenceSlot key={slot.id} model={model} slot={slot} title={slot.mechanism} removable />)}
      </section>
      <section aria-label="Parts brief" className="min-w-0 space-y-2 border-t border-port-border pt-3">
        <h2 className="text-sm font-medium">Parts brief</h2>
        <p className="text-xs text-port-text-muted">What the coding agent reads with the sheets: axes and size, how it carries its weight, parts, joints, and which view wins.</p>
        {state.workspace.hasPartsBrief ? (
          <button type="button" className={buttonCls} onClick={() => onOpenTab('files', { bfile: 'PARTS.md' })}><FileText size={14} aria-hidden="true" /> Edit PARTS.md</button>
        ) : (
          <button type="button" className={buttonCls} disabled={!!pending.partsBrief} onClick={model.createPartsBrief}><FileText size={14} aria-hidden="true" /> Create PARTS.md</button>
        )}
      </section>
    </div>
  );
}
