import { useDeathClock } from '../hooks/useDeathClock';

const UNITS = [
  { key: 'years',   label: 'y',  color: 'text-port-accent' },
  { key: 'months',  label: 'mo', color: 'text-purple-400' },
  { key: 'weeks',   label: 'w',  color: 'text-teal-400' },
  { key: 'days',    label: 'd',  color: 'text-port-success' },
  { key: 'hours',   label: 'h',  color: 'text-port-warning' },
  { key: 'minutes', label: 'm',  color: 'text-orange-400' },
  { key: 'seconds', label: 's',  color: 'text-port-error' },
];

const SIZE_PRESETS = {
  sm: { value: 'text-base sm:text-lg',     label: 'text-[10px]',     sep: 'mx-0' },
  md: { value: 'text-2xl',                 label: 'text-xs',         sep: 'mx-0.5' },
  lg: { value: 'text-3xl sm:text-4xl',     label: 'text-xs sm:text-sm', sep: 'mx-0.5 sm:mx-1' },
};

export default function DeathClockCountdown({ deathDate, size = 'md', align = 'start', className = '' }) {
  const countdown = useDeathClock(deathDate);

  if (!countdown) return null;
  if (countdown.expired) {
    return <p className={`text-port-error font-bold ${className}`}>Time expired. You&apos;re on borrowed time.</p>;
  }

  const preset = SIZE_PRESETS[size] ?? SIZE_PRESETS.md;
  const justify = align === 'center' ? 'justify-center' : align === 'end' ? 'justify-end' : 'justify-start';

  return (
    <div className={`flex items-baseline gap-1 flex-wrap ${justify} ${className}`}>
      {UNITS.map((u, i) => (
        <span key={u.key} className="whitespace-nowrap">
          <span className={`${preset.value} font-mono font-bold tabular-nums ${u.color}`}>
            {String(countdown[u.key] ?? 0).padStart(2, '0')}
          </span>
          <span className={`${preset.label} text-gray-500 ml-0.5`}>{u.label}</span>
          {i < UNITS.length - 1 && <span className={`text-gray-600 ${preset.sep}`}>:</span>}
        </span>
      ))}
    </div>
  );
}
