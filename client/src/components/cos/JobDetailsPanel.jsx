import { useRef } from 'react';
import { Terminal, Trash2 } from 'lucide-react';
import { formatDateNumeric } from '../../utils/formatters';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import JobNotepad from './JobNotepad';
import { BRIEFING_CONFIG_OPTIONS, isAgentJobType } from './jobCardConfig';

export default function JobDetailsPanel({ job, recordLabel, providers, onDelete, deleteConfirmation }) {
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = deleteConfirmation;
  const deleteButtonRef = useRef(null);
  const isShell = job.type === 'shell';

  return (
    <>
      <p className="text-sm text-gray-400">{job.description}</p>
      {isShell && job.command && (
        <div className="flex items-center gap-2 text-xs">
          <Terminal size={12} className="text-emerald-400 shrink-0" />
          <code className="text-emerald-300 bg-port-bg px-2 py-1 rounded font-mono">{job.command}</code>
        </div>
      )}
      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        {isAgentJobType(job.type) && job.providerId && (
          <span>AI: <span className="text-gray-300">{providers?.find(p => p.id === job.providerId)?.name || job.providerId}{job.model ? ` / ${job.model}` : ''}{job.effort ? ` · ${job.effort}` : ''}</span></span>
        )}
        <span>Created: <span className="text-gray-300">{formatDateNumeric(job.createdAt, '—')}</span></span>
      </div>
      {job.config && BRIEFING_CONFIG_OPTIONS.some(o => job.config[o.key]) && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="text-gray-500">Enrichments:</span>
          {BRIEFING_CONFIG_OPTIONS.filter(o => job.config[o.key]).map(o => (
            <span key={o.key} className="px-2 py-0.5 bg-port-accent/10 text-port-accent rounded">{o.label}</span>
          ))}
        </div>
      )}
      {isShell && job.lastOutput && (
        <details className="group">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">Last output (exit {job.lastExitCode})</summary>
          <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded-lg text-xs text-gray-400 font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{job.lastOutput}</pre>
        </details>
      )}
      {isAgentJobType(job.type) && (
        <details className="group">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">View prompt template</summary>
          <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded-lg text-xs text-gray-400 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{job.promptTemplate}</pre>
        </details>
      )}
      <JobNotepad jobId={job.id} jobName={job.name} />
      {isConfirming(job.id) ? (
        <InlineConfirmRow
          autoFocus
          aria-label={`Confirm delete job ${recordLabel}`}
          returnFocusRef={deleteButtonRef}
          question="Delete this job? This cannot be undone."
          confirmTitle="Confirm delete"
          cancelTitle="Cancel delete"
          onConfirm={() => confirmDelete(() => onDelete(job.id))}
          onCancel={cancelDelete}
        />
      ) : (
        <div className="flex justify-end">
          <button
            ref={deleteButtonRef}
            type="button"
            onClick={() => requestDelete(job.id)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-red-400/60 hover:text-red-400 transition-colors"
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </>
  );
}
