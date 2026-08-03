import { useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import Pill from '../ui/Pill';

// Built-in default banner — shows the shipped-default label and an inline-
// confirmed "Refresh from template" action (restores shipped content, keeps the
// user's recordings + learned progress). Inline confirm rather than a two-click
// arm so the destructive-of-edits nature is explicit without a hidden re-click.
export default function RoundBuiltInBanner({ onRefresh, refreshing }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3 bg-port-accent/5 border border-port-accent/20 rounded-lg px-3 py-2">
      <Pill tone="accent" icon={Sparkles}>Built-in default</Pill>
      <span className="text-xs text-gray-400 sm:flex-1 sm:min-w-0">
        Shipped with PortOS. Refresh to restore the latest bundled lyrics, arrangement & references — your recordings and learned progress are kept.
      </span>
      {confirming ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-300 w-full sm:w-auto">Replace local edits?</span>
          <button
            type="button"
            onClick={() => { onRefresh(); setConfirming(false); }}
            disabled={refreshing}
            className="flex-1 sm:flex-none px-2.5 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="flex-1 sm:flex-none px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={refreshing}
          className="flex items-center justify-center gap-1.5 w-full sm:w-auto px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50 sm:shrink-0"
        >
          <RefreshCw size={14} /> Refresh from template
        </button>
      )}
    </div>
  );
}
