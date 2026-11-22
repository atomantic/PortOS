import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, KeyRound, RotateCcw, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import Pill from '../ui/Pill';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { FormField } from '../ui/FormField';
import ToggleSwitch from '../ToggleSwitch';
import { INPUT_CLASS } from '../apps/constants';
import {
  addServiceCredentialPoolKey,
  getServiceCredentialPool,
  removeServiceCredentialPoolKey,
  resetServiceCredentialPoolCooldowns,
  updateServiceCredentialPool,
  updateServiceCredentialPoolKey,
} from '../../services/apiProviders.js';
import { formatCount, formatTimeOfDay } from '../../utils/formatters';

/**
 * A service's credential pool (#17384): extra keys for the same backend, used
 * in priority order before PortOS falls back to another provider. A 429 on
 * Anthropic / OpenRouter cools only that model on that key; a 402 or 401
 * benches the key. Cooldowns are in memory on the server and clear on restart.
 *
 * Fetched once when the card opens; every edit applies the server's answer.
 * The status read never rotates or benches a key, and no response carries a
 * key value — only a masked fingerprint.
 */

const STRATEGIES = [
  { id: 'fill_first', label: 'Fill first — stay on the top key until it cools (keeps prompt caches warm)' },
  { id: 'round_robin', label: 'Round robin — rotate on every request' },
  { id: 'least_used', label: 'Least used — balance request counts' },
];

const WITHHELD_COPY = {
  disabled: 'Off',
  'origin-mismatch': 'Withheld: endpoint moved',
  'env-missing': 'Env variable not set',
  'env-not-allowed': 'Env variable not allowed',
};

const ICON_BUTTON = 'inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg border border-port-border text-gray-300 hover:text-white disabled:opacity-40';

function entryStatus(entry) {
  if (entry.withheld) return { tone: 'muted', label: WITHHELD_COPY[entry.withheld] || entry.withheld };
  if (entry.dead) return { tone: 'error', label: 'Rejected — check the key' };
  if (entry.cooldown) return { tone: 'warning', label: `Cooling (${entry.cooldown.reason}) until ${formatTimeOfDay(entry.cooldown.until)}` };
  return { tone: 'success', label: 'Ready' };
}

const entryName = (entry) => (entry.source === 'env' ? entry.envVar : `${entry.label} ${entry.fingerprint || ''}`.trim());

function PoolEntry({ entry, index, count, busy, onMove, onToggle, onRebind, onReset, onRemove }) {
  const [confirming, setConfirming] = useState(false);
  const status = entryStatus(entry);
  const removable = entry.id !== 'primary' && !entry.auto;
  const toggleable = entry.id !== 'primary' && entry.withheld !== 'origin-mismatch';
  const coolingAnything = entry.cooldown || entry.dead || entry.cooledModels.length > 0;
  return (
    <li className="min-w-0 rounded-lg border border-port-border bg-port-bg p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="w-4 h-4 text-gray-500 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-all text-sm text-gray-200">{entry.source === 'env' ? <code className="font-mono">{entry.envVar}</code> : entry.label}</span>
        {entry.source === 'stored' && entry.fingerprint && <code className="text-xs font-mono text-gray-500">{entry.fingerprint}</code>}
        <Pill tone="muted" size="xs">{entry.id === 'primary' ? 'primary' : entry.auto ? 'env (discovered)' : entry.source}</Pill>
        <Pill tone={status.tone} size="xs">{status.label}</Pill>
        <span className="text-xs text-gray-500">{formatCount(entry.uses, { fallback: '0' })} uses</span>
      </div>
      {entry.cooledModels.length > 0 && (
        <p className="text-xs text-port-warning break-words">
          Cooling per model: {entry.cooledModels.map((cooled) => `${cooled.model} until ${formatTimeOfDay(cooled.until)}`).join(', ')}
        </p>
      )}
      {entry.withheld === 'origin-mismatch' && entry.boundOrigin && (
        <p className="text-xs text-gray-400 break-all">Added for {entry.boundOrigin}; it is not sent to the service's new endpoint until you re-bind it.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={ICON_BUTTON} disabled={busy || index === 0} onClick={() => onMove(index, -1)} aria-label={`Move ${entryName(entry)} up`}>
          <ArrowUp className="w-4 h-4" aria-hidden="true" />
        </button>
        <button type="button" className={ICON_BUTTON} disabled={busy || index === count - 1} onClick={() => onMove(index, 1)} aria-label={`Move ${entryName(entry)} down`}>
          <ArrowDown className="w-4 h-4" aria-hidden="true" />
        </button>
        {toggleable && (
          <span className="flex items-center gap-2 text-xs text-gray-300">
            <ToggleSwitch size="sm" enabled={entry.enabled} disabled={busy} ariaLabel={`${entry.enabled ? 'Turn off' : 'Turn on'} ${entryName(entry)}`} onChange={() => onToggle(entry, !entry.enabled)} />
            {entry.enabled ? 'On' : 'Off'}
          </span>
        )}
        {entry.withheld === 'origin-mismatch' && entry.source === 'stored' && (
          <button type="button" disabled={busy} onClick={() => onRebind(entry)} className="px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-200 hover:text-white disabled:opacity-50">
            Re-bind to current endpoint
          </button>
        )}
        {coolingAnything && (
          <button type="button" disabled={busy} onClick={() => onReset(entry)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-200 hover:text-white disabled:opacity-50">
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Reset cooldown
          </button>
        )}
        {removable && !confirming && (
          <button type="button" disabled={busy} onClick={() => setConfirming(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-port-error/50 text-port-error hover:bg-port-error/10 disabled:opacity-50">
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Remove
          </button>
        )}
      </div>
      {confirming && (
        <InlineConfirmRow
          question={`Remove ${entryName(entry)} from the pool?`}
          confirmText="Remove key"
          aria-label={`Confirm removing ${entryName(entry)}`}
          onConfirm={() => { setConfirming(false); onRemove(entry); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </li>
  );
}

const EMPTY_DRAFT = { mode: 'stored', label: '', apiKey: '', envVar: '' };

/**
 * @param {object} props
 * @param {object} props.service - the service DTO the card shows
 * @param {(revision: number) => void} [props.onRevision] - a pool edit writes the
 *   service row, so the card's next save must carry the new revision
 */
export default function ProviderCredentialPool({ service, onRevision }) {
  const slug = service.slug || service.id;
  const [pool, setPool] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    getServiceCredentialPool(slug, { silent: true })
      .then((data) => { if (active) setPool(data); })
      .catch((err) => { if (active) setLoadError(err?.message || 'Could not load the credential pool'); });
    return () => { active = false; };
  }, [slug]);

  const run = async (action, success) => {
    setBusy(true);
    const next = await action().catch(() => null);
    setBusy(false);
    if (!next) return false;
    setPool(next);
    if (Number.isInteger(next.revision) && next.revision !== pool?.revision) onRevision?.(next.revision);
    if (success) toast.success(success);
    return true;
  };

  if (loadError) return <Banner tone="error" size="sm">{loadError}</Banner>;
  if (!pool) return <p className="text-xs text-gray-500">Loading credential pool…</p>;

  const entries = pool.entries;
  const envHint = service.definition?.envVars?.length ? `${service.definition.envVars[0]}_2, ${service.definition.envVars[0]}_3, …` : null;
  const move = (index, delta) => {
    const order = entries.map((entry) => entry.id);
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    return run(() => updateServiceCredentialPool(slug, { order }));
  };
  const add = async () => {
    const body = draft.mode === 'stored'
      ? { apiKey: draft.apiKey.trim(), ...(draft.label.trim() ? { label: draft.label.trim() } : {}) }
      : { envVar: draft.envVar.trim(), ...(draft.label.trim() ? { label: draft.label.trim() } : {}) };
    if (await run(() => addServiceCredentialPoolKey(slug, body), 'Key added to the pool')) setDraft(EMPTY_DRAFT);
  };
  const canAdd = draft.mode === 'stored' ? draft.apiKey.trim().length >= 8 : /^[A-Z][A-Z0-9_]*$/.test(draft.envVar.trim());

  return (
    <section aria-labelledby={`pool-${service.id}-title`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`pool-${service.id}-title`} className="text-xs uppercase tracking-wide text-gray-500">
          Credential pool ({formatCount(entries.length, { fallback: '0' })} {entries.length === 1 ? 'key' : 'keys'})
        </h4>
        {entries.some((entry) => entry.cooldown || entry.dead || entry.cooledModels.length > 0) && (
          <button type="button" disabled={busy} onClick={() => run(() => resetServiceCredentialPoolCooldowns(slug), 'Cooldowns cleared')} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-200 hover:text-white disabled:opacity-50">
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Reset all cooldowns
          </button>
        )}
      </div>
      <p className="text-xs text-gray-400">
        {pool.active
          ? 'Requests rotate across these keys on a rate limit, spent balance or rejected key before PortOS falls back to another provider.'
          : 'Add a second key to rotate on rate limits before PortOS falls back to another provider.'}
        {envHint && <> Numbered env variables (<code className="font-mono">{envHint}</code>) are picked up automatically.</>}
      </p>

      <FormField label="Strategy" compact>
        <select
          id={`pool-strategy-${service.id}`}
          value={pool.strategy || 'fill_first'}
          disabled={busy}
          onChange={(e) => run(() => updateServiceCredentialPool(slug, { strategy: e.target.value }))}
          className={INPUT_CLASS}
        >
          {STRATEGIES.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.label}</option>)}
        </select>
      </FormField>

      {entries.length > 0 && (
        <ol className="space-y-2">
          {entries.map((entry, index) => (
            <PoolEntry
              key={entry.id}
              entry={entry}
              index={index}
              count={entries.length}
              busy={busy}
              onMove={move}
              onToggle={(target, enabled) => run(() => updateServiceCredentialPoolKey(slug, target.id, { enabled }))}
              onRebind={(target) => run(() => updateServiceCredentialPoolKey(slug, target.id, { rebindOrigin: true }), 'Key re-bound to the current endpoint')}
              onReset={(target) => run(() => resetServiceCredentialPoolCooldowns(slug, { credentialId: target.id }), 'Cooldown cleared')}
              onRemove={(target) => run(() => removeServiceCredentialPoolKey(slug, target.id), 'Key removed')}
            />
          ))}
        </ol>
      )}

      <div className="rounded-lg border border-dashed border-port-border p-3 space-y-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Kind of key to add">
          {[['stored', 'Paste a key'], ['env', 'Reference an env variable']].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={draft.mode === mode}
              onClick={() => setDraft((prev) => ({ ...prev, mode }))}
              className={`px-2.5 py-1.5 text-xs rounded-lg border ${draft.mode === mode ? 'border-port-accent text-white bg-port-accent/20' : 'border-port-border text-gray-300 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
          {draft.mode === 'stored' ? (
            <FormField label="Additional key" compact>
              <input id={`pool-key-${service.id}`} type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => setDraft((prev) => ({ ...prev, apiKey: e.target.value }))} className={INPUT_CLASS} />
            </FormField>
          ) : (
            <FormField label="Env variable" hint={envHint ? `For example ${envHint}` : null} compact>
              <input id={`pool-env-${service.id}`} type="text" value={draft.envVar} onChange={(e) => setDraft((prev) => ({ ...prev, envVar: e.target.value.toUpperCase() }))} className={INPUT_CLASS} />
            </FormField>
          )}
          <FormField label="Label (optional)" compact>
            <input id={`pool-label-${service.id}`} type="text" value={draft.label} onChange={(e) => setDraft((prev) => ({ ...prev, label: e.target.value }))} className={INPUT_CLASS} />
          </FormField>
        </div>
        <button type="button" disabled={busy || !canAdd} onClick={add} className="px-3 py-1.5 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50">
          Add to pool
        </button>
      </div>
    </section>
  );
}
