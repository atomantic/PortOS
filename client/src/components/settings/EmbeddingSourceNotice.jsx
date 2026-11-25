import { Link } from 'react-router';
import { Database } from 'lucide-react';
import ListLoadError from '../ui/ListLoadError';
import { useSocketResource } from '../../hooks/useSocketResource';
import { getEmbeddingConfig } from '../../services/apiMemory';
import { LOCAL_RUNTIME_LABELS } from '../../../../server/lib/modelPinMembership.js';

// No server event announces a settings.embeddings save; the resource still
// re-reads on reconnect and when the tab is shown again, which covers editing
// it on Models → Embeddings and coming back.
const NO_EVENTS = [];

const PROVIDER_LABELS = { ollama: LOCAL_RUNTIME_LABELS.ollama, lmstudio: LOCAL_RUNTIME_LABELS.lmstudio, none: 'Disabled' };

// One embedding configuration drives the catalog and memory (#18296): this is
// the read-only view every other surface shows, with the link to the single
// place it is edited. `inPlace` is that place itself (no self-link).
export default function EmbeddingSourceNotice({ inPlace = false, className = '' }) {
  const config = useSocketResource(
    ({ signal }) => getEmbeddingConfig({ signal, silent: true }),
    { events: NO_EVENTS },
  );
  const source = config.data;

  if (config.loading && !source) return null;
  if (!source) {
    return <ListLoadError what="the embedding configuration" error={config.error} onRetry={config.refetch} className={className} />;
  }

  const provider = PROVIDER_LABELS[source.provider] || source.provider;
  const model = source.model || 'auto-detected model';
  let summary;
  if (source.source === 'legacy') {
    summary = (
      <>
        Memory uses the legacy Chief of Staff embedding provider <strong>{provider}</strong> · <span className="font-mono">{model}</span>.
        Catalog embedding stays off until you save {inPlace ? 'here' : 'the shared embeddings setting'}, which then drives both.
      </>
    );
  } else if (source.disabled) {
    summary = <>Embeddings are <strong>disabled</strong> for the catalog and memory{source.error ? ` (${source.error})` : ''}.</>;
  } else {
    summary = (
      <>
        Catalog and memory embed with <strong>{provider}</strong> · <span className="font-mono">{model}</span>.
      </>
    );
  }

  return (
    <div className={`flex flex-wrap items-start gap-2 rounded-lg border border-port-border bg-port-bg px-3 py-2 text-xs text-port-text-muted ${className}`}>
      <Database size={14} className="mt-0.5 shrink-0 text-port-accent" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-words">{summary}</p>
      {!inPlace && (
        <Link
          to="/models/embeddings"
          className="inline-flex min-h-[32px] items-center rounded border border-port-border bg-port-card px-2 text-port-accent hover:text-white"
        >
          Configure embeddings
        </Link>
      )}
    </div>
  );
}
