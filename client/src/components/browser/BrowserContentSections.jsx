import { ChevronDown, ChevronRight, Download, FolderOpen, Monitor, Trash2 } from 'lucide-react';
import { browserDownloadUrl } from '../../services/apiSystem.js';
import { formatBytes, formatDateTime } from '../../utils/formatters';

// Mirrors HOST_CONTROL_FORBIDDEN_MESSAGE; the status read stays open but omits
// page and download listings for a caller without host control (#12488).
const HOST_CONTROL_NOTE = 'Open pages and downloads need an operator session, or a local connection when no password is set. Set an instance password to use them remotely.';

export function BrowserPagesSection({ status, isConnected, showPages, setShowPages }) {
  return (
    <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
      <button
        onClick={() => setShowPages(s => !s)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-port-border/30 transition-colors"
      >
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <Monitor size={20} className="text-port-accent" />
          Open Pages
          {status?.pages?.length > 0 && (
            <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-port-accent/20 text-port-accent">
              {status.pages.length}
            </span>
          )}
        </h3>
        {showPages ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronRight size={18} className="text-gray-400" />}
      </button>
      {showPages && (
        <div className="border-t border-port-border">
          {status?.contentRedacted ? (
            <div className="p-4 text-sm text-gray-500">{HOST_CONTROL_NOTE}</div>
          ) : !status?.pages || status.pages.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">
              {isConnected ? 'No pages open' : 'Browser not connected'}
            </div>
          ) : (
            <div className="divide-y divide-port-border">
              {status.pages.map(page => (
                <div key={page.id} className="p-3 hover:bg-port-border/20 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white truncate">
                        {page.title}
                      </div>
                      <div className="text-xs text-gray-500 truncate mt-0.5">
                        {page.url}
                      </div>
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-port-border text-gray-400 shrink-0">
                      {page.type}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BrowserDownloadsSection({ status, showDownloads, setShowDownloads, handleDeleteDownload }) {
  return (
    <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
      <button
        onClick={() => setShowDownloads(s => !s)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-port-border/30 transition-colors"
      >
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <Download size={20} className="text-port-accent" />
          Downloads
          {status?.downloads?.files?.length > 0 && (
            <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-port-accent/20 text-port-accent">
              {status.downloads.files.length}
            </span>
          )}
        </h3>
        {showDownloads ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronRight size={18} className="text-gray-400" />}
      </button>
      {showDownloads && (
        <div className="border-t border-port-border">
          {status?.downloads?.downloadDir && (
            <div className="px-4 py-2 bg-port-bg/50 border-b border-port-border flex items-center gap-2 text-xs text-gray-500">
              <FolderOpen size={12} />
              <span className="font-mono truncate">{status.downloads.downloadDir}</span>
            </div>
          )}
          {status?.contentRedacted ? (
            <div className="p-4 text-sm text-gray-500">{HOST_CONTROL_NOTE}</div>
          ) : !status?.downloads?.files || status.downloads.files.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No downloads</div>
          ) : (
            <div className="divide-y divide-port-border">
              {status.downloads.files.map(file => (
                <div key={file.name} className="p-3 hover:bg-port-border/20 transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <a
                      href={browserDownloadUrl(file.name)}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 group"
                      title="Open in new tab"
                    >
                      <div className="text-sm font-medium text-white truncate group-hover:text-port-accent">
                        {file.name}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {formatBytes(file.size)} &middot; {formatDateTime(file.modified)}
                      </div>
                    </a>
                    <div className="flex items-center gap-1 shrink-0">
                      <a
                        href={`${browserDownloadUrl(file.name)}?attachment=1`}
                        download={file.name}
                        className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-port-border/50 transition-colors"
                        title="Save to device"
                        aria-label={`Save ${file.name} to device`}
                      >
                        <Download size={16} />
                      </a>
                      <button
                        onClick={() => handleDeleteDownload(file.name)}
                        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded-md text-gray-400 hover:text-port-error hover:bg-port-border/50 transition-colors"
                        title="Delete file" aria-label="Delete file"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
