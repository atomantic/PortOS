import Modal from '../ui/Modal';

// `target` is null (closed) or `{ stageName, isSystemStage, usedBy, referencedBy,
// canDelete }` — the stage plus its GET /api/prompts/:stage/usage body.
export default function DeleteStageModal({ target, onCancel, onConfirm }) {
  return (
    <Modal
      open={!!target}
      onClose={onCancel}
      size="sm"
      backdropClassName="bg-black/50"
      ariaLabelledBy="delete-stage-title"
    >
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <h3 id="delete-stage-title" className="text-lg font-medium text-white mb-3">
          {target?.canDelete === false
            ? (target.isSystemStage ? 'Delete System Stage?' : 'Delete Referenced Stage?')
            : 'Delete Stage?'}
        </h3>
        {/* Protected covers both the curated SYSTEM set and any stage the
            server's source references by name — the latter is badge-less but
            just as breakable, so it gets the same warning plus the files
            that name it (#3335). */}
        {target?.canDelete === false ? (
          <div className="space-y-2 mb-6">
            <p className="text-port-warning text-sm font-medium">
              "{target.stageName}" is {target.isSystemStage ? 'a system stage' : 'referenced by PortOS source'}.
            </p>
            {target.usedBy?.length > 0 && (
              <p className="text-gray-400 text-sm">Used by: {target.usedBy.join(', ')}</p>
            )}
            {target.referencedBy?.length > 0 && (
              <div className="text-gray-400 text-sm">
                <p className="mb-1">Referenced in:</p>
                <ul className="max-h-32 overflow-y-auto space-y-0.5 font-mono text-xs break-all">
                  {target.referencedBy.map((path) => <li key={path}>{path}</li>)}
                </ul>
              </div>
            )}
            <p className="text-gray-400 text-sm">Deleting this will break PortOS functionality.</p>
          </div>
        ) : (
          <p className="text-gray-400 text-sm mb-6">
            Delete "{target?.stageName}"? This cannot be undone.
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-gray-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 bg-port-error hover:bg-port-error/80 text-white rounded"
          >
            Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}
