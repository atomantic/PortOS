import { useEffect, useState } from 'react';
import * as api from '../../services/api';
import BrailleSpinner from '../BrailleSpinner';
import { formatCount, formatUsd, timeAgo } from '../../utils/formatters';

const COLUMNS = [
  { key: 'messages', label: 'Msgs' },
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'total', label: 'Total' },
  { key: 'estimatedCost', label: 'Est. API cost', format: formatUsd }
];

const Cells = ({ row, bold = false }) => (
  <>
    {COLUMNS.map((c) => (
      <td key={c.key} className={`py-1.5 px-2 text-right tabular-nums ${bold && c.format ? 'text-port-success' : ''}`}>
        {(c.format || formatCount)(row[c.key])}
      </td>
    ))}
  </>
);

function ModelTable({ models, totals }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs sm:text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-port-border">
            <th className="py-1.5 pr-2 font-medium">Model</th>
            {COLUMNS.map((c) => <th key={c.key} className="py-1.5 px-2 font-medium text-right whitespace-nowrap">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {models.map((row) => (
            <tr key={row.model} className="border-b border-port-border last:border-0 text-gray-300">
              <td className="py-1.5 pr-2 font-mono text-white whitespace-nowrap">{row.model}</td>
              <Cells row={row} />
            </tr>
          ))}
          <tr className="text-white font-medium">
            <td className="py-1.5 pr-2">Total</td>
            <Cells row={totals} bold />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Claude Code tokens per model across the fleet, priced at API rates, for the
 * same window as the cost report above. Each machine reads its own local CLI
 * transcripts (so it counts sessions run outside PortOS) and federates the
 * per-day totals; peers show as of their last sync.
 */
export default function ClaudeCodeModelTokensCard({ period, from, to, isCustom }) {
  // undefined = still loading, null = the read failed
  const [report, setReport] = useState(undefined);
  const loading = report === undefined;

  useEffect(() => {
    let cancelled = false;
    setReport(undefined);
    api.getClaudeCodeModelUsage(isCustom ? { from, to } : { period }, { silent: true })
      .catch(() => null)
      .then((data) => { if (!cancelled) setReport(data); });
    return () => { cancelled = true; };
  }, [period, from, to, isCustom]);

  const instances = report?.instances || [];
  const pending = report?.pendingInstances || [];

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-400">
          Claude Code tokens by model{instances.length > 1 ? ' — all instances' : ''}
        </h3>
        {loading && <BrailleSpinner />}
      </div>
      {report === null && <p className="text-xs text-port-error" role="alert">Could not read Claude Code usage.</p>}
      {report && report.models.length === 0 && (
        <p className="text-xs text-gray-500">No Claude Code usage found in this window.</p>
      )}
      {report && report.models.length > 0 && <ModelTable models={report.models} totals={report.totals} />}
      {instances.length > 1 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-gray-500">By instance</h4>
          {instances.map((i) => (
            <details key={i.instanceId} className="border border-port-border rounded-lg px-2 py-1">
              <summary className="cursor-pointer text-xs sm:text-sm text-white flex flex-wrap items-center justify-between gap-2">
                <span>
                  {i.name}{i.self ? ' (this machine)' : ''}
                  {!i.usesSubscriptions && <span className="text-port-warning"> · API-billed, not in total</span>}
                </span>
                <span className="text-gray-400 tabular-nums">
                  {formatCount(i.totals.total)} tokens · {formatUsd(i.totals.estimatedCost)}
                  {!i.self && <> · synced {timeAgo(new Date(i.capturedAt), 'unknown')}</>}
                </span>
              </summary>
              <div className="pt-2"><ModelTable models={i.models} totals={i.totals} /></div>
            </details>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <p className="text-xs text-port-warning">
          No token history yet from {pending.join(", ")} — it needs to update PortOS (or finish its first scan) before it appears here.
        </p>
      )}
      <p className="text-[10px] sm:text-xs text-gray-500">
        Read from each machine&rsquo;s local Claude Code session transcripts, so it includes sessions run outside PortOS, and
        history is kept after the CLI prunes old transcripts. Cost is an informational API-rate equivalent from the shared
        pricing table (cache reads and writes at their own tiers). Only Claude models are listed. Instances on an older PortOS build
        contribute nothing until they update. claude.ai and unfederated devices are not included.
      </p>
    </div>
  );
}
