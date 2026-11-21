/**
 * VideoGen page connectivity: the python `/status` probe, the probe-free model context, and which hosted render lanes are usable.
 *
 * Use when: The /media/video page's fetched context. The model list comes from
 * `/model-context`, never `/status`, so the Model picker paints without waiting on the
 * interpreter probe.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSettings } from '../services/apiSystem.js';
import { getVideoGenModelContext, getVideoGenStatus } from '../services/apiImageVideo.js';

export function useVideoGenServiceStatus() {
  // `/status` owns connectivity ONLY. It shells out to python on every call
  // (~1-2s), so nothing the form needs to render may wait on it.
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  // The model list plus the numbers its auto-select reads, off the probe-free
  // `/model-context`. Fetched alongside /status on mount, it lands first — so
  // the Model picker paints on a cold load instead of holding a placeholder
  // through the interpreter probe.
  const [modelContextRequest, setModelContextRequest] = useState({ state: 'loading', context: null, error: null });
  const { context: modelContext } = modelContextRequest;
  // Grok Build CLI video backend (#2859 phase 2) — surfaced only when the
  // user enabled Grok in Settings → Image Gen (one toggle covers image +
  // video). 'local' keeps every existing flow untouched.
  const [grokEnabled, setGrokEnabled] = useState(false);
  const models = useMemo(() => modelContext?.models || [], [modelContext]);
  const refreshGrokEnabled = useCallback(() => {
    getSettings({ silent: true })
      .then((sv) => setGrokEnabled(sv?.imageGen?.grok?.enabled === true))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshGrokEnabled(); }, [refreshGrokEnabled]);

  const refreshStatus = useCallback(() => {
    setStatusLoading(true);
    getVideoGenStatus()
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

  // fal.ai (#6213) / reactor.inc (#6214) usability comes off GET /status
  // instead of the raw settings object — the server-side `isVideoModeUsable`
  // it's computed from also honors the FAL_KEY/REACTOR_API_KEY env vars, which
  // the client can't see, so a key set only via env var (no Settings-form
  // entry) still surfaces the backend switcher.
  const laneEnabled = {
    grok: grokEnabled,
    fal: status?.falEnabled === true,
    reactor: status?.reactorEnabled === true,
    runway: status?.runwayEnabled === true,
    gemini: status?.geminiEnabled === true,
    higgsfield: status?.higgsfieldEnabled === true,
    google: status?.googleEnabled === true,
  };

  return {
    status, statusLoading, refreshStatus, refreshGrokEnabled,
    modelContextRequest, modelContext, models, refreshModelContext,
    laneEnabled,
  };
}

export default useVideoGenServiceStatus;
