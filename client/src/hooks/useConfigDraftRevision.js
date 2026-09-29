import { useCallback, useRef, useState } from 'react';

// The revision protocol behind an editable config draft that a server response
// may want to overwrite. Every edit bumps a revision counter; a save/adopt
// records the revision it made the server copy equal to.
//
//   draftDirty  the draft has edits the server has not seen (drives the UI)
//   snapshot()  taken when a request leaves: `wasClean` says whether the draft
//               matched the server then, `isStillCurrent()` says — when the
//               response lands — that the user has not edited since
//   markDirty() an edit happened
//   markSaved() the draft now equals the server copy (a response replaced it)
//   supersede() invalidate every in-flight snapshot without touching dirtiness
//   reset()     back to a pristine, clean draft (reloading the page state)
//
// `lib/eidoverseDraftReconcile.js#shouldReplaceDraft` turns a snapshot into the
// "may the server overwrite the draft" decision.
export default function useConfigDraftRevision() {
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const [draftDirty, setDraftDirty] = useState(false);

  const markDirty = useCallback(() => {
    revision.current += 1;
    setDraftDirty(true);
  }, []);

  const markSaved = useCallback(() => {
    savedRevision.current = revision.current;
    setDraftDirty(false);
  }, []);

  const supersede = useCallback(() => {
    revision.current += 1;
  }, []);

  const reset = useCallback(() => {
    revision.current = 0;
    savedRevision.current = 0;
    setDraftDirty(false);
  }, []);

  const snapshot = useCallback(() => {
    const submitted = revision.current;
    return {
      wasClean: submitted === savedRevision.current,
      isStillCurrent: () => revision.current === submitted,
    };
  }, []);

  return { draftDirty, markDirty, markSaved, supersede, reset, snapshot };
}
