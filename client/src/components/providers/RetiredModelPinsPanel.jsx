import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import Banner from '../ui/Banner';
import { modeLabel, RENDER_TARGET_OPTIONS } from '../../lib/imageGenModes';
import { pluralize } from '../../lib/textUtils';
// The retired-pin notification card names a pin's provider records with this
// too, so the two surfaces cannot describe the same pin differently.
import { pinProviderNames } from '../../../../server/lib/modelPinReconcile.js';

/**
 * The user-facing name for a pin, composed HERE rather than on the server.
 *
 * The server sends the structured descriptor (`kind`, `mode`, `target`, …); the
 * human names for those ids already live in the client registries the Settings
 * pages render from, so composing here is what keeps the panel and the page it
 * deep-links to calling the same row the same thing — the server's own `label`
 * would say "universe-bible render model" where Settings says "Universe Bible &
 * canon renders". Falls back to the server label for any kind with no registry
 * entry (task and per-app pins, whose names are the user's own task ids).
 */
const pinLabel = (pin) => {
  if (pin.kind === 'imageGen') return `${modeLabel(pin.mode)} image model`;
  if (pin.kind === 'renderDefault') {
    const target = RENDER_TARGET_OPTIONS.find((option) => option.id === pin.target);
    return target ? `${target.label} — model` : pin.label;
  }
  return pin.label;
};

/**
 * "These pins name a model your provider no longer serves" (#7315).
 *
 * A vendor retires a model id, the install's catalog refresh picks that up, and
 * every stored pin still naming it rots silently until a render or a scheduled
 * run dies with a raw vendor error. PortOS re-points only the ONE pin it owns
 * (`AGY_IMAGEGEN_DEFAULT_MODEL`, #7314); a pin the USER chose can only be
 * surfaced, because substituting it would render something different under the
 * chosen model's name and bury the vendor's own "unknown model" error.
 *
 * So this warns and offers a one-click clear back to "inherit" — it never
 * rewrites a pin on its own. Renders nothing at all when every pin is healthy,
 * which is the normal state; the panel must not cost a healthy install a row.
 *
 * `reloadKey` re-reads the audit when the caller knows a catalog moved (the
 * Providers page bumps it after a model refresh) — a retirement is only
 * observable once the refresh lands, so the pin it rotted has to surface then
 * rather than waiting for the next full page load.
 */
export default function RetiredModelPinsPanel({ reloadKey = 0 }) {
  const [pins, setPins] = useState([]);
  const [providers, setProviders] = useState({});
  const [clearing, setClearing] = useState(null);

  const load = useCallback(async () => {
    // `silent` — a provider service that isn't up yet is not something to toast
    // about on a page the user opened to look at providers. The panel simply
    // stays hidden, which is indistinguishable from "no stale pins".
    const data = await api.getModelPinWarnings({ silent: true }).catch(() => null);
    setPins(Array.isArray(data?.pins) ? data.pins : []);
    setProviders(data?.providers && typeof data.providers === 'object' ? data.providers : {});
  }, []);

  useEffect(() => { load(); }, [load, reloadKey]);

  const handleClear = async (pin) => {
    setClearing(pin.id);
    const result = await api.clearModelPin(pin.id).catch(() => null);
    setClearing(null);
    if (!result) return;
    // Drop the row locally rather than waiting on a reload: the write already
    // landed, and re-reading would blink the whole panel. `load()` still runs so
    // a pin that was cleared in another tab disappears too.
    // The write already landed, so the local removal IS the new state — a
    // re-read would spend a full server audit to learn what we just did.
    setPins((current) => current.filter((entry) => entry.id !== pin.id));
    toast.success(`Cleared the ${pinLabel(pin)} pin — it now inherits the default.`);
  };

  if (pins.length === 0) return null;

  return (
    <Banner
      tone="warning"
      size="lg"
      icon={AlertTriangle}
      title={`${pluralize(pins.length, 'model pin')} ${pins.length === 1 ? 'names' : 'name'} a model that is no longer offered`}
    >
      <p className="mt-1 text-xs text-gray-400">
        These were pinned by hand, so PortOS will not swap them for you — a substitution would render under
        the name you chose. Clear one to inherit the default, or pick a listed model where the pin lives.
      </p>
      <ul className="mt-3 space-y-2">
        {pins.map((pin) => {
          // A reviewer pin is judged against EVERY record fronting its binary
          // (#7339), so "now offered" is their union — showing one record's
          // catalog would hide tiers the reviewer can still be handed.
          const offered = Array.from(new Set(
            pin.providerIds.flatMap((id) => (Array.isArray(providers[id]?.available) ? providers[id].available : []))
          ));
          return (
            <li
              key={pin.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded border border-port-border bg-port-card p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-white">
                  {pinLabel(pin)}: <code className="text-port-warning">{pin.model}</code>
                </div>
                <div className="mt-0.5 text-xs text-gray-400">
                  {pin.location} · {pinProviderNames(pin, providers)}
                </div>
                {offered.length > 0 && (
                  <div className="mt-1 break-words text-xs text-gray-500">
                    Now offered: {offered.slice(0, 6).join(', ')}
                    {offered.length > 6 ? ` +${offered.length - 6} more` : ''}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {pin.href && (
                  <Link
                    to={pin.href}
                    className="rounded bg-port-border px-3 py-1.5 text-xs text-white transition-colors hover:bg-port-border/80"
                  >
                    Open setting
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => handleClear(pin)}
                  disabled={clearing === pin.id}
                  className="rounded bg-port-accent px-3 py-1.5 text-xs text-white transition-colors hover:bg-port-accent/80 disabled:opacity-50"
                >
                  {clearing === pin.id ? 'Clearing…' : 'Clear pin'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Banner>
  );
}
