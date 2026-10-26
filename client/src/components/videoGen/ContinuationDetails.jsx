import { formatCount } from '../../utils/formatters';

const strategyLabel = { auto: 'Automatic', frame: 'Last frame only', window: 'Temporal window' };

// These are the persisted admission/delivery receipts, not today's model capability.
export default function ContinuationDetails({ continuation }) {
  if (!continuation || typeof continuation !== 'object') return null;
  const actualFrames = continuation.effectiveStrategy === 'frame' ? 0 : continuation.actualHistoryFrames;
  const admittedFrames = continuation.effectiveStrategy === 'frame' ? 0 : continuation.contextFrames;
  const facts = [
    ['Requested strategy', strategyLabel[continuation.requestedStrategy] || 'Unknown'],
    ['Effective strategy', strategyLabel[continuation.effectiveStrategy] || 'Unknown'],
    ['Admitted context', admittedFrames == null ? 'Not recorded' : `${formatCount(admittedFrames)} frames`],
    ['Actual history', actualFrames == null ? 'Not measured' : `${formatCount(actualFrames)} frames`],
    ['Backend runtime', continuation.runtime || 'Unknown'],
    ['Backend pin', continuation.backendPin || 'Not recorded'],
    ['Temporal capability at admission', continuation.capability === true ? 'Verified' : continuation.capability === false ? 'Unavailable' : 'Not recorded'],
  ];
  return (
    <section aria-label="Continuation receipt" className="min-w-0 space-y-1 text-xs">
      <h3 className="font-medium text-port-text-muted">Continuation</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {facts.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-port-text-muted">{label}</dt>
            <dd className="text-port-text break-words min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      {continuation.unavailableReason && <p className="text-port-warning-text break-words">{continuation.unavailableReason}</p>}
    </section>
  );
}
