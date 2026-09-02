import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Download, ExternalLink, ShieldCheck } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import PromptGuardHfAccessNotice from '../imageGen/PromptGuardHfAccessNotice.jsx';
import { useHfTokenStatus } from '../../hooks/useHfTokenStatus';
import {
  cancelModelAbuseGuardInstall,
  getModelAbuseGuardStatus,
  installModelAbuseGuard,
} from '../../services/api';
import socket from '../../services/socket';

const FALLBACK_STAGES = [
  { id: 'huggingface-token', label: 'Hugging Face access token', description: 'A read token plus gated-model approval on the Prompt Guard model card.' },
  { id: 'python', label: 'Host Python', description: 'A Python interpreter PortOS can use as the base for the dedicated runtime.' },
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
  const [installing, setInstalling] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [installingStage, setInstallingStage] = useState(null);
  const progressTimer = useRef(null);
  const { present: tokenPresent, source: tokenSource, refresh: refreshToken } = useHfTokenStatus();

  const loadGuardStatus = useCallback(() => (
    getModelAbuseGuardStatus({ silent: true })
      .then((res) => {
        if (res) setGuardStatus(res);
        return res;
      })
      .catch(() => null)
  ), []);

  useEffect(() => { loadGuardStatus(); }, [loadGuardStatus]);

  useEffect(() => {
    const handleProgress = (data) => {
      if (data?.scope !== 'security-guard') return;
      clearTimeout(progressTimer.current);
      if (data?.stage) setInstallingStage(data.stage);
      setProgressMsg(data?.message || '');
      if (data?.event === 'complete') {
        setInstalling(false);
        setInstallingStage(null);
        progressTimer.current = setTimeout(() => setProgressMsg(''), 3000);
        loadGuardStatus();
      }
      if (data?.event === 'error') {
        setInstalling(false);
        progressTimer.current = setTimeout(() => setProgressMsg(''), 5000);
        loadGuardStatus();
      }
    };
    socket.on('localLlm:progress', handleProgress);
    return () => {
      socket.off('localLlm:progress', handleProgress);
      clearTimeout(progressTimer.current);
    };
  }, [loadGuardStatus]);

  const installGuard = () => {
    setInstalling(true);
    setProgressMsg('Installing the dedicated guard…');
    return installModelAbuseGuard()
      .then((result) => {
        if (result?.ready === true) toast.success('Model-abuse guard installed and ready');
        return loadGuardStatus();
      })
      .catch(() => loadGuardStatus())
      .finally(() => {
        setInstalling(false);
        setInstallingStage(null);
      });
  };

  const cancelGuard = () => cancelModelAbuseGuardInstall({ silent: true })
    .then(loadGuardStatus)
    .catch(() => null);

  const stages = stagesFromStatus(guardStatus).map((stage) => {
    if (stage.id !== 'huggingface-token' || tokenPresent === null) return stage;
    return { ...stage, ready: tokenPresent === true };
  });
  const currentStageId = installingStage || (installing ? stages.find((stage) => !stage.ready)?.id : null);
  const overallReady = guardStatus?.ready === true;

  return (
    <section
      id="llm-management-panel-abuse"
      role="tabpanel"
      aria-labelledby="tab-abuse"
      data-testid="model-abuse-guard-card"
      className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2">
          <ShieldCheck size={18} className="text-port-accent mt-0.5" aria-hidden="true" />
          <div>
            <h2 id="model-abuse-guard-heading" className="text-sm font-medium text-white">Model-abuse guard</h2>
            <p className="text-xs text-port-accent mt-0.5">Recommended safety layer · managed classifier</p>
          </div>
        </div>
        {overallReady ? (
          <span className="text-xs px-2 py-1 rounded border border-port-success/40 text-port-success">Ready</span>
        ) : guardStatus ? (
          <span className="text-xs px-2 py-1 rounded border border-port-warning/40 text-port-warning">Not installed</span>
        ) : (
          <span className="text-xs text-gray-500">Checking status…</span>
        )}
      </div>
      <p className="text-xs text-gray-300 max-w-3xl">
        Llama Prompt Guard 2 86M screens complete external issues, comments, and pull-request diffs before they reach a reasoning agent. It is a pinned local classifier with no chat, tools, MCP, or repository access; flagged or inconclusive content is withheld.
      </p>
      <PromptGuardHfAccessNotice
        tokenPresent={tokenPresent}
        tokenSource={tokenSource}
        model={guardStatus}
        onSaved={() => { refreshToken(); loadGuardStatus(); }}
      />
      <ol className="space-y-2 list-none p-0" aria-label="Abuse guard setup stages">
        {stages.map((stage) => {
          const current = installing && currentStageId === stage.id;
          const waiting = installing && !stage.ready && currentStageId && currentStageId !== stage.id;
          return (
            <li
              key={stage.id}
              data-testid={`abuse-guard-stage-${stage.id}`}
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
                <p className="text-[11px] text-gray-500 mt-0.5">{stage.description}</p>
                {current && progressMsg && (
                  <p className="text-[11px] text-gray-400 mt-1">{progressMsg}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
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
        {overallReady ? (
          <span className="text-xs text-port-success">Installed from the pinned model revision.</span>
        ) : installing ? (
          <>
            <span className="flex items-center gap-1.5 text-xs text-gray-300"><BrailleSpinner /> Installing the dedicated guard…</span>
            <button
              type="button"
              onClick={cancelGuard}
              className="px-2.5 py-1 text-xs bg-port-border hover:bg-port-border/70 text-gray-300 rounded"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={installGuard}
            disabled={!guardStatus || tokenPresent !== true}
            className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <Download size={12} /> Install model-abuse guard
          </button>
        )}
        {installing && progressMsg && !installingStage && (
          <span className="text-[11px] text-gray-500">{progressMsg}</span>
        )}
      </div>
    </section>
  );
}
