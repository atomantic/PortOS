const PHASE_STATUS_COLORS = {
  completed: 'bg-port-success',
  'in-progress': 'bg-port-accent',
  planned: 'bg-port-warning',
  pending: 'bg-gray-600'
};

const LIFECYCLE_STEPS = ['research', 'plan', 'execute', 'verify'];

export default function PhaseTimeline({ phases = [] }) {
  if (phases.length === 0) return <p className="text-xs text-gray-500 italic">No phases found</p>;

  return (
    <div className="space-y-1.5">
      {phases.map(phase => (
        <div key={phase.id || phase.name} className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full shrink-0 ${PHASE_STATUS_COLORS[phase.status] || 'bg-gray-600'}`} />
          <span className="text-xs text-gray-400 font-mono w-8 shrink-0">{phase.id || '??'}</span>
          <span className="text-xs text-gray-300 truncate flex-1">{phase.title || phase.name}</span>
          {phase.lifecycle && (
            <div className="flex gap-0.5">
              {LIFECYCLE_STEPS.map(step => (
                <div
                  key={step}
                  className={`w-1.5 h-1.5 rounded-full ${
                    phase.lifecycle[step] === 'done' ? 'bg-port-success' :
                    phase.lifecycle[step] === 'active' ? 'bg-port-accent' :
                    'bg-gray-700'
                  }`}
                  title={`${step}: ${phase.lifecycle[step] || 'pending'}`}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
