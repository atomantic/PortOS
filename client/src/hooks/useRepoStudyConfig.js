import { useEffect, useState } from 'react';
import useProviderModels from './useProviderModels.js';
import * as api from '../services/api.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';

/**
 * The knobs a `repo-study` dispatch takes: which managed app's tracker receives
 * the issues, the free-form brief telling the agent what to look for, and an
 * optional provider/model/effort pin for that one run.
 *
 * Shared by both callers so the two forms can't drift: the capture boxes'
 * "study for app ideas" checkbox (through `useRepoIntake`) and the Links tab's
 * on-demand "Update & study" button. Rendering lives in
 * `components/brain/RepoStudyFields.jsx`, which takes what this returns.
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled] false parks the hook — no provider or app
 *   fetch — for a form that is currently collapsed or irrelevant.
 * @param {string|null} [options.resetKey] changing it clears the brief and the
 *   provider pin, so a form re-aimed at a different repo doesn't inherit the
 *   previous one's context.
 * @param {string} [options.initialStudyContext] pre-fills the brief (the Links
 *   tab opens the form with the brief the last study was given).
 */
export function useRepoStudyConfig({ enabled = true, resetKey = null, initialStudyContext = '' } = {}) {
  const { providers, activeProviderId } = useProviderModels({
    allowDefault: true,
    silent: true,
    withEffort: true,
    enabled,
  });
  const [managedApps, setManagedApps] = useState([{ id: PORTOS_APP_ID, name: 'PortOS' }]);
  const [targetAppId, setTargetAppId] = useState(PORTOS_APP_ID);
  const [studyContext, setStudyContext] = useState(initialStudyContext);
  const [providerOverride, setProviderOverride] = useState({ providerId: '', model: '', effort: '' });

  useEffect(() => {
    setStudyContext(initialStudyContext);
    setProviderOverride({ providerId: '', model: '', effort: '' });
    // `initialStudyContext` is deliberately NOT a dependency: it seeds the field
    // once per target, and re-running on every render would fight the user's own
    // edits.
  }, [resetKey]);

  useEffect(() => {
    if (!enabled || typeof api.getApps !== 'function') return;
    api.getApps({ silent: true }).then((apps) => {
      const eligible = (Array.isArray(apps) ? apps : [])
        .filter(app => app?.id && app.repoPath && !app.archived)
        .sort((a, b) => (a.id === PORTOS_APP_ID ? -1 : b.id === PORTOS_APP_ID ? 1 : a.name.localeCompare(b.name)));
      if (eligible.length) {
        setManagedApps(eligible);
        setTargetAppId(current => eligible.some(app => app.id === current) ? current : eligible[0].id);
      }
    }).catch(() => {});
  }, [enabled]);

  return {
    managedApps,
    targetAppId,
    setTargetAppId,
    studyContext,
    setStudyContext,
    providers,
    activeProviderId,
    providerOverride,
    setProviderOverride: (patch) => setProviderOverride(current => ({ ...current, ...patch })),
    /**
     * The study fields to send. Empty selections are the "use the configured
     * default" sentinel and are omitted rather than sent as empty strings.
     */
    studyPayload: () => ({
      targetAppId,
      ...(studyContext.trim() ? { studyContext: studyContext.trim() } : {}),
      ...(providerOverride.providerId ? { providerId: providerOverride.providerId } : {}),
      ...(providerOverride.model ? { model: providerOverride.model } : {}),
      ...(providerOverride.effort ? { effort: providerOverride.effort } : {}),
    }),
  };
}

export default useRepoStudyConfig;
