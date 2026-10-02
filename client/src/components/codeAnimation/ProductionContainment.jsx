import { useEffect, useState } from 'react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { getCodeAnimationExecution, probeCodeAnimationExecution, updateCodeAnimationExecutionTools } from '../../services/apiCodeAnimation';
import { formatCount } from '../../utils/formatters';

const buttonClass = 'rounded border border-port-border px-3 py-2 text-sm hover:border-port-accent disabled:opacity-50';

/** Machine-level contained-execution status: fail-closed readiness, operator tool path, on-demand check. */
export default function ProductionContainment() {
  const [execution, setExecution] = useState(null);
  const [blenderPath, setBlenderPath] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [mode, setMode] = useState('contained');
  const [engine, setEngine] = useState('CYCLES');
  const [acknowledged, setAcknowledged] = useState(false);
  const apply = (next) => {
    if (!next) return;
    setExecution(next);
    const path = next.tools.blender.executable || '';
    setSavedPath(path);
    setBlenderPath(path);
    setMode(next.executionMode || 'contained');
    setEngine(next.tools.blender.engine || 'CYCLES');
    setAcknowledged(next.executionMode === 'trusted-local');
  };
  useEffect(() => {
    let active = true;
    getCodeAnimationExecution({ silent: true }).then(next => { if (active) apply(next); }, () => {});
    return () => { active = false; };
  }, []);
  const [save, saving] = useAsyncAction(async () => apply(await updateCodeAnimationExecutionTools({ blender: { executable: blenderPath.trim() || null, executionMode: mode, engine, acknowledgeHostAccess: acknowledged } }, { silent: true })));
  const [probe, probing] = useAsyncAction(async () => apply(await probeCodeAnimationExecution({ silent: true })));
  if (!execution) return null;
  const { mechanism, lanes, probe: result } = execution;
  const dirty = blenderPath.trim() !== savedPath || mode !== (execution.executionMode || 'contained') || engine !== (execution.tools.blender.engine || 'CYCLES') || acknowledged !== (execution.executionMode === 'trusted-local');
  return <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4">
    <h2 className="text-base font-semibold">Blender execution</h2>
    <p className="text-sm text-gray-400">Contained mode is the default and refuses execution when its sandbox cannot run Blender. Trusted-local mode requires your explicit acknowledgement and runs only source you trust. No automatic fallback occurs.</p>
    <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-3">
      <p>Sandbox: {mechanism.supported ? mechanism.id : <span className="text-port-warning">{mechanism.reason}</span>}</p>
      <p>Browser lane: {lanes.browser.mechanism}</p>
      <p>Blender lane: {lanes.blender.ready ? 'Ready for production rendering' : <span className="text-port-warning">{lanes.blender.reason}</span>}</p>
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div><label htmlFor="cap-blender-mode" className="mb-1 block text-sm">Execution mode</label>
        <select id="cap-blender-mode" value={mode} disabled={saving || probing} onChange={event => { setMode(event.target.value); setAcknowledged(false); }} className="w-full rounded border border-port-border bg-port-bg p-2 text-sm">
          <option value="contained">Contained (default)</option><option value="trusted-local">Trusted local (host access)</option>
        </select></div>
      <div><label htmlFor="cap-blender-engine" className="mb-1 block text-sm">Render engine</label>
        <select id="cap-blender-engine" value={engine} disabled={saving || probing} onChange={event => setEngine(event.target.value)} className="w-full rounded border border-port-border bg-port-bg p-2 text-sm">
          <option value="CYCLES">Cycles CPU</option><option value="BLENDER_EEVEE_NEXT">EEVEE GPU</option>
        </select></div>
    </div>
    {mode === 'trusted-local' && <div className="space-y-2 rounded border border-port-warning p-3 text-sm">
      <p>{execution.trustedLocalWarning || 'Trusted-local Blender can access this account’s host filesystem, network and processes. Environment scrubbing and process supervision are not containment.'}</p>
      <label htmlFor="cap-blender-ack" className="flex items-start gap-2"><input id="cap-blender-ack" type="checkbox" checked={acknowledged} disabled={saving || probing} onChange={event => setAcknowledged(event.target.checked)} />I understand the host access and trust the source I will run.</label>
    </div>}
    <p className="text-xs text-gray-400">Cycles CPU can take substantial time for a full sequence. EEVEE needs a successful GPU check and disables motion blur to preserve stepped holds. Project version and engine must match the checked runtime.</p>
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-72">
        <label htmlFor="cap-blender-path" className="mb-1 block text-sm">Blender executable (operator-owned)</label>
        <input id="cap-blender-path" disabled={saving || probing} value={blenderPath} onChange={event => setBlenderPath(event.target.value)} placeholder="/Applications/Blender.app/Contents/MacOS/Blender" className="w-full min-w-0 rounded border border-port-border bg-port-bg px-3 py-2 text-sm" />
      </div>
      <button type="button" className={buttonClass} disabled={!dirty || saving || probing || (mode === 'trusted-local' && !acknowledged)} onClick={save}>{saving ? 'Saving…' : 'Save tool'}</button>
      <button type="button" className={buttonClass} disabled={dirty || saving || probing || (mode === 'contained' && !mechanism.supported)} onClick={probe}>{probing ? 'Checking execution…' : 'Run execution check'}</button>
    </div>
    {execution.tools.blender.problem && savedPath && <p className="text-sm text-port-warning">{execution.tools.blender.problem}</p>}
    {result && <div role="status" className="space-y-1 text-sm">
      <p>{result.refused || `${result.passed ? (result.contained === false ? 'Trusted-local supervision checked' : 'Containment proven') : 'Execution check failed'}: ${formatCount(result.checks.filter(check => check.passed).length)} of ${formatCount(result.checks.length)} checks`}</p>
      <ul className="space-y-1">
        {result.checks.map(check => <li key={check.id} className={check.passed ? 'text-gray-400' : 'text-port-error'}>{check.passed ? 'Pass' : 'Fail'} · {check.detail}</li>)}
        {result.tools?.blender && <li className={result.tools.blender.passed ? 'text-gray-400' : 'text-port-warning'}>{result.tools.blender.detail}</li>}
      </ul>
    </div>}
  </section>;
}
