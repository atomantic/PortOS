import { useState } from 'react';

// Quick Commit box. The message is this component's state, so a keystroke
// re-renders only the composer, not the tab and its other panels. It mirrors
// every edit into the caller's `draftRef` because the tab swaps all panels for
// a spinner on each reload (staging a file, fetching branches), and an
// unfinished message must outlive that remount without lifting it into
// render state.
//
// `onCommit(message, clearDraft)` owns the request and the in-flight flag; it
// calls `clearDraft` only when the commit succeeds, so a failed commit keeps
// the message for a retry.
export default function CommitComposer({ draftRef, committing, onCommit }) {
  const [message, setMessage] = useState(() => draftRef.current);

  const updateMessage = (value) => {
    draftRef.current = value;
    setMessage(value);
  };

  const handleCommit = () => {
    if (!message.trim()) return;
    return onCommit(message, () => updateMessage(''));
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-2">Quick Commit</h3>
      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => updateMessage(e.target.value)}
          placeholder="Commit message..."
          aria-label="Commit message"
          className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        />
        <button
          onClick={handleCommit}
          disabled={committing || !message.trim()}
          className="px-4 py-2 bg-port-success hover:bg-port-success/80 text-white rounded-lg text-sm disabled:opacity-50"
        >
          Commit
        </button>
      </div>
    </div>
  );
}
