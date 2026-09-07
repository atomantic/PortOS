import { useMemo } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ArrowRightLeft, FlaskConical, RefreshCw, Trash2 } from 'lucide-react';
import { localLlmTargetKey } from '../../lib/localLlmTargetKey.js';
import { formatBytes, formatContextLength } from '../../utils/formatters.js';
import BrailleSpinner from '../BrailleSpinner.jsx';
import CapabilityBadges from '../models/CapabilityBadges.jsx';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';

const redownloadInstallId = (model, backend) => {
  if (backend !== 'lmstudio') return model.id;
  if (/@/.test(model.id || '')) return model.id;
  return model?.quantization ? `${model.id}@${model.quantization}` : null;
};

export default function LocalLlmInstalledModels({
  actionInProgress,
  backend,
  busy,
  cancelDelete,
  compareTargets,
  confirmDelete,
  install,
  isConfirmingDelete,
  models,
  onCompare,
  onToggleCompare,
  remove,
  requestDelete,
}) {
  const compareTargetKeys = useMemo(
    () => new Set(compareTargets.map(localLlmTargetKey)),
    [compareTargets],
  );

  return (
    <div className="space-y-2 pt-2 border-t border-port-border/50">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-xs font-medium text-gray-400">Installed on {backend === 'ollama' ? 'Ollama' : 'LM Studio'} ({models.length})</h3>
        {compareTargets.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">{compareTargets.length} selected</span>
            <button
              onClick={onCompare}
              disabled={compareTargets.length < 2}
              className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 flex items-center gap-1"
            >
              <ArrowRightLeft size={12} />
              Compare selected
            </button>
          </div>
        )}
      </div>
      {models.length === 0 ? (
        <p className="text-xs text-gray-500">No models installed yet.</p>
      ) : models.map((model) => {
        const redownloadId = redownloadInstallId(model, backend);
        return (
          <div key={model.id} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 bg-port-bg border border-port-border rounded-lg p-3">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <label className="shrink-0 flex items-center pt-0.5" title={`Include ${model.name || model.id} in a comparison`}>
                <input
                  type="checkbox"
                  checked={compareTargetKeys.has(localLlmTargetKey({ backend, modelId: model.id }))}
                  onChange={() => onToggleCompare(backend, model.id)}
                  className="h-4 w-4 accent-port-accent"
                  aria-label={`Select ${model.name || model.id} for comparison`}
                />
              </label>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white break-all">{model.name}</div>
                {model.reducedSafeguards && (
                  <p className="flex gap-1 text-xs text-port-warning" role="note"><AlertTriangle size={14} className="shrink-0" aria-hidden="true" />{model.warning}</p>
                )}
                <div className="text-xs text-gray-500 break-words">
                  {[
                    model.params,
                    model.quantization,
                    model.family,
                    formatContextLength(model.contextLength),
                    model.size != null ? formatBytes(model.size) : null,
                  ].filter(Boolean).join(' · ')}
                </div>
                {(model.capabilities || []).length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap mt-1">
                    <CapabilityBadges capabilities={model.capabilities} />
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 justify-end flex-wrap">
              <Link
                to={`/local-llm/playground?backend=${encodeURIComponent(backend)}&model=${encodeURIComponent(model.id)}`}
                className="px-2.5 py-1 text-xs bg-port-accent-2/15 hover:bg-port-accent-2/25 text-port-accent-2 rounded flex items-center gap-1 shrink-0 no-underline"
                title={`Chat with ${model.name || model.id}`}
              >
                <FlaskConical size={12} />
                Chat
              </Link>
              {redownloadId && (
                <button
                  onClick={() => install(redownloadId, { force: true })}
                  disabled={busy}
                  title="Pull this build again. Updated GGUF files keep the same name, so an existing install will not refresh until you redownload."
                  className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 flex items-center gap-1 shrink-0"
                  aria-label={`Redownload ${model.name || model.id}`}
                >
                  {actionInProgress === `install-${redownloadId}` ? <BrailleSpinner /> : <RefreshCw size={12} />}
                  Redownload
                </button>
              )}
              {isConfirmingDelete(model.id) ? (
                <ConfirmButtonPair
                  prompt="Delete?"
                  confirmIcon={Trash2}
                  busy={busy}
                  className="shrink-0"
                  onConfirm={() => confirmDelete(() => remove(model.id))}
                  onCancel={cancelDelete}
                />
              ) : (
                <button
                  onClick={() => requestDelete(model.id)}
                  disabled={busy}
                  className="px-2.5 py-1 text-xs bg-port-error/20 hover:bg-port-error/40 text-port-error rounded disabled:opacity-50 flex items-center gap-1 shrink-0"
                  aria-label={`Delete ${model.name}`}
                >
                  {actionInProgress === `delete-${model.id}` ? <BrailleSpinner /> : <Trash2 size={12} />}
                  Delete
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
