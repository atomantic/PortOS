import { useRef } from 'react';
import { FolderOpen, ArrowLeft, Edit3, Save, Trash2, X, BookOpen } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner.jsx';
import InlineConfirmRow from '../ui/InlineConfirmRow.jsx';
import ForceSaveNoteRow from '../ForceSaveNoteRow.jsx';
import { timeAgo, formatBytes } from '../../utils/formatters.js';

export default function NoteDetailPane({
  selectedNote, loading, error, onRetry, onBack, backLabel = 'Back', headerBackLabel = backLabel,
  editing, onSetEditing, noteContent, onSetContent, saving, onSave,
  confirmingDelete, onRequestDelete, onDelete, onCancelDelete,
  forceOffered, dismissForce, renderPreview, renderLinks,
  emptyIcon: EmptyIcon = BookOpen, emptyLabel = 'Select a note to view',
  emptyHint, cancelLabel = 'Close editor',
}) {
  const editorRef = useRef(null);
  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <BrailleSpinner text="Loading" />
    </div>
  );
  if (error) return (
    <div className="flex flex-col items-center justify-center gap-3 h-full p-4">
      <button type="button" onClick={onBack}
        className="inline-flex min-h-[44px] items-center gap-2 rounded px-3 text-sm text-port-accent hover:text-white">
        <ArrowLeft size={16} aria-hidden="true" /> {backLabel}
      </button>
      <div role="alert" className="rounded-lg border border-port-error/40 bg-port-error/10 p-4 text-sm text-gray-300">
        <p className="font-medium text-port-error">Note is unavailable</p>
        <p className="mt-1 text-gray-400">This note could not be read, so its contents were not replaced with an empty view.</p>
        <button type="button" onClick={onRetry}
          className="mt-3 min-h-[44px] rounded bg-port-card px-3 text-port-accent hover:text-white">Retry</button>
      </div>
    </div>
  );
  if (!selectedNote) return (
    <div className="flex flex-col items-center justify-center h-full text-gray-500">
      <EmptyIcon size={48} className="mb-3 opacity-30" />
      <p className="text-sm">{emptyLabel}</p>
      {emptyHint && <p className="text-xs mt-1">{emptyHint}</p>}
    </div>
  );
  return (
          <>
            {/* Note header */}
            <div className="px-4 py-3 border-b border-port-border flex items-center gap-3">
              <button
                onClick={onBack}
                aria-label={headerBackLabel}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded hover:bg-port-card text-gray-400 hover:text-white md:hidden"
              >
                <ArrowLeft size={16} />
              </button>
              <div className="flex-1 min-w-0">
                <h2 className="text-white font-medium truncate">{selectedNote.name}</h2>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  {selectedNote.folder && (
                    <span className="flex items-center gap-1">
                      <FolderOpen size={10} />
                      {selectedNote.folder}
                    </span>
                  )}
                  <span>Modified {timeAgo(selectedNote.modifiedAt)}</span>
                  <span>{formatBytes(selectedNote.size)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {editing ? (
                  <>
                    <button
                      onClick={() => onSave()}
                      disabled={saving}
                      className="flex items-center gap-1 px-3 py-1.5 rounded bg-port-accent text-white text-sm hover:bg-port-accent/80 disabled:opacity-50"
                    >
                      <Save size={14} />
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={() => { onSetEditing(false); onSetContent(selectedNote.content); }}
                      aria-label={cancelLabel}
                      className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center"
                    >
                      <X size={16} />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => onSetEditing(true)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded bg-port-card text-gray-300 text-sm hover:text-white hover:bg-port-border"
                  >
                    <Edit3 size={14} />
                    Edit
                  </button>
                )}
                <button
                  onClick={() => onRequestDelete(selectedNote.path)}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-port-error"
                  title="Delete note" aria-label="Delete note"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {/* Delete confirmation */}
            {confirmingDelete && (
              <InlineConfirmRow
                variant="separator"
                question="Delete this note permanently?"
                onConfirm={() => onDelete(selectedNote.path)}
                onCancel={onCancelDelete}
              />
            )}

            {/* Editor-only: outside edit mode there is no buffer the user meant to
                write, and a stray "Save anyway" click would still issue the risky
                forced write. */}
            <ForceSaveNoteRow
              offered={editing && forceOffered}
              onConfirm={() => onSave({ force: true })}
              onCancel={dismissForce}
            />

            {/* Note content */}
            <div className="flex-1 min-h-0 overflow-auto flex">
              {/* Main content area */}
              <div className="flex-1 min-w-0">
                {editing ? (
                  <textarea
                    aria-label="Note content"
                    ref={editorRef}
                    value={noteContent}
                    onChange={e => onSetContent(e.target.value)}
                    className="w-full h-full p-4 bg-port-bg text-gray-200 font-mono text-sm resize-none focus:outline-none"
                    spellCheck={false}
                    onKeyDown={e => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                        e.preventDefault();
                        onSave();
                      }
                    }}
                  />
                ) : (
                  <div className="p-4">
                    {renderPreview(selectedNote.body || selectedNote.content)}
                  </div>
                )}
              </div>

              {!editing && (
                <div className="w-56 border-l border-port-border p-3 space-y-4 shrink-0 overflow-auto hidden lg:block">
                  {selectedNote.frontmatter && Object.keys(selectedNote.frontmatter).length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-gray-400 uppercase mb-1">Properties</h4>
                      <div className="space-y-1">
                        {Object.entries(selectedNote.frontmatter).map(([key, val]) => (
                          <div key={key} className="text-xs">
                            <span className="text-gray-500">{key}:</span>{' '}
                            <span className="text-gray-300">
                              {Array.isArray(val) ? val.join(', ') : String(val)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedNote.tags?.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-gray-400 uppercase mb-1">Tags</h4>
                      <div className="flex flex-wrap gap-1">
                        {selectedNote.tags.map(tag => (
                          <span key={tag} className="px-1.5 py-0.5 rounded text-xs bg-port-accent/20 text-port-accent">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {renderLinks(selectedNote)}
                </div>
              )}
            </div>
          </>
  );
}
