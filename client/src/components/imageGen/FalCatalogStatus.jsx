import { useState } from 'react';

export default function FalCatalogStatus({ catalog }) {
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    setBusy(true);
    void catalog.refresh().finally(() => setBusy(false));
  };
  return (
    <div className="text-xs text-gray-400 space-y-1">
      <p>
        {catalog.stale ? 'Using cached fal.ai image models.' : 'fal.ai image models are cached.'}
        {' '}
        <button type="button" disabled={busy} onClick={refresh} className="text-port-accent disabled:opacity-50">
          {busy ? 'Refreshing…' : 'Refresh models'}
        </button>
      </p>
      {catalog.error && <p role="status">The fal.ai model list could not be refreshed. Featured models stay available.</p>}
      {catalog.truncated && <p>The live list was truncated. Featured models stay available.</p>}
      <p>A listed model is not a promise this account can run it. Curated prices are published rates; other models are priced by fal.ai.</p>
    </div>
  );
}
