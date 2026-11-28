/**
 * Making-Of X thread drafts: fills multi-part Making-Of threads (text + per-part
 * images/videos) in the PortOS Browser and follows tab lifecycle over Socket.IO.
 * Mirrors `useMusicVideoPublishing.js` so Fill X draft behaves identically to Publish.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../../services/socket';
import {
  discardMusicVideoMakingOfXDraft,
  getMusicVideoMakingOfXDrafts,
  prepareMusicVideoMakingOfXDraft,
} from '../../services/apiMusicVideo.js';

const EMPTY_STATE = { drafts: {}, busy: {}, errors: {}, progress: {} };
const projectScope = (projectId) => ({
  projectId,
  latestDraftIds: new Map(),
  finishedDraftStates: new Map(),
});

export default function useMakingOfXDrafts({ projectId } = {}) {
  const selection = useRef(null);
  if (selection.current?.projectId !== (projectId || null)) {
    selection.current = projectScope(projectId || null);
  }
  const scope = selection.current;
  const [state, setState] = useState({ ...EMPTY_STATE, scope });
  const { drafts, busy, errors, progress } = state.scope === scope ? state : EMPTY_STATE;

  const [draftsError, setDraftsError] = useState(null);
  const draftsErrorRef = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const retryDrafts = useCallback(() => setAttempt((n) => n + 1), []);

  const setFor = (field, postId, value) => setState((prev) => {
    if (selection.current !== scope) return prev;
    const current = prev.scope === scope ? prev : { ...EMPTY_STATE, scope };
    const next = { ...current[field] };
    if (value == null) delete next[postId];
    else next[postId] = value;
    return { ...current, [field]: next };
  });

  const presentDraft = (postId, draft) => {
    if (draft.state === 'discarded' || draft.state === 'posted') return;
    const effectiveState = scope.finishedDraftStates.get(draft.draftId) ?? draft.state;
    if (effectiveState === 'discarded' || effectiveState === 'posted') return;
    setFor('drafts', postId, effectiveState === draft.state ? draft : { ...draft, state: effectiveState });
  };

  const finishDraft = (postId, draftId, nextState) => {
    const previous = scope.finishedDraftStates.get(draftId);
    if (previous === nextState || previous === 'discarded' || previous === 'posted') return;
    scope.finishedDraftStates.set(draftId, nextState);
    setState((prev) => {
      const current = selection.current === scope && prev.scope === scope ? prev.drafts[postId] : null;
      if (!current || current.draftId !== draftId) return prev;
      const next = { ...prev.drafts };
      if (nextState === 'closed') next[postId] = { ...current, state: nextState };
      else delete next[postId];
      return { ...prev, drafts: next };
    });
  };

  const fail = (postId, err) => {
    setFor('errors', postId, {
      message: err?.message || 'Failed to fill X draft',
      code: err?.code || null,
      url: err?.context?.url || null,
    });
  };

  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    const isCurrent = () => !cancelled && selection.current === scope;
    let readNumber = 0;

    const updateError = (next) => {
      if (next === draftsErrorRef.current) return;
      draftsErrorRef.current = next;
      setDraftsError(next);
    };

    const readDrafts = (opened) => {
      const snapshot = opened ? null : new Map(scope.latestDraftIds);
      const read = ++readNumber;
      return getMusicVideoMakingOfXDrafts(projectId, { silent: true }).then((res) => {
        if (!isCurrent()) return;
        if (read === readNumber) updateError(null);
        for (const draft of res?.drafts || []) {
          const currentId = scope.latestDraftIds.get(draft.postId);
          if (opened) {
            if (draft.postId !== opened.postId || draft.draftId !== opened.draftId || draft.draftId !== currentId) continue;
          } else if (currentId !== snapshot.get(draft.postId) && draft.draftId !== currentId) {
            continue;
          }
          presentDraft(draft.postId, draft);
        }
      }).catch((err) => {
        if (isCurrent() && read === readNumber) updateError({ scope, error: err || new Error('Failed') });
      });
    };

    const onDraft = (event) => {
      if (!isCurrent() || event?.projectId !== projectId) return;
      if (event.state === 'queued' || event.state === 'filling') {
        setFor('progress', event.postId, event.message || null);
        return;
      }
      if (event.state === 'open') {
        scope.latestDraftIds.set(event.postId, event.draftId);
        readDrafts(event);
        return;
      }
      if (event.state === 'discarded' || event.state === 'posted' || event.state === 'closed') {
        finishDraft(event.postId, event.draftId, event.state);
      }
    };

    socket.on('music-video:making-of-draft', onDraft);
    readDrafts();
    return () => {
      cancelled = true;
      socket.off('music-video:making-of-draft', onDraft);
    };
  }, [projectId, scope, attempt]);

  const prepare = (postId, options = {}) => {
    if (!projectId || !postId) return Promise.resolve(null);
    const previousId = scope.latestDraftIds.get(postId);
    setFor('busy', postId, 'prepare');
    setFor('errors', postId, null);
    return prepareMusicVideoMakingOfXDraft(projectId, postId, options, { silent: true })
      .then((draft) => {
        const currentId = scope.latestDraftIds.get(postId);
        if (selection.current !== scope || (currentId !== previousId && currentId !== draft.draftId)) return null;
        scope.latestDraftIds.set(postId, draft.draftId);
        presentDraft(postId, draft);
        return draft;
      })
      .catch((err) => { fail(postId, err); return null; })
      .finally(() => {
        setFor('busy', postId, null);
        setFor('progress', postId, null);
      });
  };

  const discard = (postId) => {
    const draft = drafts[postId];
    if (!projectId || !draft || busy[postId]) return Promise.resolve();
    setFor('busy', postId, 'discard');
    setFor('errors', postId, null);
    return discardMusicVideoMakingOfXDraft(projectId, draft.draftId, { silent: true })
      .then(() => finishDraft(postId, draft.draftId, 'discarded'))
      .catch((err) => fail(postId, err))
      .finally(() => setFor('busy', postId, null));
  };

  return {
    drafts,
    busy,
    errors,
    progress,
    draftsError: draftsError?.scope === scope ? draftsError.error : null,
    retryDrafts,
    prepare,
    discard,
  };
}
