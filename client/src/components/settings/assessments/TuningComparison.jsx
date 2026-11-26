

/**
 * Which launch tuning won, per model.
 *
 * Only rendered for models measured under two or more tunings — one reading is
 * not a comparison, and presenting it as "the best tuning" would dress a single
 * measurement up as a conclusion. The server enforces the same rule.
 */
export default function TuningComparison({ rows, runtimeLabelFor }) {
  if (!rows?.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-gray-400">Tuning comparison</h3>
      <p className="text-[11px] text-gray-500">
        Throughput of each launch configuration, relative to the best one measured for that model.
        The comparison uses exact tokens/s when every variant reports tokenizer counts; otherwise it
        uses chars/s so estimates and missing usage do not decide the winner.
      </p>
      {rows.map((row) => (
        <div key={`${row.backend}:${row.modelId}`} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-white font-mono break-all">{row.modelId}</span>
            <span className="text-[10px] text-gray-500">{runtimeLabelFor(row.backend)}</span>
          </div>
          {row.variants.map((variant, index) => (
            <div key={`${row.backend}:${row.modelId}@${variant.label}`} className="grid grid-cols-[1fr_auto] gap-2 items-center text-[11px]">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={index === 0 ? 'text-emerald-400' : 'text-gray-300'}>{variant.label}</span>
                  {index === 0 && <span className="text-[10px] text-emerald-400/70">best</span>}
                </div>
                <span className="inline-block w-full max-w-[220px] h-1.5 rounded bg-port-border overflow-hidden align-middle">
                  <span
                    className={`block h-full ${index === 0 ? 'bg-emerald-400' : 'bg-port-accent'}`}
                    style={{ width: `${Math.max(2, Math.round(variant.deltaPercent ?? 0))}%` }}
                  />
                </span>
              </div>
              <div className="text-right text-gray-400 shrink-0">
                {Number.isFinite(variant.rate)
                  ? `${variant.rate} ${row.metricLabel || (row.metric === 'tokensPerSecond' ? 'tokens/s' : 'chars/s')}`
                  : 'not measured'}
                <span className="text-gray-600 ml-1.5">{variant.deltaPercent}%</span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
