import { EXECUTION_OPTION_DEFINITIONS } from '../../../../server/lib/executionOptions.js';

export default function ExecutionOptionsAttribution({ value, compact = false }) {
  if (compact) {
    if (value?.requested?.serviceTier !== 'fast') return null;
    const source = value.provenance?.serviceTier;
    const details = `Speed: requested fast; effective ${value.effective?.serviceTier ?? 'unconfirmed'}.${source ? ` Source: ${source}.` : ''} ${EXECUTION_OPTION_DEFINITIONS.serviceTier.help}`;
    return <span className="px-2 py-0.5 text-xs rounded bg-amber-500/20 text-amber-400 shrink-0" title={details}>
      <span aria-hidden="true">fast</span><span className="sr-only">{details}</span>
    </span>;
  }
  if (!value?.requested || !Object.keys(value.requested).length) return null;
  return <div className="text-xs text-port-text-muted" aria-label="Execution options used">
    {Object.entries(value.requested).map(([key, requested]) => <p key={key}>
      {EXECUTION_OPTION_DEFINITIONS[key]?.label || key}: requested {String(requested)}; effective {value.effective?.[key] ?? 'unconfirmed'}.
      {' '}{value.provenance?.[key] ? `Source: ${value.provenance[key]}. ` : ''}
      {EXECUTION_OPTION_DEFINITIONS[key]?.help}
    </p>)}
  </div>;
}
