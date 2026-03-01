import PhaseCard from './PhaseCard';

export default function PhaseCardList({ phases = [], pendingActions = [], appId, expandedPhase, onTogglePhase }) {
  if (phases.length === 0) {
    return <p className="text-xs text-gray-500 italic">No phases found</p>;
  }

  const actionMap = {};
  for (const action of pendingActions) {
    actionMap[action.phaseId] = action;
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Phases</h4>
      {phases.map(phase => (
        <PhaseCard
          key={phase.id}
          phase={phase}
          pendingAction={actionMap[phase.id]}
          appId={appId}
          expanded={expandedPhase === phase.id}
          onToggle={() => onTogglePhase(phase.id)}
        />
      ))}
    </div>
  );
}
