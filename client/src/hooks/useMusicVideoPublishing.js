import { useCallback, useEffect, useRef, useState } from 'react';
import {
  prepareMusicVideoPublishDraft,
  discardMusicVideoPublishDraft,
  getMusicVideoPublishPlatforms,
  updateMusicVideoPublishPlatforms,
  recordMusicVideoPublishPost,
} from '../services/apiMusicVideo.js';

const EMPTY_POSTING = { drafts: {}, busy: {}, errors: {} };

/**
 * Music Video posting (#9282). `prepare` fills the post in the PortOS Browser
 * and returns what it filled (a summary and a screenshot) for the director to
 * review. Manual posting is handled outside this hook. Errors are kept per
 * platform so a sign-in prompt stays beside the platform that needs it.
 *
 * Platforms are opt-in (#9287): `platforms` is the director's saved choice of
 * where they post (with an optional account each), `history` their posts and
 * ratings per platform across projects. `recordPost` saves a post made by hand
 * or rates one.
 */
export default function useMusicVideoPublishing({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  // A selection lifetime, rather than just the id, also rejects an old reply
  // after switching A → B → A. Hide the previous state in the first render.
  const selection = useRef({ projectId });
  if (selection.current.projectId !== projectId) selection.current = { projectId };
  const scope = selection.current;
  const [posting, setPosting] = useState({ ...EMPTY_POSTING, scope });
  const { drafts, busy, errors } = posting.scope === scope ? posting : EMPTY_POSTING;
  const [platforms, setPlatforms] = useState(null);
  const [history, setHistory] = useState({});

  const loadPlatforms = useCallback(() => getMusicVideoPublishPlatforms({ silent: true })
    .then((res) => { setPlatforms(res?.platforms || {}); setHistory(res?.history || {}); })
    .catch(() => setPlatforms((prev) => prev || {})), []);
  useEffect(() => { loadPlatforms(); }, [loadPlatforms]);

  const setFor = (field, target, value) => setPosting((prev) => {
    if (selection.current !== scope) return prev;
    const state = prev.scope === scope ? prev : { ...EMPTY_POSTING, scope };
    const next = { ...state[field] };
    if (value == null) delete next[target];
    else next[target] = value;
    return { ...state, [field]: next };
  });
  const fail = (target, err) => {
    setFor('errors', target, { message: err?.message || 'Failed', code: err?.code || null, url: err?.context?.url || null });
  };

  const prepare = (target, options = {}) => {
    setFor('busy', target, 'prepare');
    setFor('errors', target, null);
    return prepareMusicVideoPublishDraft(projectId, target, options, { silent: true })
      .then((draft) => { setFor('drafts', target, draft); return draft; })
      .catch((err) => { setFor('drafts', target, null); fail(target, err); return null; })
      .finally(() => setFor('busy', target, null));
  };

  const discard = (target) => {
    const draft = drafts[target];
    setFor('drafts', target, null);
    if (draft) discardMusicVideoPublishDraft(projectId, draft.draftId, { silent: true }).catch(() => {});
  };

  const setPlatform = (target, change) => {
    // Optimistic: the toggle flips at once and settles to the server's answer.
    setPlatforms((prev) => ({ ...(prev || {}), [target]: { ...(prev?.[target] || {}), ...change } }));
    return updateMusicVideoPublishPlatforms({ [target]: change })
      .then((res) => { if (res?.platforms) setPlatforms(res.platforms); return res?.platforms || null; })
      .catch(() => { loadPlatforms(); return null; });
  };

  const recordPost = (target, body) => recordMusicVideoPublishPost(projectId, target, body)
    .then((res) => { if (res?.project) replaceProject?.(res.project); loadPlatforms(); return res?.post || null; })
    .catch(() => null);

  const enabledTargets = Object.entries(platforms || {}).filter(([, p]) => p?.enabled).map(([t]) => t);

  return { drafts, busy, errors, prepare, discard, platforms, history, enabledTargets, setPlatform, recordPost };
}
