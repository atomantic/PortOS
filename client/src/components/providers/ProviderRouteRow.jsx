import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Star, Terminal } from 'lucide-react';
import ProviderRouteModelAliases from './ProviderRouteModelAliases';
import { routeOverrideDraft, routeOverridePatch } from '../../lib/providerManagement';

/**
 * One executable route inside the connection panel (#6369).
 *
 * The row a human acts on: it names the mode and the executable provider id,
 * offers that id as the system default, hands a TUI off to the Shell page, and
 * — behind a disclosure — edits the overrides that belong to THIS mode alone.
 *
 * Why the overrides live here rather than only on `/ai/edit/:providerId`: a
 * backend is configured as a whole. Having typed an endpoint once on the
 * connection above, retyping three sets of args in three separate editors is
 * exactly the round trip the graph exists to remove.
 *
 * Three boundaries this row does NOT cross:
 *
 *   - **No execution consent.** There is no enable toggle and no transport
 *     opt-in. Turning a route on stays an explicit act on the route editor.
 *   - **No connection state.** The fields are whatever the server published as
 *     route-owned; an endpoint or a key can never be retyped here and escape
 *     the projection that keeps the other harnesses on the backend in step.
 *   - **Nothing launches itself.** "Launch in Shell" is a link the human
 *     clicks, and the launch re-resolves the command AND the provider's secret
 *     env server-side; the command line here is display only.
 *
 * The disclosure is presentation state, not a selection: the connection in the
 * URL still names what is open, and every route's editor is one click from a
 * shared link.
 */

/**
 * Reading order and labels. The route's OWN key set decides what renders — a
 * setting this build has no label for is still shown, under its raw key, rather
 * than silently dropped from a newer server's payload.
 */
const FIELD_LABELS = {
  args: 'Launch arguments (one per line)',
  timeout: 'Timeout (ms)',
  effort: 'Reasoning effort',
  defaultModel: 'Default model',
  lightModel: 'Light tier model',
  mediumModel: 'Medium tier model',
  heavyModel: 'Heavy tier model',
  ultraModel: 'Ultra tier model',
};

/** Published keys, labelled ones first and in reading order. */
const orderedFields = (settings) => {
  const published = Object.keys(settings || {});
  const known = Object.keys(FIELD_LABELS).filter((key) => published.includes(key));
  return [...known, ...published.filter((key) => !Object.hasOwn(FIELD_LABELS, key))];
};

const INPUT_CLASS = 'w-full rounded border border-port-border bg-port-bg px-2 py-1';

export default function ProviderRouteRow({
  route,
  isSystemDefault,
  busy,
  blocked,
  onMakeDefault,
  onSaveSettings,
  onSaveAliases,
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => routeOverrideDraft(route.settings));

  // Re-seed only when the SAVED values move. `settingsRevision` is a
  // fingerprint of those values, so a poll that changed nothing leaves a
  // half-typed override alone — and an edit made in the route editor does
  // replace it, which is the honest outcome given the save would 409 anyway.
  //
  // The settings object is read through a ref for the same reason the panel
  // reads its connection through one: it is a new identity on every reload, so
  // depending on it directly would wipe the draft on a poll that changed
  // nothing. The two primitives decide WHEN; the ref carries WHAT.
  const settingsRef = useRef(route.settings);
  settingsRef.current = route.settings;
  useEffect(() => {
    setDraft(routeOverrideDraft(settingsRef.current));
  }, [route.providerId, route.settingsRevision]);

  const patch = useMemo(() => routeOverridePatch(route.settings, draft), [route.settings, draft]);
  const dirty = Object.keys(patch).length > 0;
  const fields = useMemo(() => orderedFields(route.settings), [route.settings]);
  const efforts = Array.isArray(route.effortLevels) ? route.effortLevels : [];
  // A stored level the current ladder no longer lists stays selectable, the
  // same way a model pin outside the catalog stays visible. Without it the
  // select would fall back to the blank option, and simply OPENING the panel
  // would read as "the human cleared the effort" and offer to save it.
  const stored = route.settings?.effort;
  const effortOptions = stored && !efforts.includes(stored) ? [...efforts, stored] : efforts;

  const set = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
  const fieldId = (key) => `route-${route.providerId}-${key}`;

  return (
    <li className="rounded border border-port-border p-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-port-bg px-1.5 py-0.5 text-xs uppercase">{route.mode}</span>
        <Link to={`/ai/edit/${route.providerId}`} className="text-port-accent hover:underline">
          {route.providerId}
        </Link>
        {isSystemDefault ? (
          <span className="flex items-center gap-1 text-xs text-port-success">
            <Star size={12} aria-hidden="true" /> system default
          </span>
        ) : (
          <button type="button" disabled={busy} onClick={() => onMakeDefault(route.providerId)}
            className="text-xs text-port-muted hover:underline disabled:opacity-50">
            Use as system default
          </button>
        )}
        {/* TUI only, and only once the server resolved a real command line. The
            link carries the provider id alone — the env it needs is secret and
            is re-resolved when the PTY spawns. */}
        {route.tuiCommandLine && (
          <Link
            to={`/shell?provider=${encodeURIComponent(route.providerId)}`}
            title={`Launch TUI in Shell: ${route.tuiCommandLine}`}
            className="flex items-center gap-1 rounded bg-port-accent/20 px-2 py-0.5 text-xs text-port-accent hover:bg-port-accent/30"
          >
            <Terminal size={12} aria-hidden="true" /> Launch in Shell
          </Link>
        )}
        <button type="button" onClick={() => setOpen((prev) => !prev)} aria-expanded={open}
          className="ml-auto text-xs text-port-muted hover:underline">
          {open ? 'Hide' : `Overrides & aliases${dirty ? ' •' : ''}`}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2 border-t border-port-border pt-2">
          {/* A route whose mode publishes no overridable setting still has
              aliases to correct, so the disclosure opens either way. */}
          {fields.length > 0 && (
          <>
          <div className="grid gap-2 sm:grid-cols-2">
            {fields.map((key) => (
              <label key={key} className="block text-sm" htmlFor={fieldId(key)}>
                <span className="mb-1 block text-xs text-port-muted">{FIELD_LABELS[key] || key}</span>
                {key === 'args' ? (
                  <textarea
                    id={fieldId(key)}
                    rows={3}
                    className={`${INPUT_CLASS} font-mono text-xs`}
                    value={draft[key] ?? ''}
                    onChange={(e) => set(key, e.target.value)}
                  />
                ) : key === 'effort' ? (
                  <select
                    id={fieldId(key)}
                    className={INPUT_CLASS}
                    disabled={efforts.length === 0}
                    value={draft[key] ?? ''}
                    onChange={(e) => set(key, e.target.value)}
                  >
                    {/* A harness with no effort ladder gets a DISABLED control
                        rather than a hidden field, so "this program takes no
                        effort flag" is visible instead of reading as "unset". */}
                    <option value="">
                      {efforts.length === 0 ? 'This harness takes no effort setting' : 'Harness default'}
                    </option>
                    {effortOptions.map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                ) : (
                  <input
                    id={fieldId(key)}
                    type={key === 'timeout' ? 'number' : 'text'}
                    className={INPUT_CLASS}
                    placeholder={key === 'timeout' ? 'Provider default' : 'Unpinned'}
                    value={draft[key] ?? ''}
                    onChange={(e) => set(key, e.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
          <p className="text-xs text-port-muted">
            These apply to this mode only — the other modes on this harness keep their own. Enabling
            a route and clearing a timeout stay on its editor.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || blocked || !dirty}
              onClick={() => onSaveSettings(route, patch)}
              className="rounded bg-port-accent px-3 py-1 text-sm text-white disabled:opacity-50">
              Save overrides
            </button>
            <button type="button" disabled={!dirty}
              onClick={() => setDraft(routeOverrideDraft(route.settings))}
              className="rounded border border-port-border px-3 py-1 text-sm disabled:opacity-50">
              Revert
            </button>
          </div>
          </>
          )}
          <ProviderRouteModelAliases
            route={route}
            busy={busy}
            blocked={blocked}
            onSaveAliases={onSaveAliases}
          />
        </div>
      )}
    </li>
  );
}
