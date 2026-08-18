import { Server } from 'lucide-react';

// Which federated instance runs this task (#4520). `''` is "Any instance" — the
// default, and the opportunistic first-claim-wins behavior CoS has always had.
// Picking a specific instance pins the task there: every other peer passes over
// it even when it is idle.
//
// Presentational on purpose — the instance list is fetched once by the owning
// view (`useAssignableInstances`) and passed in, so a list of task rows doesn't
// issue one request per row.
export default function InstancePicker({ id, value, onChange, instances, label = 'Run on' }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 py-1">
      <span className="flex items-center gap-1.5 text-sm text-gray-400 whitespace-nowrap">
        <Server size={14} className="text-port-accent-2" aria-hidden="true" />
        {label}
      </span>
      <select
        id={id}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        title="Pin this task to one federated instance. Any instance keeps the default behavior: whichever peer picks it up first runs it."
        className="min-w-44 rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-white focus:border-port-accent focus:outline-hidden"
      >
        <option value="">Any instance</option>
        {instances.map((instance) => (
          <option key={instance.instanceId} value={instance.instanceId}>
            {instance.isSelf ? `${instance.name} (this instance)` : instance.name}
          </option>
        ))}
      </select>
    </label>
  );
}
