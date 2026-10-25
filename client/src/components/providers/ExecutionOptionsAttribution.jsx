import { EXECUTION_OPTION_DEFINITIONS } from '../../../../server/lib/executionOptions.js';

export default function ExecutionOptionsAttribution({ value }) {
  if (!value?.requested || !Object.keys(value.requested).length) return null;
  return <div className="text-xs text-port-text-muted" aria-label="Execution options used">
    {Object.entries(value.requested).map(([key, requested]) => <p key={key}>
      {EXECUTION_OPTION_DEFINITIONS[key]?.label || key}: requested {String(requested)}; effective {value.effective?.[key] ?? 'unconfirmed'}.
      {' '}{value.provenance?.[key] ? `Source: ${value.provenance[key]}. ` : ''}
      {EXECUTION_OPTION_DEFINITIONS[key]?.help}
    </p>)}
  </div>;
}
