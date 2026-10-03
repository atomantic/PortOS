import ToggleChip from '../ui/ToggleChip.jsx';
import { AUTONOMOUS_AUTO_APPROVE_LABELS, AUTONOMOUS_AUTO_APPROVE_STAGES } from '../../lib/musicVideoAutonomous.js';

// Proof is intentionally absent: it always needs recorded playback or machine evidence.
const planningStages = AUTONOMOUS_AUTO_APPROVE_STAGES.filter(stage => stage !== 'proof');

export default function AutoApproveFields({ idPrefix, value, onChange, error = null, granted = [] }) {
  const toggle = (stage) => onChange(planningStages.filter((s) => (s === stage ? !value.includes(s) : value.includes(s))));
  return (
    <fieldset className="min-w-0 space-y-1" aria-labelledby={`${idPrefix}-auto-approve-label`}>
      <span id={`${idPrefix}-auto-approve-label`} className="block text-xs text-port-text-muted">Automatic planning approvals (optional)</span>
      <div className="flex flex-wrap gap-1.5">
        {planningStages.map((stage) => (
          <ToggleChip
            key={stage}
            id={`${idPrefix}-auto-approve-${stage}`}
            label={AUTONOMOUS_AUTO_APPROVE_LABELS[stage]}
            checked={value.includes(stage)}
            onToggle={() => toggle(stage)}
          />
        ))}
      </div>
      <p className="text-[11px] text-port-text-muted">
        Your signed-in session lets this run approve selected planning stages once their checks pass. The animated proof still waits for recorded playback or machine review.
        {granted.some(s => s !== 'proof') && ` Currently granted: ${granted.filter(s => s !== 'proof').map((s) => AUTONOMOUS_AUTO_APPROVE_LABELS[s] || s).join(', ')}.`}
      </p>
      {error && <p role="alert" className="text-[11px] text-port-error break-words">{error}</p>}
    </fieldset>
  );
}
