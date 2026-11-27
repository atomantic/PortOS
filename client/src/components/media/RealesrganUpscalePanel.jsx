import RealesrganInstallButton from './RealesrganInstallButton';

// The Real-ESRGAN weights the server can run (`REALESRGAN_MODEL_IDS`), in picker order.
const REALESRGAN_MODEL_OPTIONS = Object.freeze([
  { id: 'realesrgan-x4plus', label: 'General footage (x4plus)' },
  { id: 'realesr-animevideov3', label: 'Animation (animevideov3)' },
]);

export default function RealesrganUpscalePanel({
  model, onModelChange, readiness: { plan, loading, error, runtime, refreshPlan },
}) {
  return (
    <div className="p-2 border border-port-border rounded space-y-1 text-[11px] text-gray-400">
      <p className="text-xs font-medium text-white">Before you submit</p>
      <label htmlFor="realesrgan-model" className="block">Weights</label>
      <select
        id="realesrgan-model"
        value={model}
        onChange={(event) => onModelChange(event.target.value)}
        className="bg-port-bg border border-port-border rounded p-1 text-xs"
      >
        {REALESRGAN_MODEL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {loading && <p>Checking Real-ESRGAN readiness…</p>}
      {error && <p role="alert" className="text-port-error">{error}</p>}
      {runtime && (
        <>
          {runtime.installTarget && (
            <p>
              Runtime: <span className="text-white">{runtime.label} {runtime.installTarget.version}</span>
              {' '}({runtime.installTarget.archive}, SHA-256 pinned, from{' '}
              <a className="underline text-port-accent" href={runtime.installTarget.releasePage} target="_blank" rel="noreferrer">the official release</a>)
            </p>
          )}
          <p>
            Target size:{' '}
            <span className="text-white">{plan.target?.width ?? '?'}×{plan.target?.height ?? '?'}</span>
            {plan.target?.frameCount ? `, ${plan.target.frameCount} frames` : ''}
            {plan.source?.fps ? ` at ${Math.round(plan.source.fps * 1000) / 1000} fps` : ''}
          </p>
          {runtime.installed ? (
            <p className="text-port-success">Installed and checked{runtime.gpu ? ` on ${runtime.gpu}` : ''}.</p>
          ) : (
            <p role="alert" className="text-port-warning">
              {runtime.reason}
              {runtime.supported && (
                <>
                  {' '}
                  <RealesrganInstallButton installTarget={runtime.installTarget} onInstalled={refreshPlan} />
                </>
              )}
            </p>
          )}
          <p>The original clip stays unchanged; the upscale lands as a new video.</p>
        </>
      )}
    </div>
  );
}
