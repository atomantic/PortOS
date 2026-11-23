import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import toast from '../ui/Toast';
import { getRetiredDataInventory, deleteRetiredData } from '../../services/apiLoraTraining.js';
import { formatBytes, formatCount } from '../../utils/formatters';

// Leftovers of the retired LoRA-training feature (#13536). Rendered only while
// either allowlisted directory still holds data, so a clean install never sees it.
// A caller without host control gets a refused inventory read and sees nothing.
export default function RetiredTrainingData() {
  const [rows, setRows] = useState([]);
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let active = true;
    getRetiredDataInventory()
      .then((items) => { if (active) setRows(items.filter((item) => item.status !== 'absent' && item.deletable)); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  if (rows.length === 0) return null;

  async function remove(row) {
    setBusyId(row.id);
    const result = await deleteRetiredData(row.id).catch(() => null);
    setBusyId(null);
    if (!result) return;
    setConfirmId(null);
    const left = result.status === 'retained' ? ' New files appeared during removal; they remain.' : result.status === 'unavailable' ? ' Remaining files could not be read; reload to check.' : '';
    toast.success(`Deleted ${formatCount(result.removedFiles)} ${result.removedFiles === 1 ? 'file' : 'files'} (${formatBytes(result.removedBytes)}) from ${row.path}.${left}`);
    setRows((previous) => result.status === 'retained' || result.status === 'unavailable'
      ? previous.map((item) => item.id === row.id ? { ...item, bytes: result.remainingBytes, files: result.remainingFiles, status: result.status, actions: result.status === 'retained' ? ['delete'] : [] } : item)
      : previous.filter((item) => item.id !== row.id));
  }

  return (
    <section aria-labelledby="retired-training-data" className="mt-8">
      <h2 id="retired-training-data" className="text-lg font-semibold text-white mb-1">Retired training data</h2>
      <p className="text-sm text-gray-400 mb-3">LoRA training is retired. These files remain until you delete them; PortOS does not convert them to reference images. Installed adapters above are not affected.</p>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="bg-port-card border border-port-border rounded-lg p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-medium text-white text-sm">{row.label}</h3>
                <p className="text-xs text-gray-400"><code>{row.path}</code> · {row.bytes === null ? 'Size unavailable' : `${formatBytes(row.bytes)} · ${formatCount(row.files)} files`}</p>
              </div>
              {row.actions.includes('delete') && confirmId !== row.id && (
                <button
                  type="button"
                  onClick={() => setConfirmId(row.id)}
                  className="min-h-9 flex items-center gap-2 text-xs text-port-error border border-port-border rounded px-3 hover:bg-port-error/10"
                >
                  <Trash2 size={14} aria-hidden="true" />Delete {row.label}
                </button>
              )}
            </div>
            {row.error && <p role="alert" className="text-xs text-port-error">{row.error}</p>}
            {confirmId === row.id && (
              <InlineConfirmRow
                aria-label={`Confirm deleting ${row.label}`}
                autoFocus
                question={`Permanently delete ${row.path} (${formatBytes(row.bytes)}, ${formatCount(row.files)} files)? ${row.warning} This cannot be undone.`}
                confirmText={busyId === row.id ? 'Deleting…' : 'Delete permanently'}
                onConfirm={() => { if (busyId === null) void remove(row); }}
                onCancel={() => { if (busyId === null) setConfirmId(null); }}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
