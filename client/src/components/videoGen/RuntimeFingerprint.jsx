// Runtime fingerprint — host chip/OS + resolved ltx/mlx/torch versions per
// installed runtime. Lets a user (or a bug report for garbled output) see the
// exact numerical stack without running a render. Extracted from VideoGen.jsx
// (#2834); takes the `status.runtime` object and renders nothing when it's
// absent or empty.
export default function RuntimeFingerprint({ runtime }) {
  if (!runtime) return null;
  const host = runtime.host || {};
  const runtimes = runtime.runtimes || {};
  const ids = Object.keys(runtimes);
  if (!host.chip && !host.os && ids.length === 0) return null;
  return (
    <div className="text-[10px] text-gray-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {(host.chip || host.os) && (
        <span title="Host chip + OS">{[host.chip, host.os].filter(Boolean).join(' · ')}</span>
      )}
      {ids.map((id) => {
        const fp = runtimes[id] || {};
        if (fp.error) {
          return (
            <span key={id} className="text-port-warning/70" title={`Version probe failed: ${fp.error}`}>
              · {id}: version probe failed
            </span>
          );
        }
        const versions = fp.versions && typeof fp.versions === 'object' ? fp.versions : {};
        const vers = Object.keys(versions).length
          ? Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(', ')
          : 'no versions resolved';
        return (
          <span key={id} title={`${id} runtime`}>· {id}: {vers}</span>
        );
      })}
    </div>
  );
}
