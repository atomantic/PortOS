import { useEffect, useMemo, useRef } from 'react';
import { useLocalStorageBool } from './useLocalStorageBool.js';
import { useRepoStudyConfig } from './useRepoStudyConfig.js';
import { parseBareUrl } from '../lib/bareUrl.js';
import { parseRepoUrl } from '../lib/repoUrl.js';

/**
 * The Brain capture boxes' "this URL is a repository" state.
 *
 * A bare repo URL (github.com / gitlab.com) is always cloned by the server,
 * which unlocks two opt-in post-clone CoS agent runs (malware scan / repo
 * study). Both preferences are sticky — same pattern as the Creative toggle —
 * so a user who always wants a malware scan ticks it once.
 *
 * The study knobs come from the shared `useRepoStudyConfig`, so the capture
 * boxes and the Links tab's on-demand re-study send the same payload shape.
 * Rendering lives in `components/brain/RepoIntakeOptions.jsx`, which takes the
 * `repo` this returns rather than re-parsing the text.
 */

/** localStorage keys, by action. Reordering the UI table must not rebind these. */
const STORAGE_KEYS = {
  malwareScan: 'brain.repoIntake.malwareScan',
  learn: 'brain.repoIntake.learn',
};

/**
 * The parsed repo when a capture's ENTIRE text is a repo URL — i.e. exactly
 * when the server will file it to Links and clone it. Composes the two mirrored
 * rules in the same order `services/brain.js` does (`parseBareUrl` →
 * `parseRepoUrl`); checking only the second would light the panel up for
 * "check out github.com/owner/repo", which the server files as a thought.
 */
export function capturedRepo(text) {
  const url = parseBareUrl(text);
  return url ? parseRepoUrl(url) : null;
}

/**
 * @param {string} text the current capture text
 * @param {string} [note] the "why are you saving this link?" note shown
 *   alongside the repo opt-ins. When the user ticks "Study for app ideas" with
 *   an empty study brief, it defaults to this note — the two boxes are almost
 *   always asked and answered with the same text.
 * @returns {object} the `useRepoStudyConfig` shape plus `repo`, `options`,
 *   `toggle`, and `intakeFor`. `repo` is the parsed `{ host, owner, repo }`
 *   (null when the text isn't a bare repo URL) — both the panel and the host's
 *   hint read it, so the text is parsed once per keystroke rather than once per
 *   consumer. `intakeFor(text)` is the payload to send with a capture: the
 *   ticked options when `text` is a repo URL, else undefined. It re-derives from
 *   the SUBMITTED text so a sticky tick can't ride along on a capture the user
 *   retyped into a plain thought.
 */
export function useRepoIntake(text, note = '') {
  const [malwareScan, setMalwareScan] = useLocalStorageBool(STORAGE_KEYS.malwareScan, false);
  const [learn, setLearn] = useLocalStorageBool(STORAGE_KEYS.learn, false);
  const repo = useMemo(() => capturedRepo(text), [text]);

  const repoKey = repo ? `${repo.host}/${repo.owner}/${repo.repo}` : null;
  const study = useRepoStudyConfig({ enabled: Boolean(repo && learn), resetKey: repoKey });

  // Defaults the study brief from the save note the first time "learn" is
  // ticked on for this repo, rather than on every keystroke — once the user
  // has their own text in the brief box, typing more in the note shouldn't
  // clobber it.
  const prevLearnRef = useRef(learn);
  useEffect(() => {
    if (learn && !prevLearnRef.current && !study.studyContext.trim() && note.trim()) {
      study.setStudyContext(note.trim());
    }
    prevLearnRef.current = learn;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learn, repoKey]);

  const options = useMemo(() => ({ malwareScan, learn }), [malwareScan, learn]);
  const setters = { malwareScan: setMalwareScan, learn: setLearn };

  return {
    ...study,
    repo,
    options,
    toggle: (key) => setters[key](v => !v),
    intakeFor: (submitted) => (capturedRepo(submitted)
      ? { ...options, ...(learn ? study.studyPayload() : {}) }
      : undefined),
  };
}
