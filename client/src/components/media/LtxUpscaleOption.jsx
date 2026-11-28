import { formatBytes } from '../../utils/formatters';

export default function LtxUpscaleOption({
  selected, onSelect, readiness: { plan, loading, error, ready, adapterMissing, reason, downloading, downloadFrame, downloadAdapter },
}) {
  const dlPct = typeof downloadFrame?.progress === 'number' ? Math.round(downloadFrame.progress * 100) : null;
  return (
    <label
      htmlFor="upscale-method-ltx"
      className={`flex items-start gap-2 p-2 border rounded ${
        ready ? 'border-port-border hover:border-port-accent/60 cursor-pointer' : 'border-port-border/50 opacity-80'
      }`}
    >
      <input
        type="radio"
        id="upscale-method-ltx"
        name="upscale-method"
        value="ltx"
        checked={selected}
        disabled={!ready}
        onChange={onSelect}
        className="mt-0.5"
        aria-describedby={reason ? 'upscale-method-ltx-reason' : undefined}
      />
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-white">LTX-2.5 generative (synthesizes detail)</span>
        <span className="block text-[11px] text-gray-500">2× via a GPU model — adds detail rather than resizing pixels.</span>
        {loading && <span className="block text-[11px] text-gray-500 mt-1">Checking readiness…</span>}
        {error && <span role="status" className="block text-[11px] text-port-error mt-1">{error}</span>}
        {reason && (
          <span id="upscale-method-ltx-reason" className="block text-[11px] text-port-warning mt-1">
            {reason}
            {adapterMissing && (
              <>
                {' '}
                {downloading ? (
                  <span className="text-gray-400">
                    {downloadFrame?.type === 'verify' ? 'Verifying…' : 'Downloading…'}
                    {dlPct != null ? ` ${dlPct}%` : ''}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={downloadAdapter}
                    className="text-port-accent hover:text-white underline"
                  >
                    Download adapter{plan.adapter?.sizeBytes ? ` (${formatBytes(plan.adapter.sizeBytes)})` : ''}
                  </button>
                )}
              </>
            )}
          </span>
        )}
      </span>
    </label>
  );
}

export function LtxUpscaleDetails({ plan }) {
  return (
    <div className="p-2 border border-port-border rounded space-y-1 text-[11px] text-gray-400">
      <p className="text-xs font-medium text-white">Before you submit</p>
      <p>Model: <span className="text-white">{plan.adapter?.label || 'LTX-2.5 Pixel Spatial Upscaler'}</span></p>
      <p>
        Target size:{' '}
        <span className="text-white">
          {plan.target?.width ?? '?'}×{plan.target?.height ?? '?'}
        </span>
        {plan.target?.frameCount ? `, ${plan.target.frameCount} frames` : ''}
      </p>
      {plan.alignment && plan.alignment.conforming === false && (
        <p>
          Padding: source pads to {plan.alignment.paddedSource?.width}×{plan.alignment.paddedSource?.height}
          {plan.alignment.padFrames ? `, +${plan.alignment.padFrames} frame(s)` : ''} to fit the model grid
          (cropped back off the output — nothing is trimmed).
        </p>
      )}
      <p className="text-port-warning">
        Details are synthesized, not pixel-faithfully refined — the result will not exactly match the source.
      </p>
    </div>
  );
}
