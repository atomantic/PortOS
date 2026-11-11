import { memo, useState } from 'react';
import { Layers, Square } from 'lucide-react';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { BLENDER_BULK_CONFIRM_ABOVE, BLENDER_BULK_SCOPES, blenderBulkPlan, isBlenderJobActive } from '../../../lib/musicVideoBlender.js';
import { formatCount } from '../../../utils/formatters.js';
import { buttonCls, inputCls } from './blenderStyles.js';

const QUALITY_NOUNS = { preview: 'previews', final: 'finals' };
const QUALITY_LABELS = { preview: 'Previews', final: 'Finals' };

/**
 * Render many shots at once: a scope (missing or out of date / out of date
 * only / everything) and one button per quality showing how many shots it
 * covers, plus Cancel all while jobs run. More than ten shots asks first.
 * `blocked` holds the buttons while renders cannot start; the shot detail says why.
 */
function BlenderBulkActions({ blender, blocked = false }) {
  const { state, pending } = blender;
  const [scope, setScope] = useState('needed');
  const [confirming, setConfirming] = useState(null);
  const plans = { preview: blenderBulkPlan(state, 'preview', scope), final: blenderBulkPlan(state, 'final', scope) };
  const activeJobs = (state.jobs || []).filter(isBlenderJobActive).length;
  const start = (quality) => {
    setConfirming(null);
    blender.render(plans[quality].body, 'bulk');
  };
  const request = (quality) => {
    if (plans[quality].shotIds.length > BLENDER_BULK_CONFIRM_ABOVE) setConfirming(quality);
    else start(quality);
  };
  const confirmCount = confirming ? plans[confirming].shotIds.length : 0;

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <label htmlFor="mv-blender-bulk-scope" className="shrink-0 text-xs text-port-text-muted">Render</label>
          <select id="mv-blender-bulk-scope" value={scope} onChange={(event) => { setScope(event.target.value); setConfirming(null); }} className={inputCls}>
            {BLENDER_BULK_SCOPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {['preview', 'final'].map((quality) => {
          const count = plans[quality].shotIds.length;
          const starting = !!pending[`render:bulk:${quality}`];
          return (
            // The visible label is short for the narrow list column; the name says what it does.
            <button key={quality} type="button" className={buttonCls} disabled={blocked || starting || count === 0} onClick={() => request(quality)}
              aria-label={`Render ${QUALITY_NOUNS[quality]} (${formatCount(count)})`}
              title={count === 0 ? `No ${QUALITY_NOUNS[quality]} to render in this scope` : `Render ${formatCount(count)} ${QUALITY_NOUNS[quality]}`}>
              <Layers size={14} aria-hidden="true" />
              {starting ? 'Queuing…' : `${QUALITY_LABELS[quality]} (${formatCount(count)})`}
            </button>
          );
        })}
        {activeJobs > 0 && (
          <button type="button" className={buttonCls} disabled={!!pending['cancel:all']} onClick={() => blender.cancelAll()}>
            <Square size={14} aria-hidden="true" />
            {pending['cancel:all'] ? 'Canceling…' : `Cancel all (${formatCount(activeJobs)})`}
          </button>
        )}
      </div>
      {confirming && (
        <InlineConfirmRow
          tone="warning"
          aria-label={`Confirm rendering ${confirmCount} ${QUALITY_NOUNS[confirming]}`}
          question={`Queue ${formatCount(confirmCount)} ${confirming} renders?${scope === 'all' ? ' This also re-renders shots that are up to date.' : ''}`}
          confirmText="Render"
          onConfirm={() => start(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

export default memo(BlenderBulkActions);
