import { Link } from 'react-router';
import { formatCount } from '../utils/formatters.js';
import { useMaintenance } from '../hooks/useMaintenance.js';
export default function MaintenanceBanner() {
  const { status } = useMaintenance({ mode: 'banner' });
  if (!status || status.state === 'normal') return null;
  const label = status.state === 'ready' ? 'Maintenance ready — new work is held.'
    : status.state === 'draining' ? `Maintenance draining — ${formatCount(status.blockerCount)} operation(s) finishing.`
    : 'Maintenance readiness unknown.';
  return <div role="status" className="px-4 py-2 text-sm bg-port-card border-b border-port-border">{label} <Link className="underline" to="/settings/general">View maintenance</Link></div>;
}
