import { useState } from 'react';

export default function RunwayCatalogStatus({ catalog }) {
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    setBusy(true);
    void catalog.refresh().finally(() => setBusy(false));
  };
  return (
    <div className="text-xs text-gray-400 space-y-1">
      <p>{catalog.stale ? 'Using cached Runway model options.' : 'Runway model options are cached.'} <button type="button" disabled={busy} onClick={refresh} className="text-port-accent disabled:opacity-50">{busy ? 'Refreshing…' : 'Refresh models'}</button></p>
      {catalog.error && <p role="status">Catalog refresh unavailable. Cached options remain usable.</p>}
      {catalog.unsupported?.length > 0 && <details><summary>Models requiring other workflows or an app update</summary><ul>{catalog.unsupported.map((item, index) => <li key={`${item.id}-${index}`}>{item.id}: {item.reason}</li>)}</ul></details>}
      <p>Catalog availability does not confirm account access. Prices not listed here are shown in Runway’s pricing guide.</p>
    </div>
  );
}
