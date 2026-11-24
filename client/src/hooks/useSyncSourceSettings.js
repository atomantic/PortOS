/**
 * Shared enabled/interval scheduler settings lifecycle for a machine-local sync source, including
 * status loading, dirty tracking, interval clamping, and save state.
 *
 * Use when: Source settings tabs that use `getSettings` / `updateSettings` with a source-specific
 * status endpoint.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings, updateSettings } from '../services/apiSystem.js';

const clampInterval = (value, defaultInterval) => Math.max(1, Math.min(1440, Math.floor(Number(value) || defaultInterval)));

export function useSyncSourceSettings({ domain, defaultInterval, getStatus }) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(defaultInterval);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedInterval, setSavedInterval] = useState(defaultInterval);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const statusRequest = useRef(0);

  const loadStatus = useCallback(async () => {
    const request = ++statusRequest.current;
    await getStatus({ silent: true })
      .then((value) => {
        if (request !== statusRequest.current) return;
        setStatus(value);
        setStatusError(null);
      })
      .catch((error) => { if (request === statusRequest.current) setStatusError(error); });
  }, [getStatus]);

  // Re-runs the load effect; a failed settings read must not seed defaults that Save would persist.
  const retry = useCallback(() => { setLoading(true); setLoadError(false); setAttempt((n) => n + 1); }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      getSettings({ silent: true }).catch(() => null),
      loadStatus(),
    ])
      .then(([settings]) => {
        if (!active) return;
        if (!settings) { setLoadError(true); return; }
        const config = settings?.[domain] || {};
        const nextEnabled = typeof config.enabled === 'boolean' ? config.enabled : false;
        const nextInterval = Number.isFinite(config.intervalMinutes) ? config.intervalMinutes : defaultInterval;
        setEnabled(nextEnabled);
        setIntervalMinutes(nextInterval);
        setSavedEnabled(nextEnabled);
        setSavedInterval(nextInterval);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      statusRequest.current += 1;
    };
  }, [attempt, defaultInterval, domain, loadStatus]);

  const dirty = enabled !== savedEnabled || Number(intervalMinutes) !== Number(savedInterval);

  const save = async () => {
    if (loading || loadError) return false;
    const nextInterval = clampInterval(intervalMinutes, defaultInterval);
    setSaving(true);
    const settings = await updateSettings({ [domain]: { enabled, intervalMinutes: nextInterval } }).catch(() => null);
    setSaving(false);
    if (!settings) return false;
    setIntervalMinutes(nextInterval);
    setSavedEnabled(enabled);
    setSavedInterval(nextInterval);
    return true;
  };

  return { loading, loadError, retry, enabled, setEnabled, intervalMinutes, setIntervalMinutes, saving, status, setStatus, statusError, loadStatus, dirty, save };
}
