import { FAL_SEEDVR2_TARGET_RESOLUTIONS } from '../../../../server/lib/videoGenRequestFields.js';
import { formatUsd } from '../../utils/formatters';

export default function FalSeedvr2UpscalePanel({
  targetResolution, onTargetResolutionChange, musicVideo, readiness: { plan, loading, error },
}) {
  return (
    <div className="p-2 border border-port-border rounded space-y-1 text-[11px] text-gray-400">
      <label htmlFor="upscale-target-resolution" className="text-xs font-medium text-white">Target resolution</label>
      <select id="upscale-target-resolution" value={targetResolution} onChange={(event) => onTargetResolutionChange(event.target.value)} className="ml-2 rounded border border-port-border bg-port-bg p-1">
        {FAL_SEEDVR2_TARGET_RESOLUTIONS.map((resolution) => <option key={resolution}>{resolution}</option>)}
      </select>
      {loading && <p>Checking fal.ai readiness…</p>}
      {error && <p role="alert" className="text-port-error">{error}</p>}
      {plan && !plan.runtime?.installed && (
        <p role="alert" className="text-port-warning">{plan.runtime?.reason || 'Configure FAL_KEY in Settings → Credentials.'}</p>
      )}
      {musicVideo && plan?.runtime?.installed && plan.estimatedCostUsd == null && (
        <p role="alert" className="text-port-warning">The selected clip could not be measured for a cost estimate.</p>
      )}
      {plan && plan.runtime?.installed && (
        <>
          <p>Model: <span className="text-white">fal-ai/seedvr/upscale/video</span></p>
          <p>
            Target size:{' '}
            <span className="text-white">
              {plan.target?.width ?? '?'}×{plan.target?.height ?? '?'}
            </span>
            {plan.target?.frameCount ? `, ${plan.target.frameCount} frames` : ''}
          </p>
          {plan.estimatedCostUsd != null && (
            <p>Estimated cost: <span className="text-white">{formatUsd(plan.estimatedCostUsd)}</span> ($0.001/MP billed to fal.ai)</p>
          )}
        </>
      )}
    </div>
  );
}
