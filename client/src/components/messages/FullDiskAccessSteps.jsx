import { Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';

// Grant steps for a macOS Full Disk Access denial. macOS never prompts for it,
// so the server names the exact binary to add (`fullDiskAccess` from
// server/lib/fullDiskAccess.js); a pm2 LaunchAgent install needs its node
// binary, not the terminal app.
export default function FullDiskAccessSteps({ target, onRecheck, rechecking = false }) {
  const isApp = target.launchedBy === 'app';
  return (
    <div className="space-y-3">
      <p className="text-gray-300">Add {target.paths.length > 1 ? 'these' : 'this'} to Full Disk Access:</p>
      {target.paths.map((path) => (
        <div key={path} className="flex items-center gap-2">
          <code className="flex-1 min-w-0 break-all px-2 py-1.5 bg-port-bg border border-port-border rounded text-xs text-gray-200">{path}</code>
          <button
            type="button"
            onClick={() => copyToClipboard(path, 'Path copied')}
            aria-label={`Copy ${path}`}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 inline-flex items-center justify-center min-h-[40px] min-w-[40px] bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg"
          >
            <Copy size={14} />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <a
          href={target.settingsUrl}
          className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm"
        >
          <ExternalLink size={14} />
          Open Full Disk Access settings
        </a>
        <button
          type="button"
          onClick={onRecheck}
          disabled={rechecking}
          className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm disabled:opacity-40"
        >
          {rechecking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Recheck
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Click +, press Cmd+Shift+G, paste the path. Still blocked after Recheck? Restart PortOS.
        {!isApp && ' Changing Node versions needs a new grant.'}
      </p>
    </div>
  );
}
