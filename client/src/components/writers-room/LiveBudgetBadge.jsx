import { AlertTriangle } from 'lucide-react';

// Shared daily-budget readout for the three Writers Room live panels (#3567).
//
// Each panel used to render its remaining-call count as a bare
// `<span title="Daily suggestion budget">7 / 10 left today</span>`. A touch
// screen fires no hover, so on a phone *what* the number counted was invisible,
// and a spent budget looked identical to a healthy one. The name of the budget
// is visible text now, and a low/exhausted balance carries a visible tone + icon
// plus the reset time rather than hiding it all in a tooltip.
//
// `label` is the visible name of the budget this panel spends — the CD bridge
// and continuation panels share ONE counter, so their labels say so.
//
// Deliberately no `aria-label` (the visible text is already the accessible name;
// an aria-label would shadow it and drift) and no `role="status"` (the two
// suggestion badges render the same shared count, so every spend would be
// announced twice).

// Warn once a fifth of the daily allowance is left — at least 1 call, so a tiny
// budget still gets a warning before it hits zero, but never the whole budget:
// a `dailyCallBudget` of 1 would otherwise render its untouched allowance as a
// warning, because a fifth of 1 rounds back up to 1.
const LOW_RATIO = 0.2;
const lowThreshold = (budget) => Math.min(budget - 1, Math.max(1, Math.ceil(budget * LOW_RATIO)));

export default function LiveBudgetBadge({ label, budget, spent }) {
  const limited = budget > 0;
  const remaining = limited ? Math.max(0, budget - (spent || 0)) : null;
  const exhausted = limited && remaining === 0;
  const low = limited && !exhausted && remaining <= lowThreshold(budget);
  const tone = exhausted ? 'text-port-error' : low ? 'text-port-warning' : 'text-gray-500';

  return (
    <span className={`inline-flex items-center gap-1 text-[10px] leading-tight ${tone}`}>
      {(exhausted || low) && <AlertTriangle size={10} aria-hidden="true" className="shrink-0" />}
      {label}: {limited ? `${remaining} / ${budget} left today` : 'unlimited'}
      {exhausted ? ' — resets at UTC midnight' : ''}
    </span>
  );
}
