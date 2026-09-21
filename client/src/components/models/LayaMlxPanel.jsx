import { useCallback, useRef, useState } from 'react';
import { getLayaStatus, installLaya, scoreLaya, updateInstanceFeature } from '../../services/api';
import { publishInstanceFeatures, useInstanceFeatures } from '../../hooks/useInstanceFeatures';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import { formatCount, formatPercent } from '../../utils/formatters';

const ERRORS = {
  'laya-unsupported': 'Laya-MLX requires Apple Silicon and macOS 14 or newer. Jev remains available on other platforms.',
  'laya-not-ready': 'Install or repair Laya-MLX before scoring.',
  'laya-disabled': 'Enable Laya-MLX experiments before scoring.',
  'laya-busy': 'A Laya operation is already running. Wait for it to finish.',
  'laya-context-too-long': 'The input exceeds this model’s token budget. Shorten the premise, question or options; no truncated decision was returned.',
  'laya-install-python-failed': 'Setup requires a native Apple Silicon Python 3.11+ and macOS 14+. Install a compatible Python, then retry.',
  'laya-install-runtime-failed': 'Runtime setup failed. Check Python compatibility and internet access, then retry.',
  'laya-install-model-failed': 'The pinned model download failed. Check free disk space and internet access, then retry.',
  'laya-install-verify-failed': 'The installed runtime could not load the model. Repair the installation and check macOS/MLX compatibility.',
};
const errorLabel = code => Object.hasOwn(ERRORS, code) ? ERRORS[code] : 'Laya could not complete this request. Refresh status or repair the installation, then retry.';

export default function LayaMlxPanel() {
  const { features, error: featureError } = useInstanceFeatures();
  const feature = features?.find(item => item.id === 'laya-mlx');
  const statusGeneration = useRef(0);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [premise, setPremise] = useState('');
  const [instructions, setInstructions] = useState('Which option best describes this text?');
  const [optionsText, setOptionsText] = useState('');
  const [margin, setMargin] = useState('0.15');
  const [result, setResult] = useState(null);
  const load = useCallback(() => {
    const requested = ++statusGeneration.current;
    return getLayaStatus({ silent: true }).then(value => {
      if (statusGeneration.current === requested) setStatus(value);
    });
  }, []);
  const { error: statusError, refetch } = useAutoRefetch(load, 5000, { enabled: !busy });
  const options = optionsText.split('\n').map(value => value.trim()).filter(Boolean);
  const valid = premise.trim() && instructions.trim() && options.length >= 2 && options.length <= 12
    && new Set(options).size === options.length && options.every(option => option.length <= 200)
    && margin !== '' && Number(margin) >= 0 && Number(margin) <= 1;
  const run = (action) => {
    setBusy(true);
    setError('');
    return action().catch(() => setError('The request failed. Check the connection and retry.')).finally(() => setBusy(false));
  };
  const toggle = () => run(() => updateInstanceFeature('laya-mlx', !feature.enabled, { silent: true })
    .then(value => publishInstanceFeatures(value.features, { groups: value.groups })));
  const install = () => run(() => installLaya({ silent: true }).then(value => {
    if (!value.ok) setError(errorLabel(value.code));
    else {
      statusGeneration.current += 1;
      setStatus(previous => ({ ...previous, installing: true, installError: null }));
    }
  }));
  const score = () => run(() => {
    setResult(null);
    return scoreLaya({ premise, instructions, options, minMargin: Number(margin) }, { silent: true }).then(value => {
      if (!value.ok) setError(errorLabel(value.code));
      else setResult(value);
    });
  });
  const edit = setter => event => { setter(event.target.value); setResult(null); };

  return (
    <section className="space-y-4 min-w-0" aria-label="Laya-MLX experiments">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">Laya-MLX multilingual <span className="text-xs text-port-warning">Experimental</span></h3>
          <p className="text-sm text-gray-400">322M parameters · native Apple Silicon · 1,024-token context including the question and options.</p>
          <p role="status" className="text-sm text-gray-300">Runtime: {statusError ? 'unavailable' : !status ? 'loading…' : !status.supported ? 'unsupported platform' : status.installing ? `installing (${status.stage || 'starting'})` : status.ready ? 'installed' : 'not installed'}.
            {' '}Experiments: {featureError || !feature ? 'unknown' : feature.enabled ? 'enabled' : 'disabled'}.</p>
        </div>
        <button type="button" onClick={toggle} disabled={busy || !feature || !!featureError || !status?.supported}
          className="px-3 py-2 rounded border border-port-border text-port-accent disabled:opacity-50">
          {feature?.enabled ? 'Disable experiments' : 'Enable experiments'}
        </button>
      </div>
      <p className="text-xs text-gray-400">Manual experiments only. Jev integrations, source policies, training and agreement counters remain independent. Disabling prevents new experiments; an in-flight request can finish. Models unload when each experiment finishes.</p>
      {(error || statusError || status?.installError) && <p role="alert" className="text-sm text-port-warning">{error || (statusError ? 'Could not refresh runtime status.' : errorLabel(status.installError))}</p>}
      {status && !status.supported && <p className="text-sm text-port-warning">{ERRORS['laya-unsupported']}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={install} disabled={busy || !status?.supported || status.installing || status.scoring || !!statusError}
          className="px-3 py-2 rounded border border-port-border text-port-accent disabled:opacity-50">
          {status?.installing ? 'Installing…' : status?.ready ? 'Repair Laya-MLX' : 'Install Laya-MLX'}
        </button>
        <button type="button" onClick={refetch} className="text-sm text-port-accent underline">Refresh status</button>
        <a href="https://github.com/mizorewww/laya-mlx" target="_blank" rel="noreferrer" className="text-sm text-port-accent underline">Project and benchmarks</a>
      </div>
      <p className="text-xs text-gray-400">Install downloads a pinned runtime and roughly 650 MB of model weights into a dedicated environment, then verifies model loading. Allow additional disk space for dependencies. Requires native Python 3.11+ and macOS 14+. Nothing downloads when this page opens.</p>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="space-y-3 min-w-0">
          <div><label htmlFor="laya-question" className="block text-sm text-gray-300 mb-1">Question</label>
            <input id="laya-question" value={instructions} maxLength={1000} onChange={edit(setInstructions)} disabled={busy} className="w-full bg-port-bg border border-port-border rounded p-2" /></div>
          <div><label htmlFor="laya-premise" className="block text-sm text-gray-300 mb-1">Premise</label>
            <textarea id="laya-premise" value={premise} maxLength={12000} rows={5} onChange={edit(setPremise)} disabled={busy} className="w-full bg-port-bg border border-port-border rounded p-2" /></div>
          <div><label htmlFor="laya-options" className="block text-sm text-gray-300 mb-1">Options (2–12 unique answers, one per line)</label>
            <textarea id="laya-options" value={optionsText} rows={4} onChange={edit(setOptionsText)} disabled={busy} className="w-full bg-port-bg border border-port-border rounded p-2" /></div>
          <div><label htmlFor="laya-margin" className="block text-sm text-gray-300 mb-1">Minimum margin (0–1)</label>
            <input id="laya-margin" type="number" min="0" max="1" step="0.01" value={margin} onChange={edit(setMargin)} disabled={busy} className="w-28 bg-port-bg border border-port-border rounded p-2" /></div>
          <button type="button" onClick={score} disabled={busy || !valid || !status?.ready || status.installing || status.scoring || !!statusError || !!featureError || !feature?.enabled}
            className="px-3 py-2 rounded bg-port-accent/20 text-port-accent disabled:opacity-50">{busy ? 'Working…' : 'Run experiment'}</button>
        </div>
        <div className="space-y-3 min-w-0 rounded border border-port-border p-4" role="status">
          <h4 className="font-medium text-white">Experiment result</h4>
          {!result ? <p className="text-sm text-gray-400">Enter a short premise and options, then run an experiment. Inputs and results are not saved.</p> : <>
            <p className="text-sm break-words">{result.abstained ? 'Abstained — options are too close to separate.' : `Choice: ${result.choice}`}</p>
            <p className="text-xs text-gray-400">Margin: {result.margin.toFixed(4)} · entropy confidence: {formatPercent(result.entropyConfidence * 100)}</p>
            <p className="text-xs text-gray-400">Total time: {formatCount(result.elapsedMs)} ms, including Python startup and model loading.</p>
            <ul className="space-y-2 text-sm">{result.scores.map(row => <li key={row.option} className="flex justify-between gap-4"><span className="break-words min-w-0">{row.option}</span><span>{formatPercent(row.probability * 100)}</span></li>)}</ul>
          </>}
          <p className="text-xs text-gray-500">Choice probabilities and entropy confidence are not Jev entailment scores. The margin is an experimental abstention threshold, not a calibrated accuracy guarantee. These timings are not comparable to upstream’s warm inference benchmarks.</p>
        </div>
      </div>
    </section>
  );
}
