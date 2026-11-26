import { useRef } from 'react';
import { Link } from 'react-router';
import { formatTimecode } from '../../utils/formatters.js';

const button = 'min-h-[44px] rounded border border-port-border px-2 text-xs hover:border-port-accent focus-visible:outline-port-accent disabled:opacity-50 pointer-fine:sm:min-h-7';
const timecode = (sec) => formatTimecode(sec, 3);

export function TimelineRangeControls({ range, valid, limit, rangeMessage, previewMessage, pointMessage, onSetPoint, onChange, excerpts, draftUnavailable, projectId }) {
  const loopUnavailable = pointMessage || previewMessage;
  const busy = excerpts?.occupied;
  const renderMessage = excerpts?.rendering
    ? (excerpts.activeRenderId ? `Rendering draft · ${Math.round(excerpts.progress)}%` : 'Starting draft render…')
    : busy ? 'Wait for the current draft render to finish.' : (draftUnavailable || rangeMessage);
  return (
    <div role="group" aria-label="In/out range" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-port-border px-2 py-1">
      <button type="button" className={button} disabled={!limit || !!pointMessage} onClick={() => onSetPoint('start')}>Set In</button>
      <button type="button" className={button} disabled={!limit || !!pointMessage} onClick={() => onSetPoint('end')}>Set Out</button>
      <span className="text-xs tabular-nums text-port-text-muted">
        In {range?.start == null ? '—' : timecode(range.start)} · Out {range?.end == null ? '—' : timecode(range.end)}
        {valid && ` · ${(range.end - range.start).toFixed(3)}s`}
      </span>
      <button type="button" className={button} disabled={!range} onClick={() => onChange(null)}>Clear Range</button>
      <button type="button" className={`${button} ${range?.loop && !loopUnavailable ? 'text-port-accent' : ''}`}
        aria-pressed={!!range?.loop} disabled={!range?.loop && (!valid || !!loopUnavailable)}
        onClick={() => onChange({ ...range, loop: !range.loop })}>Loop Range</button>
      <button type="button" className={`${button} text-port-accent`} disabled={!!renderMessage}
        onClick={() => excerpts.startExcerpt(range.start, range.end)}>Render Draft</button>
      {(renderMessage || loopUnavailable) && <span role="status" className="text-xs text-port-text-muted">
        {[...new Set([rangeMessage, renderMessage, loopUnavailable])].filter(Boolean).join(' ')}
      </span>}
      <Link to={`/music-video/${encodeURIComponent(projectId)}/review#mv-draft-excerpts`} className="text-xs text-port-accent hover:underline">View drafts in Review</Link>
    </div>
  );
}

function RangeMarker({ edge, time, limit, pxPerSec, onChange }) {
  const drag = useRef(null);
  const move = (event) => {
    const start = drag.current;
    if (!start || event.pointerId !== start.id || event.clientX === start.lastX) return;
    start.lastX = event.clientX;
    onChange(edge, start.time + (event.clientX - start.x) / pxPerSec);
  };
  const stop = (event) => { if (event.pointerId === drag.current?.id) drag.current = null; };
  return (
    <div role="slider" tabIndex={0} aria-label={edge === 'start' ? 'In point' : 'Out point'}
      aria-valuemin={0} aria-valuemax={limit} aria-valuenow={time} aria-valuetext={timecode(time)}
      className={`absolute z-10 flex h-1/2 w-5 -translate-x-1/2 cursor-ew-resize touch-none select-none items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-port-accent pointer-coarse:w-8 ${edge === 'start' ? 'top-0' : 'bottom-0'}`}
      style={{ left: `clamp(10px, ${time * pxPerSec}px, calc(100% - 10px))` }}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        drag.current = { id: event.pointerId, time, x: event.clientX, lastX: event.clientX };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => { move(event); stop(event); }}
      onLostPointerCapture={stop}
      onPointerCancel={stop}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 1 : 1 / 24;
        const next = { ArrowLeft: time - step, ArrowDown: time - step, ArrowRight: time + step, ArrowUp: time + step, Home: 0, End: limit }[event.key];
        if (next == null) return;
        event.preventDefault();
        onChange(edge, next);
      }}>
      <span aria-hidden="true" className={`h-full w-1 bg-port-accent ${edge === 'start' ? 'rounded-t' : 'rounded-b'}`} />
    </div>
  );
}

export function TimelineRangeMarks({ range, valid, limit, pxPerSec, onChange }) {
  if (!range) return null;
  return (
    <>
      {valid && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 bg-port-accent/25"
        style={{ left: range.start * pxPerSec, width: (range.end - range.start) * pxPerSec }} />}
      {['start', 'end'].map((edge) => range[edge] != null && (
        <RangeMarker key={edge} edge={edge} time={range[edge]} limit={limit} pxPerSec={pxPerSec} onChange={onChange} />
      ))}
    </>
  );
}
