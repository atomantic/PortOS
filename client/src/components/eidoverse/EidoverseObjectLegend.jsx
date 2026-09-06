const ASSET_REASONS = {
  'user-override': 'Override — your chosen asset',
  preferred: 'Preferred — recipe match',
  query: 'Fallback — library search match',
  fallback: 'Fallback — recipe fallback',
  'catalog-fallback': 'Fallback — available library asset',
  lock: 'Saved asset — original resolution reason unavailable',
  unresolved: 'Resolution not verified for this model — refresh the world',
};

function AliasField({ resourceKey, value, onChange, busy }) {
  return (
    <label className="mt-3 block text-xs text-gray-300" htmlFor={`eidoverse-alias-${resourceKey}`}>
      Display alias for {resourceKey.replace('-', ' ')}
      <input id={`eidoverse-alias-${resourceKey}`} maxLength={72} disabled={busy}
        className="mt-1 min-h-[44px] w-full rounded border border-port-border bg-port-card px-2 text-sm text-white"
        value={value || ''} placeholder="Use generic label"
        onChange={(event) => onChange(resourceKey, event.target.value)} />
    </label>
  );
}

export default function EidoverseObjectLegend({ objects, districts = [], aliases = {}, savedAliases = {}, onAliasChange, busy, onAssets }) {
  const groups = new Map();
  const currentKeys = new Set((objects || []).map(({ resourceKey }) => resourceKey));
  // Keep a saved field mounted through an empty draft while the user renames
  // it. A successful save/reset updates savedAliases and releases removed rows.
  const aliasKeys = new Set([...Object.keys(savedAliases), ...Object.keys(aliases)]);
  const unmatchedAliases = [...aliasKeys].filter((key) => !currentKeys.has(key));
  for (const object of objects || []) {
    if (!groups.has(object.districtId)) groups.set(object.districtId, []);
    groups.get(object.districtId).push(object);
  }
  return (
    <section aria-label="Projected object labels" className="space-y-3">
      <h3 className="text-base font-semibold text-white">What the objects represent</h3>
      <p className="text-sm text-gray-400">The last successful projection, including saved asset choices. Refresh the world to update this legend.</p>
      <p className="text-xs leading-5 text-gray-400">Optional display aliases are written to this world's history. Enter only names you intend world visitors to see; blank uses the generic label.</p>
      {!objects && <p className="text-sm text-port-warning">Refresh the world to load its object labels.</p>}
      {objects?.length === 0 && <p className="text-sm text-gray-400">No labelled objects in the last projection.</p>}
      {[...groups].map(([districtId, entries]) => (
        <details key={districtId} open className="rounded-xl border border-port-border bg-port-bg p-3">
          <summary className="min-h-[44px] cursor-pointer py-2 font-medium text-white">
            {districts.find(({ id }) => id === districtId)?.label || 'World landmarks'} — {entries.length} objects
          </summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {entries.map((object) => (
              <article key={object.id} className="min-w-0 rounded-lg border border-port-border p-3">
                <h4 className="break-words text-sm font-medium text-white">{object.name}</h4>
                <p className="mt-1 text-xs leading-5 text-gray-400">{object.description}</p>
                <dl className="mt-2 space-y-1 text-xs">
                  <div><dt className="inline text-gray-400">Label mode: </dt><dd className="inline text-gray-200">{object.visibility}</dd></div>
                  <div><dt className="text-gray-400">Asset choice</dt><dd className="break-all text-port-accent">{object.asset?.path || 'No model recorded'}</dd></div>
                  <div><dt className="sr-only">Resolution reason</dt><dd className="text-gray-300">{ASSET_REASONS[object.asset?.reason] || ASSET_REASONS.unresolved}</dd></div>
                </dl>
                {object.resourceKey && (
                  <AliasField resourceKey={object.resourceKey} value={aliases[object.resourceKey]}
                    onChange={onAliasChange} busy={busy} />
                )}
              </article>
            ))}
          </div>
        </details>
      ))}
      {unmatchedAliases.length > 0 && (
        <section aria-label="Saved aliases without a current object" className="rounded-xl border border-port-border bg-port-bg p-3">
          <h4 className="text-sm font-medium text-white">Saved aliases without a current object</h4>
          <p className="mt-1 text-xs leading-5 text-gray-400">Kept for objects that may return. Clear an alias to remove it without resetting the world.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {unmatchedAliases.map((key) => (
              <AliasField key={key} resourceKey={key} value={aliases[key]} onChange={onAliasChange} busy={busy} />
            ))}
          </div>
        </section>
      )}
      <button type="button" onClick={onAssets} className="min-h-[44px] rounded-lg border border-port-border px-3 py-2 text-sm text-port-accent">
        Change or reset asset choices
      </button>
    </section>
  );
}
