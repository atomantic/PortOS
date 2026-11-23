import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { getHtmlPageFilePath, htmlPageFileUrl } from '../../services/apiHtmlPages.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import toast from '../ui/Toast';

/**
 * Download one stored page as its .html file, or copy where that file is on the PortOS machine. The server writes the file from the run record first if it is missing.
 */
export default function PageFileActions({ runId, index, label }) {
  const [copying, setCopying] = useState(false);
  const copyPath = async () => {
    setCopying(true);
    const file = await getHtmlPageFilePath(runId, index, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not find that page file'); return null; });
    setCopying(false);
    if (file?.path) await copyToClipboard(file.path, 'File path copied');
  };
  return (
    <div className="flex items-center gap-1">
      <a
        href={htmlPageFileUrl(runId, index)}
        download
        aria-label={`Download ${label}`}
        title="Download the .html file"
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white"
      >
        <Download size={14} aria-hidden="true" />
      </a>
      <button
        type="button"
        onClick={copyPath}
        disabled={copying}
        aria-label={`Copy the file path of ${label}`}
        title="Copy the file path on the PortOS machine"
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white disabled:opacity-40"
      >
        <Copy size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
