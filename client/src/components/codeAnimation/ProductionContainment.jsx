import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { findCodeAnimationBlender, getCodeAnimationExecution, probeCodeAnimationExecution, updateCodeAnimationExecutionTools } from '../../services/apiCodeAnimation';
import { formatCount } from '../../utils/formatters';

const buttonClass = 'rounded border border-port-border px-3 py-2 text-sm hover:border-port-accent disabled:opacity-50';
const actionClass = 'inline-flex min-h-[44px] items-center justify-center rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-port-on-accent hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-port-accent disabled:opacity-40';

/** Machine-level contained-execution status: fail-closed readiness, operator tool path, on-demand check. */
export default function ProductionContainment({ rendererKind = null, inline = false, onExecutionChange, refreshKey = 0, openRequest = 0, locked = false }) {
  const { hash } = useLocation();
  const sectionRef = useRef(null);
  const summaryRef = useRef(null);
  const onExecutionChangeRef = useRef(onExecutionChange);
  onExecutionChangeRef.current = onExecutionChange;
  const [execution, setExecution] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false);
  const [blenderPath, setBlenderPath] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [mode, setMode] = useState('contained');
  const [engine, setEngine] = useState('CYCLES');
  const [acknowledged, setAcknowledged] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [candidates, setCandidates] = useState(null);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState('');
  const [findAgain, setFindAgain] = useState(0);
  const blenderReady = execution?.lanes?.blender?.ready;
  const executionLoaded = Boolean(execution);
  const blocking = rendererKind === 'blender' && blenderReady === false;
  useEffect(() => {
    if (rendererKind !== 'blender' && hash !== '#blender-execution') setOpen(false);
  }, [rendererKind, hash]);
  useEffect(() => {
    if (blocking) setOpen(true);
  }, [blocking]);
  useEffect(() => {
    if (inline && blenderReady === true) setOpen(false);
  }, [inline, blenderReady]);
  useEffect(() => {
    if (hash !== '#blender-execution' || !executionLoaded) return;
    setOpen(true);
    sectionRef.current?.scrollIntoView?.({ block: 'start' });
    summaryRef.current?.focus({ preventScroll: true });
  }, [hash, executionLoaded]);
  useEffect(() => {
    if (!openRequest || !executionLoaded) return;
    setOpen(true);
    sectionRef.current?.scrollIntoView?.({ block: 'start' });
    summaryRef.current?.focus({ preventScroll: true });
  }, [openRequest, executionLoaded]);
  const apply = (next) => {
    if (!next) return;
    setExecution(next);
    const path = next.tools.blender.executable || '';
    setSavedPath(path);
    setBlenderPath(path);
    setMode(next.executionMode || 'contained');
    setEngine(next.tools.blender.engine || 'CYCLES');
    setAcknowledged(next.executionMode === 'trusted-local');
    setLoadError('');
  };
  useEffect(() => {
    let active = true;
    setExecution(null);
    getCodeAnimationExecution({ silent: true }).then(next => { if (active) apply(next); }, error => {
      if (!active) return;
      setLoadError(error?.message || 'Could not check Blender setup.');
    });
    return () => { active = false; };
  }, [refreshKey, reload]);
  const canFind = execution?.platform === 'darwin' && !execution?.tools?.blender?.executable;
  useEffect(() => {
    if (!canFind) return;
    let active = true;
    setFinding(true);
    setCandidates(null);
    setFindError('');
    findCodeAnimationBlender({ silent: true, hostControlOptional: true }).then(result => {
      if (!active) return;
      setCandidates(Array.isArray(result?.candidates) ? result.candidates : []);
      setFinding(false);
    }, error => {
      if (!active) return;
      setCandidates([]);
      setFindError(error?.message || 'Could not search for Blender.');
      setFinding(false);
    });
    return () => { active = false; };
  }, [canFind, findAgain]);
  const [save, saving] = useAsyncAction(async () => {
    setSetupError('');
    const next = await updateCodeAnimationExecutionTools({ blender: { executable: blenderPath.trim() || null, executionMode: mode, engine, acknowledgeHostAccess: acknowledged } }, { silent: true })
      .catch(error => { setSetupError(error?.message || 'Could not save the Blender executable.'); return null; });
    if (next) apply(next);
  });
  const [probe, probing] = useAsyncAction(async () => {
    setSetupError('');
    const next = await probeCodeAnimationExecution({ silent: true })
      .catch(error => { setSetupError(error?.message || 'Could not check Blender.'); return null; });
    if (next) apply(next);
  });
  const dirty = Boolean(execution) && (blenderPath.trim() !== savedPath || mode !== (execution.executionMode || 'contained') || engine !== (execution.tools.blender.engine || 'CYCLES') || acknowledged !== (execution.executionMode === 'trusted-local'));
  useLayoutEffect(() => {
    onExecutionChangeRef.current?.(execution && !dirty && !saving && !probing ? execution : null);
  }, [execution, dirty, saving, probing]);
  if (!execution) return loadError
    ? <div role="alert" className="space-y-2 rounded-lg border border-port-warning p-3 text-sm"><p>Could not load Blender setup: {loadError}</p><button type="button" className={buttonClass} onClick={() => { setLoadError(''); setReload(value => value + 1); }}>Retry</button></div>
    : <p role="status" className="text-sm text-gray-400">Checking Blender setup…</p>;
  const { mechanism, lanes, probe: result } = execution;
  const shown = open || blocking;
  const busy = locked || saving || probing;
  const effectiveReady = lanes.blender.ready && !dirty && !saving && !probing;
  const checkedEngine = execution.tools.blender.engine === 'BLENDER_EEVEE_NEXT' ? 'EEVEE GPU' : 'Cycles CPU';
  const status = saving ? 'Saving Blender…' : probing ? 'Checking Blender…' : dirty ? 'Unsaved changes' : lanes.blender.ready ? `Ready · checked ${checkedEngine}` : lanes.blender.reason;
  return <details id="blender-execution" ref={sectionRef} open={shown} onToggle={event => { if (blocking) { event.currentTarget.open = true; return; } setOpen(event.currentTarget.open); }} className="space-y-3 rounded-xl border border-port-border bg-port-card p-4">
    <summary ref={summaryRef} className="cursor-pointer text-base font-semibold">{inline ? 'Blender setup' : 'Blender execution'} <span className={effectiveReady ? 'text-sm font-normal text-gray-400' : 'text-sm font-normal text-port-warning'}>{status}</span></summary>
    {inline && !effectiveReady && <p className="text-sm text-gray-300">{saving ? 'Saving Blender settings…' : probing ? 'Checking Blender before rendering…' : dirty
      ? 'Save the changes, then check Blender before rendering.' : !savedPath
      ? '1. Select an installed Blender or enter its path. 2. Save Blender. 3. Check Blender before rendering.'
      : mode === 'contained' && !mechanism.supported
        ? 'Resolve the sandbox requirement above before checking Blender.'
        : 'Blender is saved. Select Check Blender before rendering.'}</p>}
    {locked && <p role="status" className="text-sm text-gray-400">Waiting for the current request before changing Blender settings.</p>}
    {!inline && <p className="text-sm text-gray-400">Contained mode refuses execution when its sandbox cannot run Blender.</p>}
    {!inline && <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-3">
      <p>Sandbox: {mechanism.supported ? mechanism.id : <span className="text-port-warning">{mechanism.reason}</span>}</p>
      <p>Browser lane: {lanes.browser.mechanism}</p>
      <p>Blender lane: {lanes.blender.ready ? 'Ready for production rendering' : <span className="text-port-warning">Not ready</span>}</p>
    </div>}
    {!savedPath && execution.platform === 'darwin' && <div className="space-y-2 rounded border border-port-border p-3 text-sm">
      {finding || candidates === null ? <p role="status">Looking for installed Blender apps…</p> : findError
        ? <p>Could not search for Blender: {findError} Enter its path below.</p>
        : candidates?.length ? <><p>Installed Blender apps found:</p>
          <ul className="space-y-2">{candidates.map(candidate => <li key={candidate.executable} className="flex flex-wrap items-center gap-2">
            <button type="button" className={actionClass} disabled={busy} onClick={() => { setBlenderPath(candidate.executable); setSetupError(''); }}>Select Blender {candidate.version}</button>
            <code className="min-w-0 break-all text-xs text-gray-400">{candidate.executable}</code>
          </li>)}</ul></> : <p>No Blender app was found in the usual macOS locations. Enter its executable path below.</p>}
      <button type="button" className={buttonClass} disabled={finding || busy} onClick={() => setFindAgain(value => value + 1)}>Find installed Blender</button>
    </div>}
    <div className="min-w-0">
      <label htmlFor="cap-blender-path" className="mb-1 block text-sm">{inline ? 'Blender executable' : 'Blender executable (operator-owned)'}</label>
      <input id="cap-blender-path" disabled={busy} value={blenderPath} onChange={event => { setBlenderPath(event.target.value); setSetupError(''); }} placeholder="Enter the Blender executable path" aria-describedby="cap-blender-path-help" className="w-full min-w-0 rounded border border-port-border bg-port-bg px-3 py-2 text-sm" />
      <p id="cap-blender-path-help" className="mt-1 text-xs text-gray-400">{execution.platform === 'darwin' ? 'macOS example: /Applications/Blender.app/Contents/MacOS/Blender' : 'Enter the absolute path to the Blender executable on the computer running PortOS.'}</p>
    </div>
    {!savedPath && (execution.platform !== 'darwin' || candidates?.length === 0) && <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
      <span>If Blender is not installed, install it on the computer running PortOS, then {execution.platform === 'darwin' ? 'find it again or enter its executable path' : 'enter its executable path'}.</span>
      <a href="https://www.blender.org/download/" target="_blank" rel="noopener noreferrer" className={buttonClass}>Download Blender</a>
    </div>}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div><label htmlFor="cap-blender-mode" className="mb-1 block text-sm">Execution mode</label>
        <select id="cap-blender-mode" value={mode} disabled={busy} onChange={event => { setMode(event.target.value); setAcknowledged(false); }} className="w-full rounded border border-port-border bg-port-bg p-2 text-sm">
          <option value="contained">Contained (default)</option><option value="trusted-local">Trusted local (host access)</option>
        </select></div>
      <div><label htmlFor="cap-blender-engine" className="mb-1 block text-sm">Render engine</label>
        <select id="cap-blender-engine" value={engine} disabled={busy} onChange={event => setEngine(event.target.value)} className="w-full rounded border border-port-border bg-port-bg p-2 text-sm">
          <option value="CYCLES">Cycles CPU</option><option value="BLENDER_EEVEE_NEXT">EEVEE GPU</option>
        </select></div>
    </div>
    {mode === 'trusted-local' && <div className="space-y-2 rounded border border-port-warning p-3 text-sm">
      <p>{execution.trustedLocalWarning || 'Trusted-local Blender can access this account’s host filesystem, network and processes. Environment scrubbing and process supervision are not containment.'}</p>
      <label htmlFor="cap-blender-ack" className="flex items-start gap-2"><input id="cap-blender-ack" type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} />I understand the host access and trust the source I will run.</label>
    </div>}
    <p className="text-xs text-gray-400">Cycles CPU can take substantial time for a full sequence.</p>
    <details className="text-xs text-gray-400">
      <summary className="cursor-pointer">Execution notes</summary>
      <p className="mt-1">Trusted-local mode requires your explicit acknowledgement and runs only source you trust. No automatic fallback occurs.</p>
      <p className="mt-1">EEVEE needs a successful GPU check and disables motion blur to preserve stepped holds. Project version and engine must match the checked runtime.</p>
    </details>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={actionClass} disabled={!dirty || busy || (mode === 'trusted-local' && !acknowledged)} onClick={save}>{saving ? 'Saving…' : inline ? 'Save Blender' : 'Save tool'}</button>
      <button type="button" className={actionClass} disabled={!savedPath || dirty || busy || (mode === 'contained' && !mechanism.supported)} onClick={probe}>{probing ? 'Checking execution…' : inline ? 'Check Blender' : 'Run execution check'}</button>
    </div>
    {!savedPath && <p className="text-sm text-port-warning">{execution.tools.blender.problem ? `${execution.tools.blender.problem} ` : ''}Enter a Blender executable path and select {inline ? 'Save Blender' : 'Save tool'} before running the execution check.</p>}
    {setupError && <p role="alert" className="text-sm text-port-error">{setupError}</p>}
    {result && <div role="status" className="space-y-1 text-sm">
      <p>{result.refused || `${result.contained === false ? 'Supervision' : 'Containment'} checks ${result.passed ? 'passed' : 'failed'}: ${formatCount(result.checks.filter(check => check.passed).length)} of ${formatCount(result.checks.length)}`}</p>
      <p className={result.tools?.blender?.passed ? 'text-gray-400' : 'text-port-warning'}>Blender test render: {result.tools?.blender ? (result.tools.blender.passed ? 'Passed' : 'Failed') : 'Not run'}.{result.tools?.blender ? ` ${result.tools.blender.detail}` : ''}</p>
      <ul className="space-y-1">
        {result.checks.map(check => <li key={check.id} className={check.passed ? 'text-gray-400' : 'text-port-error'}>{check.passed ? 'Pass' : 'Fail'} · {check.detail}</li>)}
      </ul>
    </div>}
  </details>;
}
