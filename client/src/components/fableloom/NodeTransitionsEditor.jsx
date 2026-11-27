import { GitBranch, Loader2, Trash2 } from 'lucide-react';
import { fieldClass } from './fieldStyles';

export default function NodeTransitionsEditor({
  form, audienceConnected, otherNodes, aiBlocked, addingPath, runBranch, branching,
  addTransition, applyTransition, saveTransition, removeTransition,
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-port-text-muted">
          {form.playbackMode === 'cut' ? 'Next cut' : 'Viewer paths'} ({form.transitions.length})
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={runBranch}
            disabled={branching || aiBlocked || !audienceConnected}
            title={!audienceConnected ? 'Connect the audience communication medium before adding decision branches' : undefined}
            className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50"
          >
            {branching ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
            Branch with AI
          </button>
          <button
            type="button"
            onClick={addTransition}
            disabled={addingPath}
            className="text-xs text-port-accent hover:underline disabled:opacity-50"
          >
            + Add path
          </button>
        </div>
      </div>
      {form.isEnding && form.transitions.length > 0 && (
        <p className="text-xs text-port-warning mb-2">Endings never fire their outgoing paths.</p>
      )}
      {!form.isEnding && form.playbackMode === 'cut' && form.transitions.length !== 1 && (
        <p className="text-xs text-port-error mb-2">Automatic cuts need exactly one path to the next cut.</p>
      )}
      <div className="space-y-3">
        {form.transitions.map((tr, index) => (
          <div key={tr.id} className="border border-port-border rounded p-2 space-y-2">
            <div className="flex items-center gap-2">
              <input
                className={fieldClass}
                placeholder='Reader intent, e.g. "search the wreck"'
                aria-label="Intent"
                value={tr.intent}
                onChange={(e) => applyTransition(index, { intent: e.target.value })}
                onBlur={() => saveTransition(tr)}
              />
              <button
                type="button"
                onClick={() => removeTransition(tr)}
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-text-muted hover:text-port-error shrink-0"
                aria-label="Remove path"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <select
              className={fieldClass}
              aria-label="Leads to scene"
              value={tr.targetNodeId}
              onChange={(e) => applyTransition(index, { targetNodeId: e.target.value }, { save: true })}
            >
              {otherNodes.map((n) => (
                <option key={n.id} value={n.id}>{n.title || 'Untitled scene'}</option>
              ))}
            </select>
            <input
              className={fieldClass}
              placeholder="Example phrasings, separated by ;"
              aria-label="Trigger phrasings"
              value={tr.triggersText}
              onChange={(e) => applyTransition(index, { triggersText: e.target.value })}
              onBlur={() => saveTransition(tr)}
            />
          </div>
        ))}
        {!form.transitions.length && !form.isEnding && (
          <p className="text-xs text-port-warning">
            No paths out — mark this an ending or add a path.
          </p>
        )}
      </div>
    </div>
  );
}
