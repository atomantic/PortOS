/** Queued/rendering status strip with elapsed time and cancel for MusicGenPanel. */

import { renderHint, renderStatusLabel } from './musicGenLabels.js';

export default function MusicGenerationStatus({ activeJob, activeJobId, generationEngine, elapsedSec, onCancel }) {
  return (
    <div role="status" className="rounded-lg border border-port-accent/30 bg-port-accent/10 px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-gray-300">{renderStatusLabel(activeJob, generationEngine)}</span>
        <span className="font-mono tabular-nums text-port-accent">
          {Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, '0')} elapsed
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-port-border" aria-hidden="true">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-port-accent" />
      </div>
      <p className="mt-1.5 text-[11px] text-gray-500">{renderHint(generationEngine)}</p>
      {activeJobId ? <button type="button" onClick={onCancel} className="mt-2 text-[11px] text-port-warning hover:text-white">Cancel render</button> : null}
    </div>
  );
}
