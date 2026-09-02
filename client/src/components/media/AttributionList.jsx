import { licenseLabel, resolveAssetProvenance, rollupProvenance } from '../../lib/assetProvenance.js';

function SourceRow({ source }) {
  const label = source.name || source.id;
  const terms = licenseLabel(source.license);
  const kind = source.kind === 'lora' ? 'LoRA' : 'Model';
  return (
    <li className="flex flex-col gap-0.5">
      <span className="text-gray-200 break-all">
        <span className="text-gray-500 uppercase tracking-wide mr-1.5">{kind}</span>
        {source.sourceUrl ? (
          <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="text-port-accent hover:underline">
            {label}
          </a>
        ) : label}
      </span>
      <span className="text-gray-400">License: {terms}</span>
    </li>
  );
}

/**
 * Attribution & licenses. `records` is a collection (rollup); `record` is one
 * asset. Unknown licenses render as "unknown" — never a guessed permissive term.
 */
export default function AttributionList({ record, records, className = '' }) {
  const provenance = records
    ? rollupProvenance(records.map((item) => item?.raw || item))
    : resolveAssetProvenance(record?.raw || record);
  const sources = provenance?.sources || [];
  if (!sources.length) return null;
  return (
    <section className={className} aria-label="Attribution and licenses">
      <h3 className="text-gray-500 uppercase tracking-wide text-xs mb-1.5">Attribution &amp; licenses</h3>
      {provenance?.reconstructed && (
        <p className="text-[11px] text-gray-500 mb-1.5">
          This asset was not stamped at render time — licenses show as unknown.
        </p>
      )}
      <ul className="space-y-2 text-xs">
        {sources.map((source) => (
          <SourceRow key={`${source.kind}:${source.id}`} source={source} />
        ))}
      </ul>
    </section>
  );
}
