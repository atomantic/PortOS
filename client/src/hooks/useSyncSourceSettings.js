import { useCallback, useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../services/api';

const clampInterval = (value, defaultInterval) => Math.max(1, Math.min(1440, Math.floor(Number(value) || defaultInterval)));

export function useSyncSourceSettings({ domain, defaultInterval, getStatus }) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(defaultInterval);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedInterval, setSavedInterval] = useState(defaultInterval);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Re-runs the load effect; a failed settings read must not seed defaults that Save would persist.
  const retry = useCallback(() => { setLoading(true); setLoadError(false); setAttempt((n) => n + 1); }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      getSettings({ silent: true }).catch(() => null),
      getStatus({ silent: true }).catch(() => null),
    ])
      .then(([settings, sourceStatus]) => {
        if (!active) return;
        setStatus(sourceStatus);
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
    return () => { active = false; };
  }, [attempt, defaultInterval, domain, getStatus]);

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

  return { loading, loadError, retry, enabled, setEnabled, intervalMinutes, setIntervalMinutes, saving, status, setStatus, dirty, save };
}
