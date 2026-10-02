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
  const apply = (next) => {
    if (!next) return;
    setExecution(next);
    const path = next.tools.blender.executable || '';
    setSavedPath(path);
    setBlenderPath(path);
  };
  useEffect(() => {
    let active = true;
    getCodeAnimationExecution({ silent: true }).then(next => { if (active) apply(next); }, () => {});
    return () => { active = false; };
  }, []);
  const [save, saving] = useAsyncAction(async () => apply(await updateCodeAnimationExecutionTools({ blender: { executable: blenderPath.trim() || null } }, { silent: true })));
  const [probe, probing] = useAsyncAction(async () => apply(await probeCodeAnimationExecution({ silent: true })));
  if (!execution) return null;
  const { mechanism, lanes, probe: result } = execution;
  const dirty = blenderPath.trim() !== savedPath;
  return <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4">
    <h2 className="text-base font-semibold">Contained execution</h2>
    <p className="text-sm text-gray-400">Production code runs only inside an enforced sandbox with no network, credentials, host APIs or access outside its workspace. Without one, execution is refused.</p>
    <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-3">
      <p>Sandbox: {mechanism.supported ? mechanism.id : <span className="text-port-warning">{mechanism.reason}</span>}</p>
      <p>Browser lane: {lanes.browser.mechanism}</p>
      <p>Blender lane: {lanes.blender.ready ? 'Test scene rendered (production adapter pending)' : <span className="text-port-warning">{lanes.blender.reason}</span>}</p>
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-72">
        <label htmlFor="cap-blender-path" className="mb-1 block text-sm">Blender executable (operator-owned)</label>
        <input id="cap-blender-path" value={blenderPath} onChange={event => setBlenderPath(event.target.value)} placeholder="/Applications/Blender.app/Contents/MacOS/Blender" className="w-full min-w-0 rounded border border-port-border bg-port-bg px-3 py-2 text-sm" />
      </div>
      <button type="button" className={buttonClass} disabled={!dirty || saving || probing} onClick={save}>{saving ? 'Saving…' : 'Save tool'}</button>
      <button type="button" className={buttonClass} disabled={dirty || saving || probing || !mechanism.supported} onClick={probe}>{probing ? 'Checking containment…' : 'Run containment check'}</button>
    </div>
    {execution.tools.blender.problem && savedPath && <p className="text-sm text-port-warning">{execution.tools.blender.problem}</p>}
    {result && <div role="status" className="space-y-1 text-sm">
      <p>{result.refused || `${result.passed ? 'Containment proven' : 'Containment check failed'}: ${formatCount(result.checks.filter(check => check.passed).length)} of ${formatCount(result.checks.length)} checks`}</p>
      <ul className="space-y-1">
        {result.checks.map(check => <li key={check.id} className={check.passed ? 'text-gray-400' : 'text-port-error'}>{check.passed ? 'Pass' : 'Fail'} · {check.detail}</li>)}
        {result.tools?.blender && <li className={result.tools.blender.passed ? 'text-gray-400' : 'text-port-warning'}>{result.tools.blender.detail}</li>}
      </ul>
    </div>}
  </section>;
}
