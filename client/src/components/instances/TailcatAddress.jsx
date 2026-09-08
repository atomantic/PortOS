import { useId, useState } from 'react';
import { Copy } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';

export default function TailcatAddress({ address, preview, disabled = false, label = 'Copy address' }) {
  const [revealedAddress, setRevealedAddress] = useState(null);
  const id = useId();
  if (!address) return null;
  const revealed = revealedAddress === address;
  const copy = async () => {
    if (!await copyToClipboard(address, 'Tailcat address copied')) setRevealedAddress(address);
  };
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-mono text-gray-400 break-all">{preview || 'tc…'}</span>
        <button type="button" onClick={copy} disabled={disabled}
          className="inline-flex items-center gap-1 text-xs border border-port-border rounded px-2 py-1 disabled:opacity-50">
          <Copy size={12} /> {label}
        </button>
        <button type="button" disabled={disabled} onClick={() => setRevealedAddress(revealed ? null : address)}
          className="text-xs underline disabled:opacity-50">
          {revealed ? 'Hide address' : 'Show address'}
        </button>
      </div>
      {revealed && (
        <div>
          <label htmlFor={id} className="block text-xs text-gray-400 mb-1">Full Tailcat address — select and copy to the other node</label>
          <input id={id} aria-label="Full Tailcat address" readOnly value={address}
            onFocus={(event) => event.target.select()}
            className="w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1 text-xs font-mono" />
        </div>
      )}
    </div>
  );
}
