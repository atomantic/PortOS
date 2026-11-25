/**
 * Probes whether the selected video model's bring-your-own-venv runtime is installed, and gates Generate until it is confirmed.
 *
 * Use when: The /media/video page needs the install/upgrade banner and the BYOV submit gate
 * before a render would hit a "venv not found" 500. The BYOV runtime set comes from `/model-context`.
 */

import { useCallback, useEffect, useState } from 'react';
import { getVideoGenRuntimeStatus } from '../services/apiImageVideo.js';

export function useVideoGenByovRuntime({ currentModel, byovRuntimes }) {
  // Probe the per-runtime status BEFORE the user hits Generate — without
  // this they'd see the buildArgs-time "venv not found" 500 with no good way
  // to recover. The set of "BYOV" runtimes comes from /model-context server-side so
  // it can't drift from the server's BYOV_RUNTIME_INFO map.
  const [byovStatus, setByovStatus] = useState(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const byovRuntime = currentModel?.runtime;
  const needsByovProbe = byovRuntime && byovRuntimes.includes(byovRuntime);
  const refreshByovStatus = useCallback((signal) => {
    if (!needsByovProbe) { setByovStatus(null); return Promise.resolve(); }
    return getVideoGenRuntimeStatus(byovRuntime, { signal })
      .then((s) => { if (s) setByovStatus(s); })
      .catch(() => {});
  }, [byovRuntime, needsByovProbe]);
  useEffect(() => {
    if (!needsByovProbe) { setByovStatus(null); return; }
    const controller = new AbortController();
    refreshByovStatus(controller.signal);
    return () => controller.abort();
  }, [needsByovProbe, refreshByovStatus]);
  const byovRuntimeMissing = !!byovStatus && byovStatus.installed === false;
  // While the runtime-status probe is in flight (`needsByovProbe` is true but
  // we haven't received a response yet), `byovStatus` is null and
  // `byovRuntimeMissing` reads false — without this guard the user could
  // submit during that window and hit a venv-missing 500 before the install
  // banner appears. Gate Generate / Enqueue on the broader "BYOV not yet
  // confirmed ready" instead. The banner itself still keys on `byovRuntimeMissing`
  // (we don't want to flash "isn't installed yet" copy before we know).
  const byovGateBlocked = needsByovProbe && (byovStatus === null || byovStatus.installed === false);

  return {
    byovStatus, byovRuntime, needsByovProbe, refreshByovStatus, byovRuntimeMissing, byovGateBlocked,
    installModalOpen, setInstallModalOpen,
  };
}

export default useVideoGenByovRuntime;
