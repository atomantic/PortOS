import { Link } from 'react-router';
import { formatCount } from '../utils/formatters.js';
import { useMaintenance } from '../hooks/useMaintenance.js';
export default function MaintenanceBanner() {
  const { status } = useMaintenance({ mode: 'banner' });
  if (!status || (status.state === 'normal' && !status.agentDiskPressure)) return null;
  const diskWarning = status.agentDiskPressure === 'low'
    ? 'Low disk space. New agents are paused until the maintenance journal volume has at least 1 GiB free.'
    : 'Disk space could not be checked. New agents are paused.';
  const label = status.state === 'normal' ? null
    : status.state === 'ready' ? 'Maintenance ready — new work is held.'
    : status.state === 'draining' ? `Maintenance draining — ${formatCount(status.blockerCount)} recorded operation(s) awaiting completion verification.`
    : status.state === 'unavailable' ? 'Maintenance recovery needed — new work is held.'
    : 'Maintenance readiness unknown.';
  return (
    <div role="status" className="px-4 py-2 text-sm bg-port-card border-b border-port-border">
      {label && <div>{label} <Link className="underline" to="/settings/general">View maintenance</Link></div>}
      {status.agentDiskPressure && <div>{diskWarning}</div>}
    </div>
  );
}
