import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { walkUnlockCopy } from '../../lib/spriteWalkUnlock.js';
import Banner from '../ui/Banner.jsx';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';

export default function WalkReopenControls({ direction, run, approved, finalized, onReopen }) {
  const [reopening, setReopening] = useState(false);
  if (!approved) return null;

  // The server stamps the reopen block with the exact same resolver that will
  // validate the POST. A missing block from an older peer remains an ordinary
  // reopen; only a stamped block changes the affordance.
  const reopenCopy = walkUnlockCopy(run?.reopen, { mode: 'reopen', direction });

  // Reopening a direction leaves the other approvals and the rendered clip intact.
  if (reopenCopy) {
    return (
      <Banner tone="warning" size="sm" icon={RotateCcw} className="space-y-1.5">
        <p className="leading-relaxed">{reopenCopy.text}</p>
        {reopenCopy.action && (reopening ? (
          <ConfirmButtonPair
            prompt={reopenCopy.prompt}
            confirmText={reopenCopy.action}
            confirmIcon={RotateCcw}
            tone="warning"
            ariaLabel={`Confirm reopen ${direction} without source clips`}
            onConfirm={() => {
              setReopening(false);
              onReopen(direction, reopenCopy.acknowledgeNoClips, reopenCopy.toast);
            }}
            onCancel={() => setReopening(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setReopening(true)}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-bg border border-port-warning/60 rounded text-port-warning hover:bg-port-warning/10"
          >
            <RotateCcw className="w-3 h-3" /> {reopenCopy.action}
          </button>
        ))}
      </Banner>
    );
  }

  return (
    reopening ? (
      <ConfirmButtonPair
        prompt={finalized ? 'Reopen (un-freezes set)?' : 'Reopen this direction?'}
        confirmText="Reopen"
        confirmIcon={RotateCcw}
        tone="warning"
        ariaLabel={`Confirm reopen ${direction}`}
        onConfirm={() => { setReopening(false); onReopen(direction); }}
        onCancel={() => setReopening(false)}
      />
    ) : (
      <button
        type="button"
        onClick={() => setReopening(true)}
        title="Re-open this direction to regenerate or reprocess it (rendered clip is kept)"
        className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-bg border border-port-border rounded text-gray-400 hover:border-port-accent hover:text-white"
      >
        <RotateCcw className="w-3 h-3" /> Reopen
      </button>
    )
  );
}
