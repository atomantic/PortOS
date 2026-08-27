import CapabilityBadges from './CapabilityBadges.jsx';

const SOURCE_COPY = {
  runtime: 'Reported by the local model runtime.',
  'runtime-unknown': 'The local runtime found this model but could not report its capabilities right now.',
  provider: 'These are provider-level harness capabilities; this provider does not publish a separate per-model report.',
  inferred: 'Some badges are inferred from the model id. A runtime report takes precedence when available.',
  loading: 'Checking the local runtime for an authoritative capability report…',
  unknown: 'This provider does not publish per-model capability metadata, so tool use and image analysis are not confirmed here.',
};

/**
 * Explain what PortOS knows about the model selected for an agent profile.
 * Keep this beside CapabilityBadges so model pickers use the same vocabulary
 * as the Local LLM settings cards instead of inventing another set of labels.
 */
export default function ModelCapabilitySummary({
  provider,
  model,
  capabilities,
  source = 'unknown',
  recommendation = null,
}) {
  if (!provider || !model) {
    return (
      <p className="text-xs text-port-text-muted">
        Choose a provider and model to see capability badges and the available recommendation.
      </p>
    );
  }

  const capabilityCopy = Array.isArray(capabilities) && capabilities.length === 0
    ? 'The runtime reported no optional capabilities for this model.'
    : SOURCE_COPY[source] || SOURCE_COPY.unknown;

  return (
    <section
      aria-label="Model capabilities"
      data-testid="model-capability-summary"
      className="rounded border border-port-border bg-port-bg/50 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold text-port-text">Model capabilities</h4>
        {recommendation && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded border border-port-accent/50 bg-port-accent/10 text-port-accent"
            title={recommendation.reason || 'Recommended local model'}
          >
            ★ Recommended local model
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mt-1.5 min-h-5">
        {Array.isArray(capabilities) && capabilities.length === 0 ? (
          <span className="text-[11px] text-gray-500">No optional capabilities reported</span>
        ) : (
          <CapabilityBadges capabilities={capabilities} />
        )}
      </div>
      <p className="mt-1 text-[11px] text-port-text-muted">{capabilityCopy}</p>
      {recommendation?.reason && (
        <p className="mt-0.5 text-[11px] text-port-accent">{recommendation.reason}</p>
      )}
    </section>
  );
}
