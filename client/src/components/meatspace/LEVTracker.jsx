import { Rocket } from 'lucide-react';

export default function LEVTracker({ lev }) {
  if (!lev) return null;

  const { targetYear, ageAtLEV, yearsToLEV, researchProgress, onTrack, adjustedLifeExpectancy } = lev;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Rocket size={18} className="text-port-accent" />
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
          Longevity Escape Velocity — {targetYear}
        </h3>
      </div>

      {/* Status */}
      <div className="flex items-center gap-3 mb-4">
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${
          onTrack
            ? 'bg-port-success/10 text-port-success'
            : 'bg-port-error/10 text-port-error'
        }`}>
          <span className={`w-2 h-2 rounded-full ${onTrack ? 'bg-port-success' : 'bg-port-error'}`} />
          {onTrack ? 'On Track' : 'At Risk'}
        </span>
        <span className="text-sm text-gray-400">
          Age at LEV: <span className="text-white font-medium">{ageAtLEV}</span>
          {' | '}
          Adjusted LE: <span className="text-white font-medium">{adjustedLifeExpectancy}y</span>
        </span>
      </div>

      {/* Research timeline progress */}
      <div className="mb-2">
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>Research timeline (2000–{targetYear})</span>
          <span>{researchProgress}%</span>
        </div>
        <div className="h-3 bg-port-border rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-port-accent transition-all duration-500"
            style={{ width: `${researchProgress}%` }}
          />
        </div>
      </div>

      {/* Key stats */}
      <div className="grid grid-cols-3 gap-4 mt-4">
        <div>
          <span className="text-xs text-gray-500">Years to LEV</span>
          <p className="text-xl font-bold text-white">{yearsToLEV}</p>
        </div>
        <div>
          <span className="text-xs text-gray-500">Must survive to age</span>
          <p className="text-xl font-bold text-white">{ageAtLEV}</p>
        </div>
        <div>
          <span className="text-xs text-gray-500">Margin</span>
          <p className={`text-xl font-bold ${onTrack ? 'text-port-success' : 'text-port-error'}`}>
            {onTrack ? '+' : ''}{Math.round((adjustedLifeExpectancy - ageAtLEV) * 10) / 10}y
          </p>
        </div>
      </div>
    </div>
  );
}
