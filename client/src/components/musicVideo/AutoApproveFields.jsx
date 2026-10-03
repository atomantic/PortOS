import ToggleChip from '../ui/ToggleChip.jsx';
import { AUTONOMOUS_AUTO_APPROVE_LABELS, AUTONOMOUS_AUTO_APPROVE_STAGES } from '../../lib/musicVideoAutonomous.js';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * "Auto-approve" — the Production review stages the autonomous run may approve
 * itself (art, storyboard, animated proof). Granting that is the operator's
 * authority, so picking any stage asks for the instance password once, on this
 * request; it is sent with it and never stored. `error` is the API's refusal.
 */
export default function AutoApproveFields({ idPrefix, value, onChange, password, onPasswordChange, error = null, granted = [] }) {
  const toggle = (stage) => onChange(AUTONOMOUS_AUTO_APPROVE_STAGES.filter((s) => (s === stage ? !value.includes(s) : value.includes(s))));
  return (
    <fieldset className="min-w-0 space-y-1" aria-labelledby={`${idPrefix}-auto-approve-label`}>
      <span id={`${idPrefix}-auto-approve-label`} className="block text-xs text-port-text-muted">Auto-approve (optional)</span>
      <div className="flex flex-wrap gap-1.5">
        {AUTONOMOUS_AUTO_APPROVE_STAGES.map((stage) => (
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
        The run approves these Production review stages itself once each has no open problems; the proof after its render finishes.
        {granted.length > 0 && ` Currently granted: ${granted.map((s) => AUTONOMOUS_AUTO_APPROVE_LABELS[s] || s).join(', ')}.`}
      </p>
      {value.length > 0 && (
        <div>
          <label htmlFor={`${idPrefix}-auto-approve-password`} className="block text-xs text-port-text-muted mb-1">Instance password to grant this</label>
          <input
            id={`${idPrefix}-auto-approve-password`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            aria-invalid={!!error}
            className={inputClass}
          />
          <p className="text-[11px] text-port-text-muted mt-1">Enter it yourself, once. API tokens cannot grant approval.</p>
        </div>
      )}
      {error && <p role="alert" className="text-[11px] text-port-error break-words">{error}</p>}
    </fieldset>
  );
}
