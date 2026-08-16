import { Box, Download, HardDrive, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import MemoryManagement from '../settings/MemoryManagement.jsx';
import CleanupControl from './CleanupControl.jsx';
import { formatBytes } from '../../utils/formatters.js';

const BACKEND_LABEL = {
  huggingface: 'Hugging Face',
  lora: 'LoRA',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

function InventoryEmpty({ loading, onRun }) {
  return (
    <section className="rounded-2xl border border-dashed border-port-accent/40 bg-port-accent/5 px-5 py-7 text-center">
      <Download className="mx-auto mb-3 text-port-accent" size={25} />
      <h3 className="font-semibold text-white">Inventory downloaded models</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm text-gray-400">Scan Hugging Face, LoRA, Ollama, and LM Studio storage to see what is installed.</p>
      <button
        type="button"
        onClick={onRun}
        disabled={loading}
        className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white hover:bg-port-accent/80 disabled:opacity-50"
      >
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        {loading ? 'Scanning…' : 'Run model inventory'}
      </button>
    </section>
  );
}

export default function ModelsPanel({ report, loading, onRunReport, cleanup }) {
  const candidates = new Map((report?.cleanupCandidates || []).map((item) => [item.id, item]));

  return (
    <div className="space-y-4">
      <MemoryManagement />

      {!report ? <InventoryEmpty loading={loading} onRun={onRunReport} /> : (
        <section className="rounded-2xl border border-port-border bg-port-card p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <HardDrive size={17} className="text-port-accent" />
                <h3 className="font-semibold text-white">Downloaded model inventory</h3>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {report.models.downloaded.length} item{report.models.downloaded.length === 1 ? '' : 's'} · {formatBytes(report.models.totals.all)} known model storage
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link to="/media/models" className="min-h-[36px] rounded-lg border border-port-border px-3 py-2 text-xs text-gray-300 hover:bg-port-border/40">Media models</Link>
              <Link to="/settings/local-llm" className="min-h-[36px] rounded-lg border border-port-border px-3 py-2 text-xs text-gray-300 hover:bg-port-border/40">Local LLM settings</Link>
              <button
                type="button"
                onClick={onRunReport}
                disabled={loading}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-2 text-xs text-gray-300 hover:bg-port-border/40 disabled:opacity-50"
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {report.models.downloaded.length === 0 ? (
              <p className="rounded-xl bg-port-bg/40 p-4 text-sm text-gray-500">No downloaded models were found in the known stores.</p>
            ) : report.models.downloaded.map((model) => {
              const candidate = candidates.get(model.id) || {
                ...model,
                label: model.name,
                estimatedBytes: model.sizeBytes,
                action: null,
                manualOnly: true,
              };
              return (
                <div key={model.id} className="flex flex-col gap-3 rounded-xl bg-port-bg/40 p-3 sm:flex-row sm:items-center">
                  <div className="rounded-lg bg-port-accent/10 p-2 text-port-accent"><Box size={16} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-gray-200">{model.name}</span>
                      <span className="rounded bg-port-border px-1.5 py-0.5 text-[10px] uppercase text-gray-400">{BACKEND_LABEL[model.backend] || model.backend}</span>
                      {model.loaded && <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] uppercase text-purple-300">loaded</span>}
                    </div>
                    {model.detail && <p className="mt-0.5 truncate text-xs text-gray-500">{model.detail}</p>}
                  </div>
                  <div className="text-sm font-semibold tabular-nums text-white">
                    {Number.isFinite(model.sizeBytes) ? `${model.sizeIsEstimate ? '≈' : ''}${formatBytes(model.sizeBytes)}` : 'Size unavailable'}
                  </div>
                  <CleanupControl
                    candidate={candidate}
                    busy={cleanup.busyId === candidate.id}
                    confirming={cleanup.isConfirming(candidate.id)}
                    onRequest={() => cleanup.request(candidate.id)}
                    onCancel={cleanup.cancel}
                    onConfirm={() => cleanup.confirm(candidate)}
                  />
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-gray-600">≈ Size is an upper-bound estimate when model tags may share underlying layers.</p>
        </section>
      )}
    </div>
  );
}
