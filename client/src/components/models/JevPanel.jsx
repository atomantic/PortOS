import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Download, ExternalLink, RefreshCw, Scale } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { formatBytes } from '../../utils/formatters';
import {
  cancelJevInstall,
  getJevStatus,
  installJev,
  scoreJev,
  unloadJev,
} from '../../services/api';
import socket from '../../services/socket';

// Shown before the first status response lands, and if status is unavailable,
// so the checklist never renders as an empty box. Mirrors JEV_STAGES in
// server/lib/jev.js — four stages, no Hugging Face token: openjev is ungated.
const FALLBACK_STAGES = [
  { id: 'python', label: 'Host Python', description: 'Python 3.10 or newer, with a supported PyTorch wheel for this machine.' },
  { id: 'venv', label: 'Dedicated jev runtime', description: 'A private virtualenv that never shares packages with Prompt Guard, image, or video generation.' },
  { id: 'packages', label: 'Scorer packages', description: 'Pinned torch, transformers, safetensors, and huggingface_hub imports.' },
  { id: 'model', label: 'Pinned model snapshot', description: 'The four required files from the pinned 4B NLI subfolder.' },
];

const stagesFromStatus = (status) => (
  Array.isArray(status?.stages) && status.stages.length ? status.stages : FALLBACK_STAGES
);

const parseHypotheses = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

export default function JevPanel() {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [installError, setInstallError] = useState('');
  const [installingStage, setInstallingStage] = useState(null);
  const [premise, setPremise] = useState('');
  const [hypothesesText, setHypothesesText] = useState('');
  const [scoring, setScoring] = useState(false);
  const [decision, setDecision] = useState(null);
  const progressTimer = useRef(null);

  const loadStatus = useCallback(() => (
    getJevStatus({ silent: true })
      .then((res) => {
        if (res) { setStatus(res); setStatusError(false); }
        return res;
      })
      .catch(() => { setStatusError(true); return null; })
  ), []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    const handleProgress = (data) => {
      if (data?.scope !== 'jev') return;
      clearTimeout(progressTimer.current);
      if (data?.stage) setInstallingStage(data.stage);
      setProgressMsg(data?.message || '');
      if (data?.event === 'complete') {
        setInstalling(false);
        setInstallingStage(null);
        progressTimer.current = setTimeout(() => setProgressMsg(''), 3000);
        loadStatus();
      }
      if (data?.event === 'error') {
        setInstalling(false);
        setInstallError(data.message || 'Installation failed. Refresh status for diagnostics.');
        loadStatus();
      }
    };
    socket.on('localLlm:progress', handleProgress);
    return () => {
      socket.off('localLlm:progress', handleProgress);
      clearTimeout(progressTimer.current);
    };
  }, [loadStatus]);

  const install = () => {
    setInstallError('');
    setInstallingStage(null);
    setInstalling(true);
    setProgressMsg('Installing the jev scorer…');
    return installJev({ silent: true })
      .then((result) => {
        if (result?.ready === true) toast.success('jev scorer installed and ready');
        return loadStatus();
      })
      .catch((error) => { setInstallError(error.message || 'Installation failed.'); return loadStatus(); })
      .finally(() => {
        setInstalling(false);
        setInstallingStage(null);
      });
  };

  const cancel = () => cancelJevInstall({ silent: true }).then(loadStatus).catch(() => null);

  const unload = () => unloadJev({ silent: true }).then(loadStatus).catch(() => null);

  const hypotheses = parseHypotheses(hypothesesText);
  const canScore = status?.ready === true && premise.trim().length > 0 && hypotheses.length >= 2;

  const runScore = () => {
    setScoring(true);
    setDecision(null);
    return scoreJev({ premise: premise.trim(), hypotheses }, { silent: true })
      .then((result) => setDecision(result))
      // A failing score is shown in the result box beside the button rather
      // than as a toast: the operator is iterating on this input right here.
      .catch((error) => setDecision({ ok: false, code: error.message || 'jev-request-invalid' }))
      .finally(() => { setScoring(false); loadStatus(); });
  };

  const stages = stagesFromStatus(status);
  const currentStageId = installingStage || (installing ? stages.find((stage) => !stage.ready)?.id : null);
  const ready = status?.ready === true;
  const incomplete = status?.setupState === 'incomplete';

  return (
    <section
      id="llm-management-panel-jev"
      role="tabpanel"
      aria-labelledby="tab-jev"
      data-testid="jev-card"
      className="max-w-6xl bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2">
          <Scale size={18} className="text-port-accent mt-0.5" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold text-white">jev decision scorer</h2>
            <p className="text-xs text-port-accent mt-0.5">Optional · local entailment model · no provider quota</p>
          </div>
        </div>
        {ready ? (
          <span className="text-xs px-2 py-1 rounded border border-port-success/40 text-port-success">Ready</span>
        ) : status ? (
          <span className="text-xs px-2 py-1 rounded border border-port-warning/40 text-port-warning">{incomplete ? 'Setup incomplete' : 'Not installed'}</span>
        ) : statusError ? (
          <span role="status" className="text-xs text-port-warning">Status unavailable</span>
        ) : (
          <span className="text-xs text-gray-500">Checking status…</span>
        )}
      </div>

      <p className="text-sm text-gray-300 max-w-2xl leading-relaxed">
        Answers closed-set questions — &ldquo;which of these options does this text entail?&rdquo; — without generating text
        or spending provider quota. When the top two options are too close to separate, it <strong>abstains</strong> rather
        than guessing.
      </p>

      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">Installation</h3>
          <span className="text-xs text-gray-400">{stages.filter((stage) => stage.ready).length} of {stages.length} checks ready</span>
        </div>
        <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 list-none p-0" aria-label="jev setup stages">
          {stages.map((stage) => {
            const current = installing && currentStageId === stage.id;
            const waiting = installing && !stage.ready && currentStageId && currentStageId !== stage.id;
            return (
              <li
                key={stage.id}
                data-testid={`jev-stage-${stage.id}`}
                data-ready={stage.ready ? 'true' : 'false'}
                className="flex items-start gap-2 rounded-lg border border-port-border/70 bg-port-bg/40 px-3 py-2"
              >
                <span className="mt-0.5 shrink-0" aria-hidden="true">
                  {stage.ready ? (
                    <CheckCircle2 size={14} className="text-port-success" />
                  ) : current ? (
                    <BrailleSpinner />
                  ) : (
                    <Circle size={14} className={waiting ? 'text-gray-600' : 'text-port-warning'} />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-xs font-medium text-white">{stage.label}</p>
                    <span className={`text-[11px] ${stage.ready ? 'text-port-success' : current ? 'text-gray-300' : 'text-gray-500'}`}>
                      {stage.ready ? 'Ready' : current ? 'Installing…' : waiting ? 'Waiting' : 'Not ready'}
                    </span>
                  </div>
                  <details className="mt-1 text-xs text-gray-400">
                    <summary className="cursor-pointer hover:text-port-accent">Details</summary>
                    <p className="mt-1 leading-relaxed">{stage.description}</p>
                  </details>
                  {stage.id === 'python' && !stage.ready && (
                    <a href="https://www.python.org/downloads/" target="_blank" rel="noopener noreferrer" className="text-xs text-port-accent hover:underline">Install Python, then refresh status</a>
                  )}
                  {current && progressMsg && <p className="text-[11px] text-gray-400 mt-1">{progressMsg}</p>}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="flex items-center gap-2 flex-wrap text-[11px] text-gray-500">
          <span>{status?.name || 'OpenJEV Qwen3.5 4B NLI'}</span>
          <span>·</span>
          <span>{status?.weightsBytes ? formatBytes(status.weightsBytes) : '~9 GB'} · offline · no tools</span>
          <a
            href={status?.sourceUrl || 'https://huggingface.co/AlexWortega/openjev'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-port-accent hover:underline inline-flex items-center gap-1"
          >
            Model card <ExternalLink size={11} />
          </a>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={loadStatus} disabled={installing} className="px-2.5 py-1 text-xs border border-port-border text-gray-300 rounded flex items-center gap-1 disabled:opacity-50">
            <RefreshCw size={12} /> Refresh status
          </button>
          {ready ? (
            <span className="text-xs text-port-success">Installed from the pinned model revision.</span>
          ) : installing ? (
            <>
              <span className="flex items-center gap-1.5 text-xs text-gray-300"><BrailleSpinner /> Installing the jev scorer…</span>
              <button type="button" onClick={cancel} className="px-2.5 py-1 text-xs bg-port-border hover:bg-port-border/70 text-gray-300 rounded">Cancel</button>
            </>
          ) : (
            <button
              type="button"
              onClick={install}
              disabled={!status || status.pythonAvailable !== true}
              className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              <Download size={12} /> {incomplete ? 'Repair jev' : 'Install jev'}
            </button>
          )}
          {status?.resident && (
            <>
              <span className="text-xs text-gray-400">Model resident on port {status.port}</span>
              <button type="button" onClick={unload} className="px-2.5 py-1 text-xs border border-port-border text-gray-300 rounded">Unload now</button>
            </>
          )}
          {installing && progressMsg && !installingStage && <span className="text-[11px] text-gray-500">{progressMsg}</span>}
        </div>

        {(installError || status?.lastInstallFailure) && (
          <div role="alert" className="text-xs text-port-warning space-y-1 break-words">
            {installError && <p>{installError}</p>}
            {status?.lastInstallFailure && <p>{status.lastInstallFailure.stage}: {status.lastInstallFailure.code}. {status.lastInstallFailure.message} {status.lastInstallFailure.action}</p>}
          </div>
        )}
        {status?.runtimeIssue && <p className="text-xs text-port-warning">{status.runtimeIssue.message} {status.runtimeIssue.action}</p>}
        <p className="text-xs text-gray-400">
          Install downloads Python packages and the pinned 4B weights only — the repository&rsquo;s larger variants are never fetched.
          The scorer loads on the first question and unloads itself after ten idle minutes.
        </p>
      </div>

      <div className="space-y-3 border-t border-port-border pt-4">
        <h3 className="text-sm font-semibold text-white">Try a decision</h3>
        <p className="text-xs text-gray-400 max-w-2xl">
          Paste the text to reason over, then one option per line. At least two options: the confidence margin is the gap
          between the best two, so a single option has nothing to be measured against.
        </p>
        <div>
          <label htmlFor="jev-premise" className="block text-xs text-gray-400 mb-1">Premise</label>
          <textarea
            id="jev-premise"
            value={premise}
            onChange={(event) => setPremise(event.target.value)}
            rows={4}
            className="w-full text-sm bg-port-bg border border-port-border rounded p-2 text-gray-200"
            placeholder="The text to reason over."
          />
        </div>
        <div>
          <label htmlFor="jev-hypotheses" className="block text-xs text-gray-400 mb-1">Options (one per line)</label>
          <textarea
            id="jev-hypotheses"
            value={hypothesesText}
            onChange={(event) => setHypothesesText(event.target.value)}
            rows={4}
            className="w-full text-sm bg-port-bg border border-port-border rounded p-2 text-gray-200"
            placeholder={'This warrants a reply.\nThis warrants no reply.'}
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={runScore}
            disabled={!canScore || scoring}
            className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {scoring ? 'Scoring…' : 'Score'}
          </button>
          {!ready && <span className="text-xs text-gray-500">Install jev first.</span>}
          {ready && hypotheses.length < 2 && <span className="text-xs text-gray-500">Add at least two options.</span>}
          {scoring && <span className="flex items-center gap-1.5 text-xs text-gray-300"><BrailleSpinner /> The first question loads the model, which can take a minute.</span>}
        </div>
        {decision && (
          <div role="status" data-testid="jev-decision" className="text-sm rounded-lg border border-port-border p-3 space-y-1">
            {decision.ok === false ? (
              <p className="text-port-warning">Scoring failed: {decision.code}</p>
            ) : decision.abstained ? (
              <>
                <p className="text-port-warning">Abstained — the top two options were too close to separate.</p>
                <p className="text-xs text-gray-400">Margin {decision.margin?.toFixed(3)}. A caller treats this as &ldquo;ask something else&rdquo;, never as &ldquo;take the top one anyway&rdquo;.</p>
              </>
            ) : (
              <>
                <p className="text-port-success break-words">Chose: {decision.choice}</p>
                <p className="text-xs text-gray-400">Entailment {decision.confidence?.toFixed(3)} · margin {decision.margin?.toFixed(3)}</p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
