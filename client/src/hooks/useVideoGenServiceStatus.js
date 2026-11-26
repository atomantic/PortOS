/**
 * VideoGen page connectivity: the python `/status` probe, the probe-free model context, and which hosted render lanes are usable.
 *
 * Use when: The /media/video page's fetched context. The model list, the hosted-lane flags,
 * the BYOV runtime list and the render disclosures come from `/model-context`, never
 * `/status`, so the form paints without waiting on the interpreter probe.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSettings } from '../services/apiSystem.js';
import { getVideoGenModelContext, getVideoGenStatus } from '../services/apiImageVideo.js';

const EMPTY_LIST = [];

export function useVideoGenServiceStatus() {
  // `/status` owns legacy-interpreter connectivity ONLY. A cold probe takes
  // 2-4s (the server memoizes it for 30s), so nothing the form needs to render
  // may wait on it.
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  // The model list plus the numbers its auto-select reads, off the probe-free
  // `/model-context`. Fetched alongside /status on mount, it lands first — so
  // the Model picker paints on a cold load instead of holding a placeholder
  // through the interpreter probe.
  const [modelContextRequest, setModelContextRequest] = useState({ state: 'loading', context: null, error: null });
  const { context: modelContext } = modelContextRequest;
  // Grok Build CLI video backend (#2859 phase 2) — surfaced only when the
  // user enabled Grok in Media Gen Settings (one toggle covers image +
  // video). 'local' keeps every existing flow untouched.
  const [grokEnabled, setGrokEnabled] = useState(false);
  const models = useMemo(() => modelContext?.models || [], [modelContext]);
  const refreshGrokEnabled = useCallback(() => {
    getSettings({ silent: true })
      .then((sv) => setGrokEnabled(sv?.imageGen?.grok?.enabled === true))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshGrokEnabled(); }, [refreshGrokEnabled]);

  // `fresh` is for the manual Refresh button and install completion; other
  // callers accept the server's 30s memo. Strictly `=== true` so a click event
  // handed straight to this function can't force a probe.
  const refreshStatus = useCallback((options) => {
    setStatusLoading(true);
    getVideoGenStatus({ fresh: options?.fresh === true })
      .then(setStatus)
      .catch(() => setStatus({ connected: false, reason: 'Status check failed' }))
      .finally(() => setStatusLoading(false));
  }, []);

  // Model context never waits on the python probe. Refreshes retain the last
  // successful context so a transient catalog failure cannot erase a selection.
  const refreshModelContext = useCallback(() => {
    setModelContextRequest((previous) => ({ ...previous, state: 'loading' }));
    getVideoGenModelContext({ silent: true })
      .then((context) => setModelContextRequest({ state: 'ready', context, error: null }))
      .catch((error) => setModelContextRequest((previous) => ({ ...previous, state: 'error', error })));
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshModelContext();
  }, [refreshStatus, refreshModelContext]);

  // Hosted-lane usability comes off the server (`isVideoModeUsable`, which also
  // honors env-var keys the client can't see), from the probe-free
  // /model-context. `?? status` keeps a newer client working against a server
  // that predates those fields on /model-context.
  const fromContext = (key) => modelContext?.[key] ?? status?.[key];
  const laneEnabled = {
    grok: grokEnabled,
    fal: fromContext('falEnabled') === true,
    reactor: fromContext('reactorEnabled') === true,
    runway: fromContext('runwayEnabled') === true,
    gemini: fromContext('geminiEnabled') === true,
    higgsfield: fromContext('higgsfieldEnabled') === true,
    google: fromContext('googleEnabled') === true,
  };
  const byovRuntimes = fromContext('byovRuntimes') || EMPTY_LIST;
  const backendDisclosures = fromContext('backendDisclosures');
  const displaySleepOnRender = fromContext('displaySleepOnRender') === true;

  return {
    status, statusLoading, refreshStatus, refreshGrokEnabled,
    modelContextRequest, modelContext, models, refreshModelContext,
    laneEnabled, byovRuntimes, backendDisclosures, displaySleepOnRender,
  };
}

export default useVideoGenServiceStatus;
