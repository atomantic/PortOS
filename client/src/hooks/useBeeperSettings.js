import { useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../services/api';

export const BEEPER_DEFAULT_BASE_URL = 'http://127.0.0.1:23373';

const DEFAULTS = {
  enabled: false,
  intervalMinutes: 5,
  baseUrl: BEEPER_DEFAULT_BASE_URL,
  attachmentBudgetGb: 5,
  // Loopback-only by default (SEC-2, server/lib/mediaValidation.js): a
  // non-loopback baseUrl is prefixed onto every Beeper API call AND the
  // realtime WebSocket URL with the vault-stored access token attached, so
  // off is the only safe default — this is an explicit opt-in, never inferred
  // from the baseUrl the user typed.
  allowNonLoopbackBaseUrl: false,
};

// `value === ''` (a cleared field) falls back to the default; any other
// numeric-looking input — including a typed `0` — is clamped to the schema
// bounds instead. `Number(x) || fallback` would treat a typed 0 as falsy
// and silently substitute the default, masking the user's actual input.
const toFiniteNumber = (value, fallback) => {
  if (value === '' || value === null || value === undefined) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};
const clampInterval = (value) => Math.max(1, Math.min(1440, Math.floor(toFiniteNumber(value, DEFAULTS.intervalMinutes))));
const clampBudget = (value) => Math.max(0.1, Math.min(1000, toFiniteNumber(value, DEFAULTS.attachmentBudgetGb)));

// settings.beeper.{enabled,intervalMinutes,baseUrl,attachmentBudgetGb,
// allowNonLoopbackBaseUrl} — the ingestion + connection config this slice's
// Comms → Beeper card edits (#30). Deliberately never reads or writes
// `token`/`tokenExpiresAt`: the server strips the token from every
// GET /api/settings response and rejects a `beeper` PUT that includes one.
// The credential lives encrypted in Postgres and is written only through the
// dedicated connect routes (#31) — the Beeper card's Connect / paste /
// Disconnect actions, never this settings save.
//
// `save()` always PUTs the complete five-field object, never a diff — same
// convention as `useSyncSourceSettings` for iMessage/Signal/Spotify/YouTube —
// so a partial edit can never silently drop a sibling field on the server's
// generic top-level shallow merge.
export function useBeeperSettings() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(DEFAULTS);
  const [saved, setSaved] = useState(DEFAULTS);
  const [saving, setSaving] = useState(false);
  // Distinguishes "the GET failed" from "the GET succeeded and returned no
  // beeper config yet" (a fresh install, which legitimately falls through to
  // DEFAULTS). Collapsing the two — the empty `.catch(() => {})` this replaced
  // — left `form`/`saved` holding DEFAULTS as though they were this install's
  // stored config, so the very next Save PUT those defaults over whatever was
  // actually there. `save()` below refuses while this is true; the card is the
  // one that turns it into a visible failure (root AGENTS.md, absent-vs-empty).
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getSettings({ silent: true })
      .then((settings) => {
        if (!active) return;
        const config = settings?.beeper || {};
        const next = {
          enabled: typeof config.enabled === 'boolean' ? config.enabled : DEFAULTS.enabled,
          intervalMinutes: Number.isFinite(config.intervalMinutes) ? config.intervalMinutes : DEFAULTS.intervalMinutes,
          baseUrl: typeof config.baseUrl === 'string' && config.baseUrl ? config.baseUrl : DEFAULTS.baseUrl,
          attachmentBudgetGb: Number.isFinite(config.attachmentBudgetGb) ? config.attachmentBudgetGb : DEFAULTS.attachmentBudgetGb,
          allowNonLoopbackBaseUrl: typeof config.allowNonLoopbackBaseUrl === 'boolean'
            ? config.allowNonLoopbackBaseUrl : DEFAULTS.allowNonLoopbackBaseUrl,
        };
        setForm(next);
        setSaved(next);
        setLoadFailed(false);
      })
      .catch(() => { if (active) setLoadFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const dirty = Object.keys(DEFAULTS).some((key) => String(form[key]) !== String(saved[key]));

  const save = async () => {
    // Refuse rather than PUT: `form`/`saved` are still DEFAULTS here, not this
    // install's actual config, so writing them would overwrite whatever is
    // really stored the moment the failed GET is retried and the card is
    // dismissed.
    if (loadFailed) return false;
    const next = {
      enabled: form.enabled,
      intervalMinutes: clampInterval(form.intervalMinutes),
      attachmentBudgetGb: clampBudget(form.attachmentBudgetGb),
      baseUrl: (form.baseUrl || '').trim() || DEFAULTS.baseUrl,
      allowNonLoopbackBaseUrl: Boolean(form.allowNonLoopbackBaseUrl),
    };
    setSaving(true);
    const settings = await updateSettings({ beeper: next }).catch(() => null);
    setSaving(false);
    if (!settings) return false;
    setForm(next);
    setSaved(next);
    return true;
  };

  return {
    loading, form, setForm, saving, dirty, save, loadFailed,
  };
}

export default useBeeperSettings;
