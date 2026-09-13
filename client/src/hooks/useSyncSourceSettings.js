import { useEffect, useState } from 'react';
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

  useEffect(() => {
    let active = true;
    Promise.all([
      getSettings({ silent: true }).catch(() => ({})),
      getStatus({ silent: true }).catch(() => null),
    ])
      .then(([settings, sourceStatus]) => {
        if (!active) return;
        const config = settings?.[domain] || {};
        const nextEnabled = typeof config.enabled === 'boolean' ? config.enabled : false;
        const nextInterval = Number.isFinite(config.intervalMinutes) ? config.intervalMinutes : defaultInterval;
        setEnabled(nextEnabled);
        setIntervalMinutes(nextInterval);
        setSavedEnabled(nextEnabled);
        setSavedInterval(nextInterval);
        setStatus(sourceStatus);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [defaultInterval, domain, getStatus]);

  const dirty = enabled !== savedEnabled || Number(intervalMinutes) !== Number(savedInterval);

  const save = async () => {
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

  return { loading, enabled, setEnabled, intervalMinutes, setIntervalMinutes, saving, status, setStatus, dirty, save };
}
