import { useId, useState } from 'react';
import Modal from '../ui/Modal';
import { getProviderVisionHealth, testProviderVision, runProviderVisionSuite } from '../../services/apiProviders';

const buttonClass = 'px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-port-text rounded disabled:opacity-50';

export default function ProviderVisionTest({ provider }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [imagePath, setImagePath] = useState('');
  const [model, setModel] = useState(provider.defaultModel || '');
  const [prompt, setPrompt] = useState('Describe what you see in this image.');

  const checkHealth = () => {
    setOpen(true);
    setResult(null);
    setHealth(null);
    setBusy(true);
    setError('');
    getProviderVisionHealth(provider.id, { silent: true })
      .then(setHealth).catch(err => setError(err.message)).finally(() => setBusy(false));
  };
  const run = (suite) => {
    setBusy(true);
    setError('');
    setResult(null);
    const body = model.trim() ? { model: model.trim() } : {};
    const request = suite
      ? runProviderVisionSuite(provider.id, body, { silent: true })
      : testProviderVision(provider.id, { ...body, imagePath: imagePath.trim(), prompt }, { silent: true });
    request.then(setResult).catch(err => setError(err.message)).finally(() => setBusy(false));
  };
  return <>
    <button className={buttonClass} disabled={!provider.enabled} onClick={checkHealth}>Test vision</button>
    {open && <Modal onClose={() => setOpen(false)} ariaLabel={`Test vision — ${provider.name}`} panelClassName="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-port-text">Test vision — {provider.name}</h2>
        <button className={buttonClass} onClick={() => setOpen(false)}>Close</button>
      </div>
      <p className="text-sm text-port-text-muted">Tests send screenshots stored on this server to this provider and may incur provider charges. The suite sends one stored screenshot twice.</p>
      <div role="status" className="text-sm text-port-text-muted">
        {busy ? 'Checking vision…' : health ? (health.available ? 'Endpoint reachable. Run a test to verify vision support.' : health.error || 'Vision unavailable') : 'Health check did not complete.'}
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-model`} className="block text-sm text-port-text">Model</label>
        <input id={`${id}-model`} className="w-full bg-port-bg border border-port-border rounded p-2 text-port-text" value={model} maxLength={256} onChange={e => setModel(e.target.value)} placeholder="Provider default model" />
        <label htmlFor={`${id}-image`} className="block text-sm text-port-text">Stored screenshot filename</label>
        <input id={`${id}-image`} className="w-full bg-port-bg border border-port-border rounded p-2 text-port-text" value={imagePath} maxLength={255} onChange={e => setImagePath(e.target.value)} placeholder="screenshot.png" />
        <label htmlFor={`${id}-prompt`} className="block text-sm text-port-text">Prompt</label>
        <textarea id={`${id}-prompt`} className="w-full bg-port-bg border border-port-border rounded p-2 text-port-text" value={prompt} maxLength={8000} onChange={e => setPrompt(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} disabled={busy || !health?.available || !imagePath.trim()} onClick={() => run(false)}>Run image test</button>
        <button className={buttonClass} disabled={busy || !health?.available} onClick={() => run(true)}>Run vision suite</button>
        <button className={buttonClass} disabled={busy} onClick={checkHealth}>Check endpoint</button>
      </div>
      {error && <p role="alert" className="text-port-error text-sm">{error}</p>}
      {result && <div role="status" className="space-y-2 text-sm break-words">
        <p className={result.success ? 'text-port-success' : 'text-port-error'}>{result.success ? 'Vision test passed' : 'Vision test failed'}{result.totalTests != null && ` — ${result.passedTests}/${result.totalTests} passed`}</p>
        {(result.results || [result]).map((item, index) => <div key={index} className="text-port-text whitespace-pre-wrap">
          {item.testName && <p className="font-semibold">{item.testName}</p>}
          {item.error && <p className="text-port-error">{item.error}</p>}
          {item.response && <p>{item.response}</p>}
        </div>)}
        {result.error && result.results && <p className="text-port-error">{result.error}</p>}
      </div>}
    </Modal>}
  </>;
}
