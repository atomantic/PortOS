import { useCallback, useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  prepareMusicVideoPublishDraft,
  submitMusicVideoPublishDraft,
  discardMusicVideoPublishDraft,
  getMusicVideoPublishPlatforms,
  updateMusicVideoPublishPlatforms,
  recordMusicVideoPublishPost,
} from '../services/apiMusicVideo.js';

/**
 * Music Video posting (#9282). Each platform is two explicit steps: `prepare`
 * fills the post in the PortOS Browser and returns what it filled (a summary
 * and a screenshot) for the director to review; `submit` posts that same
 * draft. Nothing posts without the second press. Errors are kept per platform
 * so a sign-in prompt stays beside the platform that needs it.
 *
 * Platforms are opt-in (#9287): `platforms` is the director's saved choice of
 * where they post (with an optional account each), `history` their posts and
 * ratings per platform across projects. `recordPost` saves a post made by hand
 * or rates one.
 */
export default function useMusicVideoPublishing({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  const [platforms, setPlatforms] = useState(null);
  const [history, setHistory] = useState({});

  const loadPlatforms = useCallback(() => getMusicVideoPublishPlatforms({ silent: true })
    .then((res) => { setPlatforms(res?.platforms || {}); setHistory(res?.history || {}); })
    .catch(() => setPlatforms((prev) => prev || {})), []);
  useEffect(() => { loadPlatforms(); }, [loadPlatforms]);

  const setFor = (setter, target, value) => setter((prev) => {
    const next = { ...prev };
    if (value == null) delete next[target];
    else next[target] = value;
    return next;
  });
  const fail = (target, err) => {
    setFor(setErrors, target, { message: err?.message || 'Failed', code: err?.code || null, url: err?.context?.url || null });
  };

  const prepare = (target, options = {}) => {
    setFor(setBusy, target, 'prepare');
    setFor(setErrors, target, null);
    return prepareMusicVideoPublishDraft(projectId, target, options, { silent: true })
      .then((draft) => { setFor(setDrafts, target, draft); return draft; })
      .catch((err) => { setFor(setDrafts, target, null); fail(target, err); return null; })
      .finally(() => setFor(setBusy, target, null));
  };

  const submit = (target) => {
    const draft = drafts[target];
    if (!draft) return Promise.resolve(null);
    setFor(setBusy, target, 'submit');
    setFor(setErrors, target, null);
    return submitMusicVideoPublishDraft(projectId, draft.draftId, { silent: true })
      .then((res) => {
        if (res?.project) replaceProject?.(res.project);
        loadPlatforms();
        setFor(setDrafts, target, null);
        toast.success('Posted');
        return res?.post || null;
      })
      .catch((err) => {
        // A gone draft can't be posted again; the director fills it afresh.
        if (err?.code === 'PUBLISH_DRAFT_MISSING') setFor(setDrafts, target, null);
        fail(target, err);
        return null;
      })
      .finally(() => setFor(setBusy, target, null));
  };

  const discard = (target) => {
    const draft = drafts[target];
    setFor(setDrafts, target, null);
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

  return { drafts, busy, errors, prepare, submit, discard, platforms, history, enabledTargets, setPlatform, recordPost };
}
