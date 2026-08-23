/**
 * Tokens-per-second and test-time report.
 *
 * The ranked list above it answers "which model should I use?". This answers
 * "how fast is each one, and where does it fall off?" — one row per measured
 * model+tuning, with the per-context readings side by side, which is what you
 * actually read the morning after an overnight sweep.
 *
 * ## Two things this must never do
 *
 * 1. **Never derive tokens from characters.** PortOS has no tokenizer. Every
 *    figure here comes from the daemon's own usage block, or (labelled `~`) from
 *    counting streamed frames. A blank cell means NOT MEASURED — never zero, and
 *    never chars/s wearing a tok/s label.
 * 2. **Never hide a model because its runtime is quiet.** A runtime that reports
 *    no token counts still gets a row, with its chars/s figure and an explicit
 *    "no token counts" note. Dropping it would make the table look complete.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Timer, Copy, Check } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';
import { tuningNoticeChip } from '../../lib/assessmentTuningNotice';
import { formatContextTokens, formatDurationMs, formatRuntime } from '../../utils/formatters';

// One rate, as text. `null` is not measured and renders as an em dash — never a
// zero; `estimated` marks a frame-counted figure with a `~` so it is never
// mistaken for one the daemon's own tokenizer produced. Shared by the table and
// the markdown serializer so a formatting change lands in both.
const rateText = (value, estimated) =>
  (Number.isFinite(value) ? `${estimated ? '~' : ''}${value.toFixed(1)}` : '—');

const Rate = ({ value, estimated, suffix = '' }) => (
  Number.isFinite(value)
    ? <span className="text-gray-200 whitespace-nowrap">{rateText(value, estimated)}{suffix}</span>
    : <span className="text-gray-600">{rateText(value, estimated)}</span>
);

// Per-context tests can be shorter than a second, so use the formatter that
// preserves milliseconds rather than the coarse multi-second formatter used by
// summary cards. A finite zero is still an observed duration, not an unknown.
const elapsedText = (value) => {
  if (!Number.isFinite(value) || value < 0) return '—';
  return formatRuntime(value) || '0ms';
};

const timingLabel = (source) => ({
  runtime: 'runtime timing',
  'stream-window': 'observed stream window',
  'wall-clock': 'end-to-end wall clock',
  mixed: 'mixed timing basis',
}[source] || 'timing basis unavailable');

// A row's samples keyed by context, for the per-context columns.
const pointsByContext = (row) => new Map((row.points || []).map((p) => [p.contextTokens, p]));

const contextMarkdown = (point, estimated) => {
  if (!point) return '—';
  if (!point.ok) {
    const elapsed = elapsedText(point.totalMs);
    return elapsed === '—' ? 'failed' : `failed (${elapsed})`;
  }
  return `${rateText(point.tokensPerSecond, estimated)} (${elapsedText(point.totalMs)})`;
};

/** The report as a markdown table — what a copy of this is actually useful as. */
export function toMarkdown(report) {
  const contexts = report?.contexts || [];
  const header = ['Model', 'Runtime', 'Tuning', 'Rate basis', 'tok/s', 'chars/s', 'Prefill tok/s', 'TTFT', ...contexts.map((c) => `${formatContextTokens(c)} tok/s / elapsed`)];
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  for (const row of report?.rows || []) {
    const byContext = pointsByContext(row);
    lines.push(`| ${[
      row.modelId,
      row.backend,
      row.tuningLabel || 'backend defaults',
      timingLabel(row.timingSource),
      rateText(row.meanTokensPerSecond, row.tokensEstimated),
      rateText(row.meanCharsPerSecond, false),
      rateText(row.meanPromptTokensPerSecond, row.tokensEstimated),
      Number.isFinite(row.meanTtftMs) ? formatDurationMs(row.meanTtftMs) : '—',
      ...contexts.map((c) => contextMarkdown(byContext.get(c), row.tokensEstimated)),
    ].join(' | ')} |`);
  }
  return lines.join('\n');
}

export default function ModelThroughputReport({ report, runtimeLabelFor }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);
  const contexts = report?.contexts || [];
  const rows = report?.rows || [];
  // Indexed once per report rather than per render: the `copied` toggle alone
  // would otherwise rebuild one Map per row for nothing.
  const indexed = useMemo(() => rows.map((row) => ({ row, byContext: pointsByContext(row) })), [rows]);

  if (!rows.length) return null;

  const copy = async () => {
    // Serialized on the click, not on every report change — nothing else needs
    // the markdown, and a sweep re-reports after every model it finishes.
    // The button owns its own "Copied" state, so the success toast would be a
    // second confirmation of the same thing (client/src/lib/clipboard.js).
    const ok = await copyToClipboard(toMarkdown(report), null);
    if (!ok) return;
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-xs font-medium text-gray-400 flex items-center gap-1.5">
          <Timer size={12} /> Tokens per second / test time
        </h3>
        <button
          onClick={copy}
          className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white transition-colors"
          aria-label="Copy the throughput report as a markdown table"
        >
          {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy table</>}
        </button>
      </div>
      <p className="text-[11px] text-gray-500">
        Generation speed after the first token — exact tokens/s when the runtime reports usage, with chars/s
        beside it as the universal cross-runtime fallback. Prefill speed (how fast the prompt was read) and
        time to first token are beside them, so a model that decodes fast but chews slowly through long context
        is visible as such. Each context column shows its throughput on top and the total elapsed time for
        that individual test below it.
        {report.modelsWithTokenRates < rows.length && (
          <> A <span className="text-gray-400">—</span> means the runtime reported no token counts for that
          reading; its chars/s figure is in the ranked list above.</>
        )}
        {rows.some((row) => row.timingSource === 'wall-clock') && (
          <> Some local endpoints expose exact token counts but no decode duration; those rates use end-to-end wall clock and are marked below.</>
        )}
      </p>

      {/* Wide by nature — one column per sampled context. Scrolls inside its own
          box so the page body never scrolls sideways on a phone. */}
      <div className="overflow-x-auto border border-port-border rounded-lg">
        <table className="w-full text-[11px] min-w-[560px]">
          <thead>
            <tr className="text-gray-500 border-b border-port-border">
              <th scope="col" className="text-left font-medium px-2 py-1.5">Model</th>
              <th scope="col" className="text-right font-medium px-2 py-1.5 whitespace-nowrap">Rate basis</th>
              <th scope="col" className="text-right font-medium px-2 py-1.5 whitespace-nowrap">tok/s</th>
              <th scope="col" className="text-right font-medium px-2 py-1.5 whitespace-nowrap">chars/s</th>
              <th scope="col" className="text-right font-medium px-2 py-1.5 whitespace-nowrap">Prefill</th>
              <th scope="col" className="text-right font-medium px-2 py-1.5 whitespace-nowrap">TTFT</th>
              {contexts.map((context) => (
                <th key={context} scope="col" className="text-right font-medium px-2 py-1.5 whitespace-nowrap">
                  <div>{formatContextTokens(context)}</div>
                  <div className="text-[10px] font-normal text-gray-600">rate / elapsed</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {indexed.map(({ row, byContext }) => (
                <tr key={`${row.backend}:${row.modelId}@${row.tuningKey}`} className="border-b border-port-border/50 last:border-0">
                  <td className="px-2 py-1.5 min-w-0">
                    <div className="text-gray-200 font-mono break-all">{row.modelId}</div>
                    <div className="text-[10px] text-gray-500">
                      {runtimeLabelFor?.(row.backend) || row.backend}
                      <span className="mx-1">·</span>
                      {row.tuningLabel || 'backend defaults'}
                      <span className="mx-1">·</span>
                      <span className={row.timingSource === 'wall-clock' ? 'text-port-warning' : ''} title="How the runtime timing was obtained">
                        {timingLabel(row.timingSource)}
                      </span>
                      {row.staleness?.stale && <span className="ml-1 text-port-warning">stale</span>}
                      {/* The numbers are real but describe a configuration nobody
                          asked for — say so here too, not only in the ranked list. */}
                      {tuningNoticeChip(row) && <span className="ml-1 text-port-warning">{tuningNoticeChip(row)}</span>}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right text-gray-500 whitespace-nowrap">{timingLabel(row.timingSource)}</td>
                  <td className="px-2 py-1.5 text-right"><Rate value={row.meanTokensPerSecond} estimated={row.tokensEstimated} /></td>
                  <td className="px-2 py-1.5 text-right"><Rate value={row.meanCharsPerSecond} estimated={false} /></td>
                  <td className="px-2 py-1.5 text-right"><Rate value={row.meanPromptTokensPerSecond} estimated={row.tokensEstimated} /></td>
                  <td className="px-2 py-1.5 text-right text-gray-200 whitespace-nowrap">
                    {Number.isFinite(row.meanTtftMs) ? formatDurationMs(row.meanTtftMs) : <span className="text-gray-600">—</span>}
                  </td>
                  {contexts.map((context) => {
                    const point = byContext.get(context);
                    return (
                      <td
                        key={context}
                        className="px-2 py-1.5 text-right"
                        // A context that FAILED is different from one that was
                        // never sampled — the title says which, and why.
                        title={point && !point.ok ? (point.error || 'failed') : undefined}
                      >
                        <div className="flex flex-col items-end gap-0.5">
                          {point && !point.ok
                            ? <span className="text-port-warning">failed</span>
                            : <Rate value={point?.tokensPerSecond} estimated={row.tokensEstimated} />}
                          {point && (
                            <span
                              className="text-gray-500 whitespace-nowrap"
                              title="Total elapsed time for this context test"
                            >
                              {elapsedText(point.totalMs)}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.some((r) => r.tokensEstimated) && (
        <p className="text-[10px] text-gray-600">
          <span className="text-gray-400">~</span> counted from streamed frames — that runtime reported no
          usage block, so the token count is an approximation, not its tokenizer&apos;s.
        </p>
      )}
    </div>
  );
}
