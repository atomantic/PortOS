import Pill from '../ui/Pill';
import { formatCompactCount, timeAgo } from '../../utils/formatters';

// A free-tier token count that was never reported must never render as a
// confident zero: `—` means "the provider exposes no usage API and PortOS
// observed nothing", while a measured zero stays `0`. The `source` comes from
// the usage ledger (`measured` = the run's own event stream or transcript,
// anything else = estimated from prompt/stdout size).
function FreeTokens({ value, source }) {
  if (typeof value === 'number' && value > 0) {
    return <span className="text-white font-medium">{formatCompactCount(value)}</span>;
  }
  if (source === 'measured') {
    return <span className="text-white font-medium">0</span>;
  }
  return (
    <span
      className="text-gray-500"
      title="Not reported — this provider exposes no usage API, so PortOS tracks what its own runs observed"
    >
      —
    </span>
  );
}

const SOURCE_LABELS = {
  measured: { label: 'Measured', tone: 'success', title: 'Token counts read from the run itself' },
  mixed: { label: 'Part est.', tone: 'warning', title: 'Output tokens measured from the run, input estimated' },
  estimate: { label: 'Estimated', tone: 'context', title: 'Estimated from prompt length and captured output' }
};

function SourcePill({ source, className = '' }) {
  const meta = SOURCE_LABELS[source] || SOURCE_LABELS.estimate;
  return (
    <Pill tone={meta.tone} size="xs" className={className} title={meta.title}>{meta.label}</Pill>
  );
}

// Ledger volume since an observed block — the estimated-quota signal for a
// provider with no usage API: how much has run since it last refused.
function BlockVolume({ volume }) {
  if (!volume) return null;
  const queries = (volume.sessions || 0) + (volume.messages || 0);
  return (
    <span title="Ledger volume since this block — an estimate, not a provider reading">
      {formatCompactCount(queries)} queries · {formatCompactCount(volume.tokensIn || 0)} in /{' '}
      {formatCompactCount(volume.tokensOut || 0)} out since
    </span>
  );
}

function BlockRow({ block }) {
  return (
    <div className="py-1.5 border-b border-port-border last:border-0 text-xs sm:text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-white">
          {block.providerId}
          {block.model && <span className="font-mono text-gray-400"> · {block.model}</span>}
        </span>
        <span className="shrink-0 text-gray-500">{timeAgo(block.at ? new Date(block.at) : null, 'unknown time')}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] sm:text-xs text-gray-400">
        {block.resetHint && <span title="What the provider said about recovery">provider said: {block.resetHint}</span>}
        <BlockVolume volume={block.volumeSince} />
        {!block.volumeSince && <span className="text-gray-500">volume unknown</span>}
      </div>
    </div>
  );
}

function ProviderRow({ provider }) {
  return (
    <div className="py-1.5 border-b border-port-border last:border-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-white">{provider.name}</span>
          <Pill tone="success" size="xs" className="shrink-0 uppercase tracking-wide">Free</Pill>
          <SourcePill source={provider.source} className="shrink-0" />
        </div>
        <span className="shrink-0 text-xs text-gray-400">
          {formatCompactCount(provider.sessions || 0)} queries · {formatCompactCount(provider.messages || 0)} msgs
        </span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-gray-400">
        <div>
          <span className="block text-[10px] text-gray-500">Tokens (In / Out)</span>
          <FreeTokens value={provider.tokensIn} source={provider.source} />
          {' / '}
          <FreeTokens value={provider.tokensOut} source={provider.source} />
        </div>
        <div>
          <span className="block text-[10px] text-gray-500">Cache Read / Write</span>
          <FreeTokens value={provider.cacheReadTokens} source={provider.source} />
          {' / '}
          <FreeTokens value={provider.cacheWriteTokens} source={provider.source} />
        </div>
      </div>
      {(provider.models || []).length > 0 && (
        <div className="mt-1.5 space-y-1 border-t border-port-border/40 pt-1.5">
          {provider.models.map((m) => (
            <div key={m.model} className="flex items-center justify-between gap-2 text-xs text-gray-400">
              <span className="min-w-0 truncate font-mono text-[11px] text-gray-300" title={m.model}>{m.model}</span>
              <span className="flex shrink-0 items-center gap-2">
                <SourcePill source={m.source} />
                <span>{formatCompactCount((m.sessions || 0) + (m.messages || 0))} q</span>
                <FreeTokens value={m.tokensIn} source={m.source} />
                {'/'}
                <FreeTokens value={m.tokensOut} source={m.source} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Free-tier counterpart of the subscription-quota cards above it: queries and
// tokens per free-tier provider/model over the selected period, plus the
// observed limit blocks that stand in for a quota meter where the provider
// exposes no usage API. Everything here is ledger-derived — no provider call
// is made to build it (AI Provider Usage Policy), and every figure carries
// its measured/estimated provenance.
export default function FreeTierUsageCard({ freeTier }) {
  const providers = freeTier?.providers || [];
  const blocks = freeTier?.blocks || [];
  return (
    <div className="rounded-xl border border-port-border bg-port-card p-3 sm:p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-400">Free-tier usage</h3>
        <Pill tone="context" size="xs" title="Counts come from the PortOS usage ledger, not from a provider usage API — no provider calls were made">
          Ledger-tracked
        </Pill>
      </div>
      <p className="mb-2 text-[10px] text-gray-500 sm:text-xs">
        Queries and tokens on free-tier quotas (e.g. opencode zen) over the selected period — tracked locally because
        these providers expose no usage API. Unreported counts render as —, never 0.
      </p>
      {providers.length === 0 ? (
        <div className="py-2 text-sm text-gray-500">No free-tier usage recorded in this period.</div>
      ) : (
        <div aria-label="Free-tier provider usage">
          {providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </div>
      )}
      {blocks.length > 0 && (
        <div className="mt-3 border-t border-port-border pt-2">
          <h4 className="mb-1 text-xs font-medium text-gray-400">
            Observed blocks <span className="font-normal text-gray-500">— estimated quota signal, not a provider meter</span>
          </h4>
          <div aria-label="Observed free-tier blocks">
            {blocks.map((block, i) => (
              <BlockRow key={`${block.providerId}-${block.at}-${i}`} block={block} />
            ))}
          </div>
          <p className="mt-1 text-[10px] text-gray-500">
            A block is a usage-limit refusal PortOS actually saw. Transient retries are not blocks. Volume since a
            block is ledger-derived and understates providers whose runs carry no token counts.
          </p>
        </div>
      )}
    </div>
  );
}
