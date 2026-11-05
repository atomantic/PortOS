import { useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import { formatCount } from '../../utils/formatters.js';

const buttonClass = 'flex items-center gap-1 rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

/**
 * Plain-text feedback on a Cast & Sets sheet. Aimed at the whole sheet, the
 * server rewrites the direction (and the look line every image prompt
 * carries) to honor it, plans what changed, and keeps honoring it on
 * later revisions and rebuilds until it is removed here. Aimed at one image,
 * it is that image's revision note. The last revision's change summary shows
 * under the box.
 */
export default function CastAndSetsFeedback({ stage, busy, onApply, onRemove, onRemoveImage, onRender, onRefreshRenderer, allowApply = true }) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const images = Object.values(stage.plan || {});
  const standing = stage.feedback || [];
  const imageNotes = Object.entries(stage.keyNotes || {}).flatMap(([key, notes]) => notes.map((text, index) => ({ key, text, index })));
  const summary = stage.changeSummary?.revision === stage.revision ? stage.changeSummary : null;
  const renderPlan = stage.feedbackRenderPlan;
  const renderKeys = renderPlan?.keys || [];
  const queued = Object.values(stage.images || {}).filter((image) => image.status === 'queued').length;
  const apply = () => {
    const value = text.trim();
    if (!value) return;
    onApply({ text: value, target: target || null }).then((res) => {
      if (res) { setText(''); setTarget(''); }
    });
  };
  return (
    <div className="min-w-0 space-y-2 rounded border border-port-border bg-port-bg/40 p-2">
      {allowApply && <>
      <label htmlFor="mv-cast-feedback" className="block text-xs text-port-text-muted">What should change?</label>
      <AutoSizeTextarea
        id="mv-cast-feedback"
        value={text}
        rows={2}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Fewer light sources, more like eighties analog film"
        className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        {images.length > 0 && (
          <>
            <label htmlFor="mv-cast-feedback-target" className="sr-only">Applies to</label>
            <select id="mv-cast-feedback-target" value={target} onChange={(e) => setTarget(e.target.value)}
              className="min-h-[44px] min-w-0 max-w-full flex-1 rounded border border-port-border bg-port-bg px-2 py-1 text-sm sm:min-h-0 sm:flex-none">
              <option value="">Whole sheet</option>
              {images.map((item) => <option key={item.key} value={item.key}>{item.label || item.key}</option>)}
            </select>
          </>
        )}
        <button type="button" disabled={busy || queued > 0 || !text.trim()} onClick={apply} className={`${buttonClass} bg-port-accent text-white`}>
          <MessageSquare size={14} aria-hidden="true" /> Apply feedback without rendering
        </button>
      </div>
      <p className="text-xs text-port-text-muted">
        {target ? 'Saves an image note without a direction-model call.' : 'Revises the direction with the configured AI provider; price unavailable and the provider may charge. This feedback remains in effect on later revisions until removed.'}
        {' '}Existing images stay in place. Review the image plan before starting any renders.
        {stage.status === 'approved' && ' This re-opens the check-in for review.'}
      </p>
      </>}
      {renderPlan?.phase === 'ready' && (
        <div className="space-y-2 rounded border border-port-warning/60 p-2 text-xs" role="status">
          <p className="text-port-warning">{formatCount(renderKeys.length)} {renderKeys.length === 1 ? 'image is' : 'images are'} waiting to render. No new images will start until you choose to render.</p>
          {queued > 0 && <p>{formatCount(queued)} previously queued {queued === 1 ? 'image may' : 'images may'} still finish. Wait for {queued === 1 ? 'it' : 'them'} before rendering the rest.</p>}
          {renderKeys.length > 0 && <p className="break-words">Planned: {renderKeys.map((key) => stage.plan?.[key]?.label || key).join(', ')}</p>}
          <p>Image renderer: {stage.route?.mode ? `${stage.route.mode}${stage.route.model ? ` · ${stage.route.model}` : ''}` : 'unavailable'}.</p>
          <p>Price unavailable; the provider may charge. Image renders, vision checks, and retries may add costs. Production-run limits may not apply.</p>
          {!stage.route && renderKeys.length > 0 && <div className="flex flex-wrap items-center gap-2">
            <p>Enable an image renderer, then refresh it without resubmitting feedback.</p>
            <button type="button" disabled={busy || queued > 0 || !onRefreshRenderer} onClick={() => onRefreshRenderer({ revision: stage.revision })}
              className={`${buttonClass} border border-port-border`}>Refresh renderer</button>
          </div>}
          <button type="button" disabled={busy || queued > 0 || !onRender || (!stage.route && renderKeys.length > 0)}
            onClick={() => onRender({ revision: stage.revision, count: renderKeys.length })} className={`${buttonClass} border border-port-border`}>
            {renderKeys.length ? `Render ${formatCount(renderKeys.length)} ${renderKeys.length === 1 ? 'image' : 'images'}` : 'Continue without rendering'}
          </button>
        </div>
      )}
      {summary && (
        <p className="text-xs text-port-text-muted" role="status">
          Revision {stage.revision}: {summary.changes.length ? summary.changes.join(' · ') : 'nothing the images are built from changed'}
          {' · '}{formatCount(summary.planned ?? summary.rerendered, { fallback: '0' })} {(summary.planned ?? summary.rerendered) === 1 ? 'image' : 'images'} {summary.planned != null ? 'planned' : 're-rendered'}
        </p>
      )}
      {standing.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-port-text-muted">Standing feedback ({formatCount(standing.length)})</summary>
          <p className="mt-1 text-port-text-muted">Removing feedback stops it from shaping future direction revisions; it does not undo changes already planned.</p>
          <ul className="mt-1 space-y-1">
            {standing.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <span className="min-w-0 flex-1 break-words">{f.text}</span>
                <button type="button" disabled={busy || !onRemove} onClick={() => onRemove(f.id)} aria-label={`Stop applying: ${f.text}`}
                  title="Stop applying this to later revisions"
                  className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-port-text-muted hover:text-port-error disabled:opacity-50 sm:min-h-0 sm:min-w-0">
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {imageNotes.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-port-text-muted">Image revision notes ({formatCount(imageNotes.length)})</summary>
          <p className="mt-1 text-port-text-muted">Removing a note stops it from shaping future image plans; it does not undo changes already planned.</p>
          <ul className="mt-1 space-y-1">
            {imageNotes.map(({ key, text, index }) => (
              <li key={`${key}:${index}`} className="flex items-start gap-2">
                <span className="min-w-0 flex-1 break-words">{stage.plan?.[key]?.label || key}: {text}</span>
                <button type="button" disabled={busy || !onRemoveImage} onClick={() => onRemoveImage({ key, index, text })}
                  aria-label={`Remove image note from ${stage.plan?.[key]?.label || key}: ${text}`}
                  className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-port-text-muted hover:text-port-error disabled:opacity-50 sm:min-h-0 sm:min-w-0">
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
