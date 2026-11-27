import { ChevronDown, ChevronRight, BookOpen, Sparkles, User } from 'lucide-react';
import { formatDateTime } from '../../../../utils/formatters';

export default function LearningStandingSection({ notes, expanded, onToggle }) {
  if (!notes?.length) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left mb-3"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <BookOpen size={16} className="text-port-accent" />
        <span className="font-medium text-white">Standing Learnings</span>
        <span className="text-xs text-gray-500">
          ({notes.length} note{notes.length === 1 ? '' : 's'})
        </span>
      </button>
      {expanded && (
        <>
          <p className="text-xs text-gray-500 mb-3">
            Human-readable operating notes — recurring-failure incidents the agent auto-flagged, plus notes you recorded. Runtime-only (never committed to git).
          </p>
          <div className="bg-port-card border border-port-border rounded-lg divide-y divide-port-border">
            {notes.map((note, idx) => {
              const isAuto = note.origin === 'auto-incident';
              return (
                <div key={idx} className="p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${isAuto ? 'bg-port-warning/15 text-port-warning' : 'bg-port-border text-gray-300'}`}>
                      {isAuto ? <Sparkles size={11} /> : <User size={11} />}
                      {isAuto ? 'Auto-flagged' : 'Manual'}
                    </span>
                    {note.recordedAt && (
                      <span className="text-xs text-gray-600">{formatDateTime(note.recordedAt)}</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-300">{note.message}</div>
                  {(note.category || note.taskType) && (
                    <div className="text-xs text-gray-500 mt-1 font-mono">
                      {note.category ? `${note.category}` : ''}{note.category && note.taskType ? ' · ' : ''}{note.taskType || ''}
                      {note.recurrenceCount ? ` · ×${note.recurrenceCount}` : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
