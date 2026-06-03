import { Calendar, Sun, Moon, TreePine, Snowflake, Flower2, CloudSun, Cake } from 'lucide-react';

function CompactStat({ icon: Icon, iconColor, label, value, sub }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <Icon size={14} className={`${iconColor} shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-400">{label}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-bold text-white">{typeof value === 'number' ? value.toLocaleString() : value}</div>
        {sub && <div className="text-[9px] text-gray-600">{sub}</div>}
      </div>
    </div>
  );
}

export default function TimeStats({ stats }) {
  const r = stats.remaining;
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 h-full">
      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">Time Remaining</h3>
      <div className="divide-y divide-port-border">
        <CompactStat icon={Sun} iconColor="text-yellow-400" label="Saturdays" value={r.saturdays} sub={`${Math.round(r.saturdays / 52)}y`} />
        <CompactStat icon={Sun} iconColor="text-orange-400" label="Sundays" value={r.sundays} sub={`${Math.round(r.sundays / 52)}y`} />
        <CompactStat icon={CloudSun} iconColor="text-blue-400" label="Weekends" value={r.weekends} sub={`${Math.round(r.weekends * 2)} days`} />
        <CompactStat icon={Moon} iconColor="text-indigo-400" label="Sleep" value={`${Math.round(r.sleepHours / 24 / 365.25)}y`} sub={`${r.sleepHours.toLocaleString()}h`} />
        <CompactStat icon={Sun} iconColor="text-green-400" label="Awake Days" value={r.awakeDays} sub={`${Math.round(r.awakeDays / 365.25)}y`} />
        <CompactStat icon={Calendar} iconColor="text-purple-400" label="Months" value={r.months} />
        <CompactStat icon={Calendar} iconColor="text-teal-400" label="Weeks" value={r.weeks} />
        <CompactStat icon={Calendar} iconColor="text-port-accent" label="Days" value={r.days} />
        <CompactStat icon={Snowflake} iconColor="text-cyan-400" label="Winters" value={Math.floor(r.seasons / 4)} />
        <CompactStat icon={Flower2} iconColor="text-pink-400" label="Springs" value={Math.floor(r.seasons / 4)} />
        <CompactStat icon={TreePine} iconColor="text-green-400" label="Summers" value={Math.floor(r.seasons / 4)} />
        <CompactStat icon={Cake} iconColor="text-port-warning" label="Holidays" value={r.holidays} />
      </div>
    </div>
  );
}
