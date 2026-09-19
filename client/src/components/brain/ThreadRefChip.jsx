import { Link } from 'react-router';
import { ExternalLink, X } from 'lucide-react';
import Pill from '../ui/Pill';
import { EXTERNAL_THREAD_REF_KINDS, threadRefLabel } from '../../lib/threadRefKinds.js';

// One chip for a `(kind, id)` ref, wherever it is rendered — the Threads tab's
// Links panel and the catalog ingredient's "Appears in" list. Follows the
// shared registry (`lib/threadRefKinds.js`): an external kind links with a real
// `<a>`, an internal kind with the router `<Link>`, and a ref this build can't
// deep-link (`url` null) renders unlinked — the contract the catalog page
// always had. `onRemove` adds the detach affordance the Links panel needs;
// `showKind={false}` drops the kind prefix where a group heading already says it.
export default function ThreadRefChip({ kind, id, label, url, resolved, reason, onRemove, showKind = true }) {
  const text = label || id;
  const body = (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-port-border bg-port-bg text-gray-200">
      {showKind && <span className="text-gray-500">{threadRefLabel(kind)}</span>}
      <span className="max-w-[16rem] truncate" title={text}>{text}</span>
      {url && <ExternalLink size={10} aria-hidden="true" />}
    </span>
  );
  const external = EXTERNAL_THREAD_REF_KINDS.includes(kind);
  return (
    <span className="inline-flex items-center gap-1">
      {url
        ? (external
          ? <a href={url} target="_blank" rel="noreferrer" className="hover:opacity-80">{body}</a>
          : <Link to={url} className="hover:opacity-80">{body}</Link>)
        : body}
      {resolved === false && (
        <Pill tone="warning" size="xs" title={reason}>{reason === 'unknown-kind' ? 'unknown kind' : 'missing'}</Pill>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center -my-3 rounded text-gray-500 hover:text-port-error" aria-label={`Remove ${text}`}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}
