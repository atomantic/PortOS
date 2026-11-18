/**
 * Music Video posting (#9282): per-platform drafts filled in the PortOS Browser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import {
  getMusicVideoPublishDrafts,
  prepareMusicVideoPublishDraft,
  previewMusicVideoPublishPost,
  discardMusicVideoPublishDraft,
  getMusicVideoPublishPlatforms,
  updateMusicVideoPublishPlatforms,
  recordMusicVideoPublishPost,
  updateMusicVideoPublishCopy,
  removeMusicVideoPublishPost,
  setMusicVideoPublishCrossLinks,
  prepareMusicVideoCrossLinkEdit,
} from '../services/apiMusicVideo.js';

const EMPTY_POSTING = { drafts: {}, busy: {}, errors: {}, progress: {} };
const projectScope = (projectId) => ({ projectId, latestDraftIds: new Map(), finishedDraftStates: new Map() });

/**
 * Music Video posting (#9282). `prepare` fills the post in the PortOS Browser
 * and returns what it filled (a summary and a screenshot) for the director to
 * review. Manual posting is handled outside this hook. Errors are kept per
 * platform so a sign-in prompt stays beside the platform that needs it.
 *
 * Platforms are opt-in (#9287): `platforms` is the director's saved choice of
 * where they post (with an optional account each), `history` their posts and
 * ratings per platform across projects. `recordPost` saves a post made by hand
 * (a link, or `{ posted: true }` to mark it done without one) or rates one;
 * `removePost` undoes the done mark. `preview` reads what Fill draft would
 * post, without opening anything.
 */
export default function useMusicVideoPublishing({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  // A selection lifetime, rather than just the id, also rejects an old reply
  // after switching A → B → A. Hide the previous state in the first render.
  const selection = useRef(null);
  if (selection.current?.projectId !== projectId) selection.current = projectScope(projectId);
  const scope = selection.current;
  const [posting, setPosting] = useState({ ...EMPTY_POSTING, scope });
  const { drafts, busy, errors, progress } = posting.scope === scope ? posting : EMPTY_POSTING;
  // `null` = not loaded yet or the read failed (`platformsError` says which);
  // `{}` = loaded with nothing turned on. A failed read must not read as "none on".
  const [platforms, setPlatforms] = useState(null);
  const [platformsError, setPlatformsError] = useState(null);
  const [history, setHistory] = useState({});
  // The socket handler below outlives renders; it reads the latest callback.
  const replaceProjectRef = useRef(replaceProject);
  replaceProjectRef.current = replaceProject;

  // A failed refresh keeps the last good answer; only a never-loaded list surfaces the error.
  const loadPlatforms = useCallback(() => getMusicVideoPublishPlatforms({ silent: true })
    .then((res) => { setPlatforms(res?.platforms || {}); setHistory(res?.history || {}); setPlatformsError(null); })
    .catch((err) => setPlatformsError(err || new Error('Failed'))), []);
  useEffect(() => { loadPlatforms(); }, [loadPlatforms]);

  const setFor = (field, target, value) => setPosting((prev) => {
    if (selection.current !== scope) return prev;
    const state = prev.scope === scope ? prev : { ...EMPTY_POSTING, scope };
    const next = { ...state[field] };
    if (value == null) delete next[target];
    else next[target] = value;
    return { ...state, [field]: next };
  });
  const presentDraft = (target, draft) => {
    if (draft.state === 'discarded' || draft.state === 'posted') return;
    const state = scope.finishedDraftStates.get(draft.draftId) ?? draft.state;
    if (state === 'discarded' || state === 'posted') return;
    setFor('drafts', target, state === draft.state ? draft : { ...draft, state });
  };
  const finishDraft = (target, draftId, state) => {
    // A read or fill can still return this ID after its tab closes or is removed.
    const previous = scope.finishedDraftStates.get(draftId);
    if (previous === state || previous === 'discarded' || previous === 'posted') return;
    scope.finishedDraftStates.set(draftId, state);
    setPosting((prev) => {
      const current = selection.current === scope && prev.scope === scope ? prev.drafts[target] : null;
      if (!current || current.draftId !== draftId) return prev;
      const next = { ...prev.drafts };
      if (state === 'closed') next[target] = { ...current, state };
      else delete next[target];
      return { ...prev, drafts: next };
    });
  };
  const fail = (target, err) => {
    setFor('errors', target, { message: err?.message || 'Failed', code: err?.code || null, url: err?.context?.url || null });
  };

  // Rehydrate from the server after a reload, and follow its draft events
  // (a tab filled elsewhere, closed by hand, discarded, or posted from by the
  // director, in which case the server has already recorded the post's link).
  // `draftsError` is scoped to the project so a failure never shows under another one.
  const [draftsError, setDraftsError] = useState(null);
  const draftsErrorRef = useRef(null);
  const [draftsAttempt, setDraftsAttempt] = useState(0);
  const retryDrafts = useCallback(() => setDraftsAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    const isCurrent = () => !cancelled && selection.current === scope;
    let readNumber = 0;
    const updateDraftsError = (next) => {
      // A successful read with no prior error has no error state to update.
      if (next === draftsErrorRef.current) return;
      draftsErrorRef.current = next;
      setDraftsError(next);
    };
    const readDrafts = (opened) => {
      const snapshot = opened ? null : new Map(scope.latestDraftIds);
      const read = ++readNumber;
      return getMusicVideoPublishDrafts(projectId, { silent: true }).then((res) => {
        if (!isCurrent()) return;
        // The error clears only on success, so a slow retry never reads as "no drafts".
        if (read === readNumber) updateDraftsError(null);
        for (const draft of res?.drafts || []) {
          const currentId = scope.latestDraftIds.get(draft.target);
          if (opened) {
            if (draft.target !== opened.target || draft.draftId !== opened.draftId || draft.draftId !== currentId) continue;
          } else if (currentId !== snapshot.get(draft.target) && draft.draftId !== currentId) {
            // A list begun before an open or local fill may still hold the replaced draft.
            continue;
          }
          presentDraft(draft.target, draft);
        }
      }).catch((err) => {
        if (isCurrent() && read === readNumber) updateDraftsError({ scope, error: err || new Error('Failed') });
      });
    };
    const onDraft = (e) => {
      if (!isCurrent() || e?.projectId !== projectId) return;
      // A fill still running: what it waits on or is doing (shown only while this tab's fill is busy).
      if (e.state === 'queued' || e.state === 'filling') { setFor('progress', e.target, e.message || null); return; }
      if (e.state === 'open') {
        scope.latestDraftIds.set(e.target, e.draftId);
        readDrafts(e);
        return;
      }
      if (e.state === 'posted') {
        if (e.project) replaceProjectRef.current?.(e.project);
        loadPlatforms();
      }
      if (e.state === 'discarded' || e.state === 'posted' || e.state === 'closed') finishDraft(e.target, e.draftId, e.state);
    };
    socket.on('music-video:publish-draft', onDraft);
    readDrafts();
    return () => { cancelled = true; socket.off('music-video:publish-draft', onDraft); };
    // Dependency list is intentionally partial.
  }, [projectId, scope, loadPlatforms, draftsAttempt]);

  const prepare = (target, options = {}) => {
    const previousId = scope.latestDraftIds.get(target);
    setFor('busy', target, 'prepare');
    setFor('errors', target, null);
    return prepareMusicVideoPublishDraft(projectId, target, options, { silent: true })
      .then((draft) => {
        const currentId = scope.latestDraftIds.get(target);
        if (selection.current !== scope || (currentId !== previousId && currentId !== draft.draftId)) return null;
        scope.latestDraftIds.set(target, draft.draftId);
        presentDraft(target, draft);
        return draft;
      })
      .catch((err) => { fail(target, err); return null; })
      .finally(() => { setFor('busy', target, null); setFor('progress', target, null); });
  };

  // What Fill draft would post with these options; null when the preview itself failed.
  const preview = (target, options = {}) => previewMusicVideoPublishPost(projectId, target, options, { silent: true }).catch(() => null);

  const discard = (target) => {
    const draft = drafts[target];
    if (!draft || busy[target]) return;
    setFor('busy', target, 'discard');
    setFor('errors', target, null);
    return discardMusicVideoPublishDraft(projectId, draft.draftId, { silent: true })
      .then(() => finishDraft(target, draft.draftId, 'discarded'))
      .catch((err) => fail(target, err))
      .finally(() => setFor('busy', target, null));
  };

  const setPlatform = (target, change) => {
    // Optimistic: the toggle flips at once and settles to the server's answer.
    // `defaults` merges per answer (null forgets one), as the server does.
    setPlatforms((prev) => {
      const current = prev?.[target] || {};
      const next = { ...current, ...change };
      if (change.defaults) {
        next.defaults = { ...(current.defaults || {}) };
        for (const [k, v] of Object.entries(change.defaults)) { if (v == null || v === '') delete next.defaults[k]; else next.defaults[k] = v; }
      }
      return { ...(prev || {}), [target]: next };
    });
    return updateMusicVideoPublishPlatforms({ [target]: change })
      .then((res) => { if (res?.platforms) setPlatforms(res.platforms); return res?.platforms || null; })
      .catch(() => { loadPlatforms(); return null; });
  };

  // Save what the director typed or picked on a platform's row, so a reload or
  // another tab shows it again. `forProjectId` is the row's project: a row that
  // flushes as it unmounts on a project switch still saves to its own project.
  const savePostOptions = (forProjectId, target, answers) => updateMusicVideoPublishCopy(forProjectId, { postOptions: { [target]: answers } })
    .then((res) => { if (res?.project?.id && res.project.id === selection.current.projectId) replaceProject?.(res.project); return true; })
    .catch(() => false);

  const recordPost = (target, body) => recordMusicVideoPublishPost(projectId, target, body)
    .then((res) => { if (res?.project) replaceProject?.(res.project); loadPlatforms(); return res?.post || null; })
    .catch(() => null);

  const removePost = (target) => removeMusicVideoPublishPost(projectId, target)
    .then((res) => { if (res?.project) replaceProject?.(res.project); loadPlatforms(); return true; })
    .catch(() => false);

  // Cross-links: whether new drafts list the release's other posts.
  const setCrossLinks = (enabled) => setMusicVideoPublishCrossLinks(projectId, enabled)
    .then((res) => { if (res?.project) replaceProject?.(res.project); return true; })
    .catch(() => false);
  // Fill a posted platform's edit (or a reply under it) with the links it lacks; errors stay with the caller.
  const prepareCrossLinks = (target) => prepareMusicVideoCrossLinkEdit(projectId, target, { silent: true });

  const skippedTargets = Array.isArray(project?.publishKit?.skippedTargets) ? project.publishKit.skippedTargets : [];
  const skippedSet = new Set(skippedTargets);
  // Each request replaces the list, so compose rapid row changes from the last
  // saved answer instead of the render that both clicks happened to retain.
  scope.skipWrites ||= { tail: Promise.resolve(), pending: 0, targets: skippedTargets };
  const skipWrites = scope.skipWrites;
  if (!skipWrites.pending) skipWrites.targets = skippedTargets;

  const setTargetSkipped = (target, skip) => {
    if (!projectId) return Promise.resolve(false);
    skipWrites.pending += 1;
    const run = skipWrites.tail.then(() => {
      const current = skipWrites.targets;
      const next = skip ? [...new Set([...current, target])] : current.filter((t) => t !== target);
      return updateMusicVideoPublishCopy(projectId, { skippedTargets: next }).then((res) => {
        skipWrites.targets = Array.isArray(res?.project?.publishKit?.skippedTargets) ? res.project.publishKit.skippedTargets : next;
        if (res?.project?.id === projectId && selection.current === scope) replaceProjectRef.current?.(res.project);
        return true;
      }).catch(() => false);
    });
    skipWrites.tail = run;
    return run.finally(() => { skipWrites.pending -= 1; });
  };

  // null until the saved choice is known, so consumers never treat "unknown" as "none on".
  const enabledTargets = platforms
    ? Object.entries(platforms).filter(([t, p]) => p?.enabled && !skippedSet.has(t)).map(([t]) => t)
    : null;

  return { drafts, progress, draftsError: draftsError?.scope === scope ? draftsError.error : null, retryDrafts, busy, errors, prepare, preview, discard, platforms, platformsError, retryPlatforms: loadPlatforms, history, enabledTargets, skippedTargets, setTargetSkipped, setPlatform, savePostOptions, recordPost, removePost, setCrossLinks, prepareCrossLinks };
}
