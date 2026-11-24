import { Star, Copy } from 'lucide-react';
import MediaUsageList from './MediaUsageList';
import { formatDateNumeric } from '../../utils/formatters';

const COPYABLE_META = ['Codex session'];

export function PeerNotes({ others }) {
  if (!Array.isArray(others) || others.length === 0) return null;
  return (
    <div>
      <div className="mb-1">
        <span className="text-gray-500 uppercase tracking-wide text-xs">Notes from others</span>
      </div>
      <ul className="space-y-2">
        {others.map((o) => (
          <li key={o.instanceId} className="rounded border border-port-border bg-port-bg/50 p-2">
            <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
              <span className="flex items-center gap-1.5 text-gray-300">
                {o.starred && <Star className="w-3 h-3 fill-current text-port-warning" />}
                <span>{o.authorName || 'Unknown'}</span>
              </span>
              <span>{formatDateNumeric(o.updatedAt)}</span>
            </div>
            {o.note && <p className="text-gray-200 whitespace-pre-wrap text-xs">{o.note}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Where this file is used, each row a link there (the shot, panel or record tab).
// `usages` comes from the pane's single useMediaUsages() subscription.
export function UsedIn({ usages, onClose }) {
  if (!usages?.length) return null;
  return (
    <div>
      <span className="block mb-1 text-gray-500 uppercase tracking-wide">Used in</span>
      <MediaUsageList usages={usages} onNavigate={onClose} />
    </div>
  );
}

export function NegativePrompt({ item, copy }) {
  if (!item.negativePrompt) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-gray-500 uppercase tracking-wide">Negative</span>
        <button
          type="button"
          onClick={() => copy(item.negativePrompt, 'Negative prompt')}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
          title="Copy negative prompt" aria-label="Copy negative prompt"
        >
          <Copy className="w-3 h-3" />
        </button>
      </div>
      <p className="text-gray-300 whitespace-pre-wrap">{item.negativePrompt}</p>
    </div>
  );
}

// Segmented control to swap between an image and its cleaned copies.
export function VariantSwitch({ item, variantGroup, onSelectVariant }) {
  if (!variantGroup || !onSelectVariant) return null;
  return (
    <div>
      <div className="text-gray-500 uppercase tracking-wide text-xs mb-1">View</div>
      <div className="flex items-stretch rounded overflow-hidden border border-port-border">
        {variantGroup.group.map((entry) => {
          const isActive = entry.item.filename === item.filename;
          return (
            <button
              key={entry.item.filename}
              type="button"
              onClick={() => { if (!isActive) onSelectVariant(entry.item); }}
              aria-pressed={isActive}
              className={`flex-1 px-2 py-1.5 text-xs border-r border-port-border last:border-r-0 transition-colors ${
                isActive
                  ? 'bg-port-accent text-white cursor-default'
                  : 'bg-port-bg text-gray-300 hover:text-white hover:bg-port-border/50'
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function MetaList({ item, meta, copy }) {
  if (meta.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
      {meta.map(([k, v]) => {
        const copyable = (k === 'Seed' && item.seed != null) || COPYABLE_META.includes(k);
        return (
          <div key={k} className="contents">
            <dt className="text-gray-500">{k}</dt>
            <dd className="text-gray-200 break-all flex items-center gap-1.5">
              <span>{String(v)}</span>
              {copyable && (
                <button
                  type="button"
                  onClick={() => copy(String(v), k)}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-0.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
                  title={`Copy ${k.toLowerCase()}`} aria-label={`Copy ${k.toLowerCase()}`}
                >
                  <Copy className="w-3 h-3" />
                </button>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
