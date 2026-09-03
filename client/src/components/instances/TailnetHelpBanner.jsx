import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Lock,
} from 'lucide-react';
import Pill from '../ui/Pill';
import NetworkSetupGuide from '../NetworkSetupGuide.jsx';
import { PORTS } from '../../lib/ports.js';
import { useLocalStorageBool } from '../../hooks/useLocalStorageBool';

export default function TailnetHelpBanner({ tailnetInfo, networkExposure }) {
  const [collapsed, setCollapsed] = useLocalStorageBool('portos-tailnet-help-collapsed', false);
  const setup = networkExposure?.setup;
  const complete = setup?.complete === true;

  const status = complete
    ? { label: 'Running on Tailscale HTTPS', tone: 'ok', detail: setup.summary }
    : tailnetInfo === null
      ? { label: 'Tailscale DNS not detected', tone: 'warn', detail: 'Install Tailscale and enable MagicDNS to get a stable private URL.' }
      : tailnetInfo?.suffix
        ? {
            label: `MagicDNS: ${tailnetInfo.suffix}`,
            tone: 'warn',
            detail: setup?.summary || (tailnetInfo.self ? `This instance: ${tailnetInfo.self}` : null),
          }
        : { label: 'MagicDNS needs attention', tone: 'warn', detail: setup?.summary || 'Enable MagicDNS in the Tailscale DNS admin.' };

  const ToneIcon = status.tone === 'ok' ? CheckCircle2 : AlertCircle;
  const toneClass = status.tone === 'ok' ? 'text-port-success' : 'text-port-warning';

  return (
    <div className="rounded-xl border border-port-border bg-port-card">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex min-h-[44px] w-full items-center gap-2 p-4 text-left"
        aria-expanded={!collapsed}
      >
        <Lock size={16} className={complete ? 'shrink-0 text-port-success' : 'shrink-0 text-port-accent'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-white">Tailnet DNS &amp; trusted HTTPS</span>
            <Pill tone="bare" size="xs" bordered={false} icon={ToneIcon} className={`${toneClass} bg-port-bg`}>
              {status.label}
            </Pill>
          </div>
        </div>
        {collapsed
          ? <ChevronRight size={14} className="text-gray-500" />
          : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {!collapsed && (
        <div className="space-y-3 px-4 pb-4">
          {status.detail && (
            <div className="flex items-start gap-1.5 text-xs text-gray-400">
              <Info size={12} className="mt-0.5 shrink-0 text-gray-500" />
              <span>{status.detail}</span>
            </div>
          )}

          <NetworkSetupGuide networkExposure={networkExposure} compact={complete} />

          <div className="rounded-lg border border-port-border bg-port-bg/40 p-3 text-xs leading-relaxed text-gray-400">
            <p className="font-medium text-gray-300">Peer DNS after this machine is secure</p>
            <p className="mt-1">
              Use the suggested MagicDNS host on each peer below to switch federation from
              <span className="font-mono text-gray-300"> http://{'<ip>'}:{PORTS.API} </span>
              to its browser-trusted
              <span className="font-mono text-gray-300"> https://{'<host>'}.{tailnetInfo?.suffix || '<tailnet>'}.ts.net:{PORTS.API}</span>
              {' '}address. “Use IP only” reverts that peer to its IP.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
