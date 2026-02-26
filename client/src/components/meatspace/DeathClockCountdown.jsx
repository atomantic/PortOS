import { useDeathClock } from '../../hooks/useDeathClock';

const TimeUnit = ({ value, label, color }) => (
  <div className="flex flex-col items-center">
    <span className={`text-3xl md:text-5xl font-mono font-bold tabular-nums ${color}`}>
      {String(value).padStart(2, '0')}
    </span>
    <span className="text-xs text-gray-500 uppercase mt-1">{label}</span>
  </div>
);

const Separator = () => (
  <span className="text-2xl md:text-4xl font-mono text-gray-600 self-start mt-1">:</span>
);

export default function DeathClockCountdown({ deathDate, lifeExpectancy, percentComplete }) {
  const countdown = useDeathClock(deathDate);

  if (!countdown) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <p className="text-gray-500">Death clock unavailable. Set birth date in Digital Twin &gt; Goals.</p>
      </div>
    );
  }

  if (countdown.expired) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <p className="text-port-error text-xl font-bold">Time expired. You&apos;re on borrowed time.</p>
      </div>
    );
  }

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">Time Remaining</h3>

      {/* Countdown timer */}
      <div className="flex items-start gap-2 md:gap-3 justify-center flex-wrap">
        <TimeUnit value={countdown.years} label="years" color="text-port-accent" />
        <Separator />
        <TimeUnit value={countdown.months} label="months" color="text-purple-400" />
        <Separator />
        <TimeUnit value={countdown.weeks} label="weeks" color="text-teal-400" />
        <Separator />
        <TimeUnit value={countdown.days} label="days" color="text-port-success" />
        <Separator />
        <TimeUnit value={countdown.hours} label="hours" color="text-port-warning" />
        <Separator />
        <TimeUnit value={countdown.minutes} label="min" color="text-orange-400" />
        <Separator />
        <TimeUnit value={countdown.seconds} label="sec" color="text-port-error" />
      </div>

      {/* Life expectancy details */}
      {lifeExpectancy && (
        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <span className="text-xs text-gray-500">SSA Baseline</span>
            <p className="text-lg font-semibold text-gray-300">{lifeExpectancy.baseline}y</p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Genome Adjusted</span>
            <p className="text-lg font-semibold text-gray-300">{lifeExpectancy.genomeAdjusted}y</p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Lifestyle Adj.</span>
            <p className={`text-lg font-semibold ${lifeExpectancy.lifestyleAdjustment >= 0 ? 'text-port-success' : 'text-port-error'}`}>
              {lifeExpectancy.lifestyleAdjustment >= 0 ? '+' : ''}{lifeExpectancy.lifestyleAdjustment}y
            </p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Total LE</span>
            <p className="text-lg font-semibold text-white">{lifeExpectancy.total}y</p>
          </div>
        </div>
      )}

      {/* Progress bar */}
      {percentComplete != null && (
        <div className="mt-4">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Life progress</span>
            <span>{percentComplete}%</span>
          </div>
          <div className="h-2 bg-port-border rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000"
              style={{
                width: `${Math.min(100, percentComplete)}%`,
                background: percentComplete > 80 ? '#ef4444' : percentComplete > 60 ? '#f59e0b' : '#3b82f6'
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
