import { formatCount } from '../../utils/formatters';

export default function CodexImageUsageCard({ imageRenders }) {
  if (!imageRenders) return null;
  return (
    <section className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-2" aria-label="Codex image usage">
      <h3 className="text-sm font-medium text-white">Codex image usage</h3>
      {imageRenders.error ? (
        <p className="text-sm text-gray-400" role="status">Image render usage is unavailable. Text usage remains available.</p>
      ) : (
        <>
          {imageRenders.incomplete && <p className="text-xs text-port-warning" role="status">Partial: some instances did not report complete image receipts or reported conflicting identities.</p>}
          <p className="text-sm text-gray-300">
            {formatCount(imageRenders.codexSessions)} Codex sessions · {formatCount(imageRenders.savedOutputs)} saved outputs in this period
          </p>
          <p className="text-xs text-gray-400">
            Image tokens, image cost and subscription allowance attribution: unknown.
            Any driver tokens already captured by text accounting stay in the text report. Image costs are excluded from the API estimate.
            Saved outputs show observed activity; they do not measure every image-tool call or failed attempt.
            Mirrored outputs are counted once by their saved identity.
            Sessions and driver totals are attributed to the day of the first saved output; outputs are counted on their own day.
          </p>
          <p className="text-xs text-gray-400">
            {imageRenders.driverTokens
              ? `${formatCount(imageRenders.driverTokens.reportedTotal)} reported driver tokens across ${formatCount(imageRenders.driverTokens.sessionsMeasured)} sessions; no input/output split or image attribution.`
              : 'Driver tokens: unknown.'}
            {imageRenders.driverTokens && ` Driver tokens are unknown for ${formatCount(imageRenders.driverSessionsUnknown)} other render groups.`}
          </p>
          {imageRenders.jobIdentityGroups > 0 && (
            <p className="text-xs text-gray-400">{formatCount(imageRenders.jobIdentityGroups)} additional render groups use saved job IDs; their Codex session IDs are unavailable.</p>
          )}
        </>
      )}
    </section>
  );
}
