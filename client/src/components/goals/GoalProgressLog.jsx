import { NotebookPen, Plus, Clock, Trash2 } from 'lucide-react';
import { formatDurationMin } from '../../utils/formatters';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';

export default function GoalProgressLog({
  goal, showProgressForm, setShowProgressForm, progressForm, setProgressForm,
  handleAddProgress, resetProgressForm, handleDeleteProgress
}) {
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <NotebookPen className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-xs font-medium text-gray-400">
            Progress ({goal.progressLog?.length || 0})
          </span>
          {goal.progressLog?.length > 0 && (
            <span className="text-xs text-gray-600 ml-1">
              {goal.progressLog.reduce((sum, e) => sum + (e.durationMinutes || 0), 0)}min total
            </span>
          )}
        </div>
        <button
          onClick={() => setShowProgressForm(!showProgressForm)}
          className="p-0.5 text-gray-500 hover:text-port-accent"
          title="Log progress"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
      {showProgressForm && (
        <div className="space-y-1.5 mb-2 p-2 rounded bg-port-bg border border-port-border">
          <input
            type="date"
            value={progressForm.date}
            onChange={e => setProgressForm({ ...progressForm, date: e.target.value })}
            className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
          />
          <textarea
            value={progressForm.note}
            onChange={e => setProgressForm({ ...progressForm, note: e.target.value })}
            placeholder="What did you work on?"
            rows={2}
            className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white resize-none"
          />
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3 text-gray-500" />
            <input
              type="number"
              value={progressForm.durationMinutes}
              onChange={e => setProgressForm({ ...progressForm, durationMinutes: e.target.value })}
              placeholder="Minutes (optional)"
              min="1"
              max="1440"
              className="flex-1 bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
            />
          </div>
          <div className="flex gap-1">
            <button
              onClick={handleAddProgress}
              disabled={!progressForm.note.trim()}
              className="px-2 py-1 text-xs rounded bg-port-accent text-white disabled:opacity-50"
            >
              Log
            </button>
            <button
              onClick={resetProgressForm}
              className="px-2 py-1 text-xs rounded bg-port-border text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {goal.progressLog?.length > 0 && (
        <div className="space-y-1.5 max-h-40 overflow-y-auto">
          {[...goal.progressLog].reverse().map(entry => (
            <div key={entry.id}>
            <div className="flex items-start gap-2 text-xs group">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-gray-500">
                  <span>{new Date(entry.date + 'T00:00:00').toLocaleDateString()}</span>
                  {entry.durationMinutes && (
                    <span className="flex items-center gap-0.5">
                      <Clock className="w-3 h-3" />
                      {formatDurationMin(entry.durationMinutes)}
                    </span>
                  )}
                </div>
                <p className="text-gray-300 mt-0.5">{entry.note}</p>
              </div>
              <button
                onClick={() => requestDelete(entry.id)}
                className="p-0.5 text-gray-700 hover:text-red-400 opacity-40 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 shrink-0"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            {isConfirming(entry.id) && (
              <InlineConfirmRow
                className="mt-2"
                question="Delete this progress entry? This cannot be undone."
                confirmTitle="Confirm delete"
                cancelTitle="Cancel delete"
                onConfirm={() => confirmDelete(() => handleDeleteProgress(entry.id))}
                onCancel={cancelDelete}
              />
            )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
