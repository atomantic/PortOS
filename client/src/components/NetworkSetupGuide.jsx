import { useState } from 'react';
import {
  ArrowUpRight,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleHelp,
  Copy,
  Lock,
  RefreshCw,
} from 'lucide-react';
import toast from './ui/Toast';
import { PORTS } from '../lib/ports.js';
import {
  handleSelfRestart,
  PORTOS_APP_ID,
  provisionTailnetCert,
  restartApp,
} from '../services/api';
import { copyToClipboard } from '../lib/clipboard.js';

const STATUS = {
  complete: { icon: CheckCircle2, color: 'text-port-success', label: 'Complete' },
  action: { icon: CircleAlert, color: 'text-port-warning', label: 'Action needed' },
  blocked: { icon: Circle, color: 'text-gray-600', label: 'Waiting' },
  unknown: { icon: CircleHelp, color: 'text-port-warning', label: 'Check manually' },
};

function ExternalAction({ action }) {
  return (
    <a
      href={action.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-port-accent/40 px-3 py-2 text-xs font-medium text-port-accent hover:bg-port-accent/10 sm:min-h-0"
    >
      {action.label}
      <ArrowUpRight size={12} />
    </a>
  );
}

export default function NetworkSetupGuide({ networkExposure, compact = false }) {
  const [provisioning, setProvisioning] = useState(false);
  const [provisionResult, setProvisionResult] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const setup = networkExposure?.setup;

  if (!setup || !Array.isArray(setup.steps)) return null;

  const port = networkExposure?.bind?.port || PORTS.API;
  const visibleSteps = compact
    ? [setup.nextStep || setup.steps.at(-1)].filter(Boolean)
    : setup.steps;

  const provision = async () => {
    setProvisioning(true);
    setProvisionResult(null);
    const result = await provisionTailnetCert().catch(() => null);
    setProvisioning(false);
    if (!result?.ok) return;
    setProvisionResult(result);
    toast.success(result.message);
  };

  const restartPortos = async (targetUrl) => {
    setRestarting(true);
    const result = await restartApp(PORTOS_APP_ID, { silent: true }).catch((error) => {
      toast.error(error.message || 'Could not restart PortOS');
      return null;
    });
    if (!result?.selfRestart) {
      if (result) toast.error('PortOS did not accept the restart request');
      setRestarting(false);
      return;
    }
    handleSelfRestart({ targetOrigin: targetUrl });
  };

  const provisionedTarget = provisionResult?.hostname
    ? `https://${provisionResult.hostname}:${port}`
    : setup.pendingTrustedUrl;

  const renderAction = (step) => {
    const action = step.action;
    if (!action) return null;
    if (action.type === 'external') return <ExternalAction action={action} />;
    if (action.type === 'command') {
      return (
        <button
          type="button"
          onClick={() => copyToClipboard(action.command, 'Command copied')}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-2 font-mono text-xs text-gray-300 hover:border-port-accent/60 hover:text-white sm:min-h-0"
        >
          <Copy size={12} />
          {action.command}
        </button>
      );
    }
    if (action.type === 'provision-cert') {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <ExternalAction action={{
            type: 'external',
            label: 'Enable certificates in Tailscale',
            url: action.adminUrl,
          }} />
          <button
            type="button"
            onClick={provision}
            disabled={provisioning}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-port-accent px-3 py-2 text-xs font-medium text-white hover:bg-port-accent/80 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
          >
            <Lock size={12} />
            {provisioning ? 'Provisioning…' : action.label}
          </button>
        </div>
      );
    }
    if (action.type === 'restart') {
      return (
        <button
          type="button"
          onClick={() => restartPortos(action.targetUrl)}
          disabled={restarting || !action.targetUrl}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-port-accent px-3 py-2 text-xs font-medium text-white hover:bg-port-accent/80 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
        >
          <RefreshCw size={12} className={restarting ? 'animate-spin' : ''} />
          {restarting ? 'Restarting…' : action.label}
        </button>
      );
    }
    return null;
  };

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {visibleSteps.map((step, index) => {
        const style = STATUS[step.status] || STATUS.unknown;
        const Icon = style.icon;
        return (
          <div
            key={step.id}
            className={`rounded-lg border p-3 ${step.status === 'complete' ? 'border-port-success/20 bg-port-success/5' : 'border-port-border bg-port-bg/40'}`}
          >
            <div className="flex items-start gap-3">
              <Icon size={17} className={`${style.color} mt-0.5 shrink-0`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {!compact && <span className="text-xs text-gray-600">{index + 1}</span>}
                  <span className="text-sm font-medium text-white">{step.title}</span>
                  <span className={`text-[11px] ${style.color}`}>{style.label}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-gray-400">{step.detail}</p>
                {step.action && <div className="mt-2">{renderAction(step)}</div>}
              </div>
            </div>
          </div>
        );
      })}

      {provisionResult?.ok && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-port-success/30 bg-port-success/10 px-3 py-2 text-xs text-port-success">
          <CheckCircle2 size={14} />
          <span>
            {provisionResult.requiresRestart
              ? 'Certificate installed — restart PortOS to activate trusted HTTPS.'
              : 'Certificate installed and active.'}
          </span>
          {provisionResult.requiresRestart && provisionedTarget ? (
            <button
              type="button"
              onClick={() => restartPortos(provisionedTarget)}
              disabled={restarting}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-port-success/50 px-3 py-2 font-medium hover:bg-port-success/10 disabled:opacity-40 sm:min-h-0"
            >
              <RefreshCw size={12} className={restarting ? 'animate-spin' : ''} />
              {restarting ? 'Restarting…' : 'Restart PortOS'}
            </button>
          ) : provisionedTarget ? (
            <a href={provisionedTarget} className="font-medium underline">Open trusted URL</a>
          ) : null}
        </div>
      )}
    </div>
  );
}
