import { useId, useState } from 'react';
import { writeClipboardSilently } from '../../lib/clipboard.js';

// Only share an existing, same-origin media URL without credentials or query
// parameters. External and signed URLs can contain access credentials.
function shareableMediaUrl(value) {
  if (typeof value !== 'string' || !value || !globalThis.location?.origin) return null;
  try {
    const url = new URL(value, globalThis.location.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== globalThis.location.origin
      || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

export default function AssetReferenceActions({ assetId, url, resolveUrl }) {
  const inputId = useId();
  const [manual, setManual] = useState(null);
  const [status, setStatus] = useState('');
  const [working, setWorking] = useState(false);
  const directUrl = shareableMediaUrl(url);
  if (!assetId && !directUrl && !resolveUrl) return null;

  const copy = async (event, type) => {
    event.stopPropagation();
    if (working) return;
    setManual(null);
    setStatus(type === 'URL' && resolveUrl ? 'Getting URL…' : '');
    setWorking(true);
    try {
      const value = type === 'ID' ? assetId : directUrl || shareableMediaUrl(await resolveUrl());
      if (!value) {
        setStatus(`${type} unavailable for this asset`);
        return;
      }
      if (await writeClipboardSilently(value)) setStatus(`${type} copied`);
      else {
        setManual({ type, value });
        setStatus('Copy unavailable. Select the text below to copy it.');
      }
    } catch {
      setStatus(`Could not get ${type}. Try again.`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="@container space-y-1">
      <div role="group" aria-label="Copy asset reference" className="grid grid-cols-1 @min-[9rem]:grid-cols-2 gap-1">
        {assetId && <button type="button" data-asset-copy-trigger="" aria-disabled={working} onClick={(event) => copy(event, 'ID')}
          className="min-h-[44px] min-w-0 rounded border border-port-border bg-port-bg px-1 text-[11px] font-medium hover:bg-port-border/70 focus-visible:ring-2 focus-visible:ring-port-accent aria-disabled:opacity-50">Copy ID</button>}
        {(directUrl || resolveUrl) && <button type="button" data-asset-copy-trigger="" aria-disabled={working} onClick={(event) => copy(event, 'URL')}
          className="min-h-[44px] min-w-0 rounded border border-port-border bg-port-bg px-1 text-[11px] font-medium hover:bg-port-border/70 focus-visible:ring-2 focus-visible:ring-port-accent aria-disabled:opacity-50">Copy URL</button>}
      </div>
      {status && <p role="status" className="break-words text-[11px] text-port-text-muted">{status}</p>}
      {manual && (
        <div className="space-y-1">
          <label htmlFor={inputId} className="block text-[11px] text-port-text-muted">{manual.type} to copy</label>
          <input id={inputId} readOnly value={manual.value}
            onClick={(event) => {
              event.stopPropagation();
              const input = event.currentTarget;
              setTimeout(() => input.setSelectionRange(0, input.value.length), 0);
            }}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-[44px] w-full min-w-0 rounded border border-port-border bg-port-bg px-2 text-base" />
          <button type="button" onClick={(event) => { event.stopPropagation(); setManual(null); setStatus(''); }}
            className="min-h-[44px] rounded border border-port-border px-2 text-[11px]">Done</button>
        </div>
      )}
    </div>
  );
}
