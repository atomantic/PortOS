/**
 * Which engine renders an animation track's source clip (#4876).
 *
 * Grok's cloud i2v lane was the only option until PortOS grew a local MiniMax H3
 * one, and the two are interchangeable from here down: everything after the MP4
 * — chroma recovery, frame selection, loop trimming, geometry QC, approval,
 * atlas compile — is the same deterministic pipeline. So this is a plain picker
 * shared by the walk panel and every track panel rather than a second workflow.
 *
 * Renders NOTHING until the server's readiness list arrives, and nothing when
 * there is at most one lane: an install with no local build should not carry a
 * one-option dropdown implying a choice it does not have.
 *
 * An unready lane stays visible but disabled, with the server's own `reason`
 * shown as text beside the control whether or not that lane is selected. That is
 * deliberate — hiding it would leave the user with no way to discover the local
 * lane exists or what would make it work, and per the repo's UI rules a warning
 * that lives only in a `title` is missed on touch.
 */
import ListLoadError from '../ui/ListLoadError.jsx';

export default function AnimationProviderPicker({
  id, providers, provider, onChange, disabled = false, error = null, onRetry = null,
}) {
  if (error) {
    return <ListLoadError what="animation providers" error={error} onRetry={onRetry} />;
  }
  // `null` = not fetched yet (distinct from `[]` = fetched and empty), so a
  // slow or failed probe never flashes a picker that then disappears.
  if (!Array.isArray(providers) || providers.length < 2) return null;
  // Reasons for EVERY unready lane, not just the selected one. Keying this off
  // the selection made it unreachable in practice: an unready lane is a disabled
  // <option>, so it can never BE the selection — and the reason is the only place
  // the one thing to fix is named.
  const blocked = providers.filter((entry) => entry.ready === false && entry.reason);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <label className="flex items-center gap-1.5 text-xs text-gray-400" htmlFor={id}>
        Render on
        <select
          id={id}
          value={provider}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white disabled:opacity-50"
        >
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={entry.ready === false}>
              {entry.label}
              {entry.ready === false ? ' (unavailable)' : ''}
            </option>
          ))}
        </select>
      </label>
      {blocked.map((entry) => (
        <p key={entry.id} className="text-xs text-port-warning basis-full sm:basis-auto">{entry.reason}</p>
      ))}
    </div>
  );
}
