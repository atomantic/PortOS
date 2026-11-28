import { Link } from 'react-router';
import { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import PromptGuardHfAccessNotice from '../imageGen/PromptGuardHfAccessNotice.jsx';
import { useHfTokenStatus } from '../../hooks/useHfTokenStatus';
import {
  cancelModelAbuseGuardInstall,
  getModelAbuseGuardStatus,
  installModelAbuseGuard,
  scanModelAbuseContent,
} from '../../services/apiLocalLlm.js';
import InstallStageList from './InstallStageList';
import useModelInstall from './useModelInstall';
import UntrustedContentPolicyPanel from './UntrustedContentPolicyPanel.jsx';
import { formatCount } from '../../utils/formatters';

const INSTALLING_MESSAGE = 'Installing the dedicated guard…';
const MANUAL_SCAN_MAX_CHARS = 2_000_000;

const FALLBACK_STAGES = [
  { id: 'huggingface-token', label: 'Hugging Face access token', description: 'A read token plus gated-model approval on the Prompt Guard model card.' },
  { id: 'python', label: 'Host Python', description: 'Python 3.10 or newer, with a supported PyTorch wheel for this machine.' },
  { id: 'venv', label: 'Dedicated Prompt Guard runtime', description: 'A private virtualenv that never shares packages with image or video generation.' },
  { id: 'packages', label: 'Classifier packages', description: 'Pinned torch, transformers, safetensors, and huggingface_hub imports.' },
  { id: 'model', label: 'Pinned model snapshot', description: 'The five required Prompt Guard files from the pinned revision.' },
];

function stagesFromStatus(status) {
  return Array.isArray(status?.stages) && status.stages.length ? status.stages : FALLBACK_STAGES.map((stage) => {
    if (stage.id === 'packages') return { ...stage, ready: status?.runtimeReady === true };
    if (stage.id === 'model') return { ...stage, ready: status?.modelCached === true };
    if (stage.id === 'venv') return { ...stage, ready: status?.venvReady === true };
    if (stage.id === 'python') return { ...stage, ready: status?.pythonAvailable === true };
    return { ...stage, ready: false };
  });
}

export default function ModelAbuseGuardPanel() {
  const [guardStatus, setGuardStatus] = useState(null);
  const [scanText, setScanText] = useState('');
  const [scanResult, setScanResult] = useState(null);
  const [scanError, setScanError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const { present: tokenPresent, source: tokenSource, refresh: refreshToken } = useHfTokenStatus();

  const loadGuardStatus = useCallback(() => (
    getModelAbuseGuardStatus({ silent: true })
      .then((res) => {
        if (res) { setGuardStatus(res); setStatusError(false); }
        return res;
      })
      .catch(() => { setStatusError(true); return null; })
  ), []);

  useEffect(() => { loadGuardStatus(); }, [loadGuardStatus]);

  const { installing, installingStage, progressMsg, installError, install, cancel } = useModelInstall({
    scope: 'security-guard',
    installRequest: installModelAbuseGuard,
    cancelRequest: cancelModelAbuseGuardInstall,
    reloadStatus: loadGuardStatus,
    installingMessage: INSTALLING_MESSAGE,
    successMessage: 'Model-abuse guard installed and ready',
    cancelFailureMessage: 'Could not cancel the model-abuse guard installation',
  });

  const scanContent = async (event) => {
    event.preventDefault();
    if (scanning || !scanText.trim() || scanText.length > MANUAL_SCAN_MAX_CHARS) return;
    setScanning(true);
    setScanResult(null);
    setScanError('');
    try {
      setScanResult(await scanModelAbuseContent(scanText, { silent: true }));
    } catch (error) {
      setScanError(error.message || 'Scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const stages = stagesFromStatus(guardStatus).map((stage) => {
    if (stage.id !== 'huggingface-token' || tokenPresent === null) return stage;
    return { ...stage, ready: tokenPresent === true };
  });
  const overallReady = guardStatus?.ready === true;
  const contributionBlocked = guardStatus?.contributionAssessment?.ready === false;
  const incomplete = guardStatus?.setupState === 'incomplete' || (!overallReady && (guardStatus?.modelCached || guardStatus?.venvReady));

  return (
    <section
      id="llm-management-panel-abuse"
      role="tabpanel"
      aria-labelledby="model-abuse-guard-heading"
      data-testid="model-abuse-guard-card"
      className="max-w-6xl bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2">
          <ShieldCheck size={18} className="text-port-accent mt-0.5" aria-hidden="true" />
          <div>
            <h2 id="model-abuse-guard-heading" className="text-lg font-semibold text-white">Model-abuse guard</h2>
            <p className="text-xs text-port-accent mt-0.5">Required by default · local classifier</p>
          </div>
        </div>
        {contributionBlocked && overallReady ? (
          <span className="text-xs px-2 py-1 rounded border border-port-warning/40 text-port-warning">Not ready</span>
        ) : overallReady ? (
          <span className="text-xs px-2 py-1 rounded border border-port-success/40 text-port-success">Ready</span>
        ) : guardStatus ? (
          <span className="text-xs px-2 py-1 rounded border border-port-warning/40 text-port-warning">{incomplete ? 'Setup incomplete' : 'Not installed'}</span>
        ) : statusError ? (
          <span role="status" className="text-xs text-port-warning">Status unavailable</span>
        ) : (
          <span className="text-xs text-gray-500">Checking status…</span>
        )}
      </div>
      <p className="text-sm text-gray-300 max-w-2xl leading-relaxed">
        Screens external issues, pull requests, and messages before analysis. Runs locally on CPU; no GPU required.
        Required screening blocks analysis when it fails or cannot finish.
      </p>
      {guardStatus?.contributionAssessment?.ready === false && (
        <p role="status" className="text-xs text-port-warning max-w-2xl">
          GitHub pull request and issue assessment is not ready ({guardStatus.contributionAssessment.code}), so the pending-merge coordinator cannot merge.{guardStatus.contributionAssessment.code === 'untrusted-content-model-required' ? ' Pick a provider and model in Content safety policies below.' : ''}
        </p>
      )}
      <details className="text-sm rounded-lg border border-port-border p-3">
        <summary className="cursor-pointer text-port-accent">How screening works and its limits</summary>
        <div className="mt-3 space-y-2 text-xs leading-relaxed text-gray-400 max-w-2xl">
          <p>Deterministic checks and a local classifier screen content before isolated, tool-free analysis and server-validated actions. A passing scan does not grant trust, prove attachments safe, or authorize private-record access. Classifiers can miss attacks and flag legitimate security examples.</p>
          <p>This installer uses the pinned Llama Prompt Guard 2 86M model for multilingual detection, scanning overlapping 512-token windows. Screening needs no chat model or cloud account. Status refreshes make no model calls.</p>
          <p>Private message analysis also needs a local API provider. Install a text model in <Link className="text-port-accent hover:underline" to="/models/llms">LLMs</Link>, then choose its provider below.</p>
        </div>
      </details>
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">Installation</h3>
          <span className="text-xs text-gray-400">{stages.filter(stage => stage.ready).length} of {stages.length} checks ready</span>
        </div>
        <details open={!overallReady || tokenPresent !== true} className="text-sm">
          <summary className="cursor-pointer text-port-accent mb-2">Hugging Face access &amp; token</summary>
          <PromptGuardHfAccessNotice
            tokenPresent={tokenPresent}
            tokenSource={tokenSource}
            model={guardStatus}
            onSaved={() => { refreshToken(); loadGuardStatus(); }}
          />
        </details>
        <InstallStageList
          stages={stages}
          installing={installing}
          installingStage={installingStage}
          progressMsg={progressMsg}
          testIdPrefix="abuse-guard-stage"
          gridClass="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
          ariaLabel="Abuse guard setup stages"
        />
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-gray-500">
          <span>{guardStatus?.name || 'Llama Prompt Guard 2 86M'}</span>
          <span>·</span>
          <span>86M · offline · no tools</span>
          <a
            href={guardStatus?.sourceUrl || 'https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-port-accent hover:underline inline-flex items-center gap-1"
          >
            Model card <ExternalLink size={11} />
          </a>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={loadGuardStatus} disabled={installing} className="px-2.5 py-1 text-xs border border-port-border text-gray-300 rounded flex items-center gap-1 disabled:opacity-50">
            <RefreshCw size={12} /> Refresh status
          </button>
          {overallReady ? (
            <span className="text-xs text-port-success">Installed from the pinned model revision.</span>
          ) : installing ? (
            <>
              <span className="flex items-center gap-1.5 text-xs text-gray-300"><BrailleSpinner /> {INSTALLING_MESSAGE}</span>
              <button
                type="button"
                onClick={cancel}
                className="px-2.5 py-1 text-xs bg-port-border hover:bg-port-border/70 text-gray-300 rounded"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={install}
              disabled={!guardStatus || tokenPresent !== true || guardStatus.pythonAvailable !== true}
              className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              <Download size={12} /> {incomplete ? 'Repair model-abuse guard' : 'Install model-abuse guard'}
            </button>
          )}
          {installing && progressMsg && !installingStage && (
            <span className="text-[11px] text-gray-500">{progressMsg}</span>
          )}
        </div>
        {(installError || guardStatus?.lastInstallFailure) && (
          <div role="alert" className="text-xs text-port-warning space-y-1 break-words">
            {installError && <p>{installError}</p>}
            {guardStatus?.lastInstallFailure && <p>{guardStatus.lastInstallFailure.stage}: {guardStatus.lastInstallFailure.code}{Number.isInteger(guardStatus.lastInstallFailure.exitCode) ? ` (exit ${guardStatus.lastInstallFailure.exitCode})` : ''}. {guardStatus.lastInstallFailure.message} {guardStatus.lastInstallFailure.action}</p>}
          </div>
        )}
        {guardStatus?.runtimeIssue && <p className="text-xs text-port-warning">{guardStatus.runtimeIssue.message} {guardStatus.runtimeIssue.action}</p>}
        {guardStatus?.expectedPackages && <details className="text-xs text-gray-400 break-words"><summary>Expected classifier packages</summary><p>{guardStatus.expectedPackages.join(', ')}</p></details>}
        {incomplete && <p role="status" className="text-xs text-port-warning">A partial or failed installation blocks screening, including sources with an optional classifier. Repair the setup before retrying those tasks.</p>}
        <p className="text-xs text-gray-400">Install downloads Python packages and model weights. Accept the model terms and add a read token first.</p>
      </div>
      <form onSubmit={scanContent} className="space-y-2 border border-port-border rounded-lg p-3">
        <h3 className="text-sm font-semibold text-white">Check content</h3>
        <p className="text-xs text-gray-400">Paste any text to run the local abuse scan on demand. A pass does not establish trust; this does not run the separate GitHub contribution assessment.</p>
        <label htmlFor="abuse-guard-content" className="block text-xs text-gray-300">Text to check</label>
        <textarea id="abuse-guard-content" value={scanText} disabled={scanning}
          onChange={(event) => { setScanText(event.target.value); setScanResult(null); setScanError(''); }}
          rows={5} className="w-full rounded border border-port-border bg-port-bg p-2 text-sm text-white" />
        <p className="text-xs text-gray-400">{formatCount(scanText.length)} / {formatCount(MANUAL_SCAN_MAX_CHARS)} characters{scanText.length > MANUAL_SCAN_MAX_CHARS ? ' — shorten the text before checking.' : ''}</p>
        <button type="submit" disabled={scanning || !scanText.trim() || scanText.length > MANUAL_SCAN_MAX_CHARS} className="px-3 py-2 text-xs border border-port-border rounded text-port-accent disabled:opacity-50">
          {scanning ? 'Checking…' : 'Check content'}
        </button>
        {scanError && <p role="alert" className="text-xs text-port-warning">{scanError}</p>}
        {scanResult && <div role="status" className="text-xs space-y-1">
          <p className={scanResult.safe ? 'text-port-success' : 'text-port-warning'}>{scanResult.safe ? 'No abuse detected' : 'Content flagged by the abuse guard'}</p>
          {(scanResult.findings || []).map((finding, index) => <p key={`${finding.category}-${index}`} className="text-gray-300">{finding.reason}</p>)}
        </div>}
      </form>
      <UntrustedContentPolicyPanel />
    </section>
  );
}
