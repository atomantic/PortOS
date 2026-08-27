import { useEffect, useMemo, useState } from 'react';
import { useLocalStorageBool } from './useLocalStorageBool.js';
import useProviderModels from './useProviderModels.js';
import { parseBareUrl } from '../lib/bareUrl.js';
import { parseGitHubUrl } from '../lib/githubRepoUrl.js';
import * as api from '../services/api.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';

/**
 * The Brain capture boxes' "this URL is a GitHub repo" state.
 *
 * A bare GitHub repo URL is always cloned by the server, which unlocks two
 * opt-in post-clone CoS agent runs (malware scan / repo study). Both preferences
 * are sticky — same pattern as the Creative toggle — so a user who always wants
 * a malware scan ticks it once.
 *
 * Rendering lives in `components/brain/RepoIntakeOptions.jsx`, which takes the
 * `repo` this returns rather than re-parsing the text.
 */

/** localStorage keys, by action. Reordering the UI table must not rebind these. */
const STORAGE_KEYS = {
  malwareScan: 'brain.repoIntake.malwareScan',
  learn: 'brain.repoIntake.learn',
};

/**
 * `{ owner, repo }` when a capture's ENTIRE text is a GitHub repo URL — i.e.
 * exactly when the server will file it to Links and clone it. Composes the two
 * mirrored rules in the same order `services/brain.js` does (`parseBareUrl` →
 * `parseGitHubUrl`); checking only the second would light the panel up for
 * "check out github.com/owner/repo", which the server files as a thought.
 */
export function capturedGitHubRepo(text) {
  const url = parseBareUrl(text);
  return url ? parseGitHubUrl(url) : null;
}

/**
 * @param {string} text the current capture text
 * @returns {{ repo: object|null, options: object, studyContext: string,
 *   setStudyContext: (context: string) => void, providerOverride: object,
 *   setProviderOverride: (patch: object) => void, toggle: (key: string) => void,
 *   intakeFor: (text: string) => object|undefined }}
 *   `repo` is the parsed `{ owner, repo }` (null when the text isn't a bare repo
 *   URL) — both the panel and the host's hint read it, so the text is parsed
 *   once per keystroke rather than once per consumer. `intakeFor(text)` is the
 *   payload to send with a capture: the ticked options when `text` is a repo
 *   URL, else undefined. It re-derives from the SUBMITTED text so a sticky tick
 *   can't ride along on a capture the user retyped into a plain thought.
 */
export function useRepoIntake(text) {
  const [malwareScan, setMalwareScan] = useLocalStorageBool(STORAGE_KEYS.malwareScan, false);
  const [learn, setLearn] = useLocalStorageBool(STORAGE_KEYS.learn, false);
  const repo = useMemo(() => capturedGitHubRepo(text), [text]);
  const { providers, activeProviderId } = useProviderModels({
    allowDefault: true,
    silent: true,
    withEffort: true,
    enabled: Boolean(repo && learn),
  });
  const [managedApps, setManagedApps] = useState([{ id: PORTOS_APP_ID, name: 'PortOS' }]);
  const [targetAppId, setTargetAppId] = useState(PORTOS_APP_ID);
  const [studyContext, setStudyContext] = useState('');
  const [providerOverride, setProviderOverride] = useState({ providerId: '', model: '', effort: '' });

  const repoKey = repo ? `${repo.owner}/${repo.repo}` : null;
  const options = useMemo(() => ({ malwareScan, learn }), [malwareScan, learn]);
  const setters = { malwareScan: setMalwareScan, learn: setLearn };

  useEffect(() => {
    setStudyContext('');
    setProviderOverride({ providerId: '', model: '', effort: '' });
  }, [repoKey]);

  useEffect(() => {
    if (!repo || !learn || typeof api.getApps !== 'function') return;
    api.getApps({ silent: true }).then((apps) => {
      const eligible = (Array.isArray(apps) ? apps : [])
        .filter(app => app?.id && app.repoPath && !app.archived)
        .sort((a, b) => (a.id === PORTOS_APP_ID ? -1 : b.id === PORTOS_APP_ID ? 1 : a.name.localeCompare(b.name)));
      if (eligible.length) {
        setManagedApps(eligible);
        setTargetAppId(current => eligible.some(app => app.id === current) ? current : eligible[0].id);
      }
    }).catch(() => {});
  }, [repo, learn]);

  return {
    repo,
    options,
    managedApps,
    targetAppId,
    setTargetAppId,
    studyContext,
    setStudyContext,
    providers,
    activeProviderId,
    providerOverride,
    setProviderOverride: (patch) => setProviderOverride(current => ({ ...current, ...patch })),
    toggle: (key) => setters[key](v => !v),
    intakeFor: (submitted) => (capturedGitHubRepo(submitted)
      ? { ...options, ...(learn ? {
        targetAppId,
        ...(studyContext.trim() ? { studyContext: studyContext.trim() } : {}),
        ...(providerOverride.providerId ? { providerId: providerOverride.providerId } : {}),
        ...(providerOverride.model ? { model: providerOverride.model } : {}),
        ...(providerOverride.effort ? { effort: providerOverride.effort } : {}),
      } : {}) }
      : undefined),
  };
}
