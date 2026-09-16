import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, CreditCard, RefreshCw, Save } from 'lucide-react';
import * as api from '../../services/api';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import PageSkeleton from '../ui/PageSkeleton';
import Pill from '../ui/Pill';
import ToggleSwitch from '../ToggleSwitch';
import UsageMeter from '../usage/UsageMeter';
import { parseCostInput } from '../usage/SubscriptionSavingsCard';
import { formatUsd } from '../../utils/formatters';

/**
 * Subscriptions — which AI plans this install pays for, whether each is on, and
 * what each is costing against what it did.
 *
 * The answer used to be spread across three places: enable/disable lived on the
 * Providers page (per provider, not per plan), the price lived in an editor
 * buried inside the Usage report, and the quota meters lived on a third card.
 * This tab is the one row per plan that joins them (#7403).
 *
 * METADATA ONLY, and the page says so in its own copy: the toggle flips
 * PortOS-side enablement — the `enabled` flag on that family's provider records,
 * which is what `resolveEnabledFamilies` reads — and never reaches a vendor's
 * billing system. Nothing here purchases, cancels, upgrades or downgrades a
 * plan at Anthropic, OpenAI, Google or xAI.
 *
 * Three reads, because they answer three different questions and each has its
 * own cost: `getSubscriptions` is the plan model (cheap, always), `getUsage` is
 * what the window spent (a report build), `getProviderUsage` is the live quota
 * (a multi-second CLI scrape per family, so it lands last and never blocks the
 * rows). The period lives in `?period` rather than local state, so a window is
 * shareable and survives a reload.
 */

const PERIOD_OPTIONS = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' },
];

const DEFAULT_PERIOD = '30d';

// Empty-but-stable, so a payload that carries no rows can't re-run the memo
// below on every render.
const NO_ROWS = [];

const savingsTone = (savings) => (savings >= 0 ? 'text-port-success' : 'text-port-error');

/**
 * Parse a tier input to the patch value the API expects: a trimmed label, or
 * `null` to CLEAR it. Empty means "I'm not recording a tier", which must be
 * SENT (as null) rather than omitted — omitting it would leave the old tier in
 * place, so a user who upgraded off a named plan could never remove the label.
 */
export function parseTierInput(raw) {
  const trimmed = String(raw ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The per-family patches a row's drafts represent, or `null` when nothing
 * actually changed. Unchanged fields are omitted so one save never rewrites a
 * value the user didn't touch, and an unparseable price is skipped rather than
 * silently clearing a price that was merely fat-fingered.
 */
export function buildRowPatch(row, draft) {
  if (!draft) return null;
  const patch = {};
  if (draft.cost !== undefined) {
    const nextCost = parseCostInput(draft.cost);
    const storedCost = row.monthlyCost > 0 ? row.monthlyCost : null;
    if (nextCost !== undefined && nextCost !== storedCost) patch.cost = nextCost;
  }
  if (draft.tier !== undefined) {
    const nextTier = parseTierInput(draft.tier);
    if (nextTier !== (row.planTier ?? null)) patch.tier = nextTier;
  }
  return Object.keys(patch).length ? patch : null;
}

// The stored value a row's input shows while it is untouched. The draft map
// holds ONLY edited fields, so a period change (which refetches and hands down
// fresh rows) can't clobber something the user is mid-way through typing.
const draftValue = (draft, key, stored) => (draft?.[key] !== undefined ? draft[key] : stored);

/** The three derived money figures, defined once for every row. */
const rowFigures = (savingsRow) => {
  if (!savingsRow) return [];
  return [
    { key: 'period', label: 'This period', value: savingsRow.configured ? formatUsd(savingsRow.periodCost) : null },
    { key: 'api', label: 'Est. API cost', value: formatUsd(savingsRow.apiCost) },
    {
      key: 'savings',
      label: 'Savings',
      value: savingsRow.configured ? formatUsd(savingsRow.savings, { signed: true }) : null,
      tone: savingsRow.configured ? savingsTone(savingsRow.savings) : undefined,
    },
  ];
};

function QuotaSummary({ quota }) {
  if (!quota) {
    return <p className="text-xs text-gray-500">No quota reading — the plan is off, or its CLI reports no usage surface.</p>;
  }
  if (quota.pending) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <BrailleSpinner />
        <span>{quota.note || 'Reading quota…'}</span>
      </div>
    );
  }
  if (!quota.supported) {
    return <p className="text-xs text-gray-500">{quota.note || 'Usage reporting is not available for this provider.'}</p>;
  }
  if (quota.error) {
    return (
      <div role="status" className="flex items-start gap-1.5 text-xs text-gray-400">
        <AlertTriangle size={14} className="text-port-warning mt-0.5 shrink-0" />
        <span>{quota.error}</span>
      </div>
    );
  }
  if (!quota.limits?.length) {
    return <p className="text-xs text-gray-500">No rate-limit data reported</p>;
  }
  return (
    <div aria-label={`${quota.label} quota`}>
      {quota.limits.map((limit) => <UsageMeter key={limit.key} limit={limit} />)}
    </div>
  );
}

function SubscriptionRow({ row, savingsRow, quota, draft, busy, onDraft, onSave, onToggle }) {
  const patch = buildRowPatch(row, draft);
  const figures = rowFigures(savingsRow);
  const toggleable = row.providers.length > 0;
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm sm:text-base font-semibold text-white truncate">
            {row.label}
            {row.planTier && <Pill tone="context" size="xs" className="ml-2 align-middle">{row.planTier}</Pill>}
          </h3>
          <p className="text-[10px] sm:text-xs text-gray-500 mt-0.5">
            {toggleable
              ? `${row.providers.length} provider${row.providers.length === 1 ? '' : 's'} · ${row.enabled ? 'on' : 'off'}`
              : 'No provider configured — price kept for the record'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {busy && <BrailleSpinner />}
          <ToggleSwitch
            size="sm"
            enabled={row.enabled}
            disabled={busy || !toggleable}
            onChange={() => onToggle(row)}
            ariaLabel={`${row.enabled ? 'Disable' : 'Enable'} the ${row.label} subscription`}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`subscription-tier-${row.family}`} className="block text-[10px] sm:text-xs text-gray-400 mb-1">
            Plan
          </label>
          <input
            id={`subscription-tier-${row.family}`}
            type="text"
            maxLength={60}
            placeholder="e.g. Max 20x"
            aria-label={`Plan tier for ${row.label}`}
            value={draftValue(draft, 'tier', row.planTier ?? '')}
            onChange={(e) => onDraft(row.family, 'tier', e.target.value)}
            className="w-36 sm:w-44 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white outline-none focus:border-port-accent"
          />
        </div>
        <div>
          <label htmlFor={`subscription-cost-${row.family}`} className="block text-[10px] sm:text-xs text-gray-400 mb-1">
            Monthly cost
          </label>
          <div className="flex items-center gap-1">
            <span className="text-gray-500 text-xs">$</span>
            <input
              id={`subscription-cost-${row.family}`}
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              placeholder="0"
              aria-label={`Monthly cost for ${row.label}`}
              value={draftValue(draft, 'cost', row.monthlyCost > 0 ? String(row.monthlyCost) : '')}
              onChange={(e) => onDraft(row.family, 'cost', e.target.value)}
              className="w-20 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white outline-none focus:border-port-accent"
            />
            <span className="text-gray-500 text-xs">/mo</span>
          </div>
        </div>
        {patch && (
          <button
            type="button"
            onClick={() => onSave(row, patch)}
            disabled={busy}
            aria-label={`Save the ${row.label} plan`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-port-accent px-3 py-1.5 text-sm text-white hover:bg-port-accent/20 disabled:opacity-50"
          >
            <Save size={14} /> Save
          </button>
        )}
      </div>

      {figures.length > 0 && (
        <div className="grid grid-cols-3 gap-2 text-[11px] sm:text-xs">
          {figures.map((figure) => (
            <div key={figure.key}>
              <span className="text-gray-500 block">{figure.label}</span>
              <span className={figure.tone || 'text-white'}>
                {figure.value ?? <span className="text-gray-600">not priced</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-port-border pt-2">
        <QuotaSummary quota={quota} />
      </div>
    </div>
  );
}

export default function SubscriptionsTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = searchParams.get('period') || DEFAULT_PERIOD;

  const [overview, setOverview] = useState(null);
  const [savings, setSavings] = useState(null);
  const [quotas, setQuotas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState({});
  const [busyFamilies, setBusyFamilies] = useState(() => new Set());

  const loadPlans = useCallback(async () => {
    const data = await api.getSubscriptions({ silent: true }).catch(() => null);
    if (data) setOverview(data);
    return data;
  }, []);

  const loadSavings = useCallback(async () => {
    const data = await api.getUsage({ period }).catch(() => null);
    setSavings(data?.subscriptionSavings ?? null);
  }, [period]);

  const loadQuotas = useCallback(async (refresh = false) => {
    const data = await api.getProviderUsage({ refresh }).catch(() => null);
    // A failed read keeps whatever was already on screen: the meters are
    // supporting detail here, and blanking them would look like "the plan has
    // no quota" rather than "the scrape didn't answer".
    if (data?.providers) setQuotas(data.providers);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Plans and figures gate the first paint; the quota scrape is fired
    // alongside them but never held for — it is seconds slower per family.
    Promise.all([loadPlans(), loadSavings()]).then(() => {
      if (!cancelled) setLoading(false);
    });
    loadQuotas();
    return () => { cancelled = true; };
  }, [loadPlans, loadSavings, loadQuotas]);

  const setPeriod = (id) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id === DEFAULT_PERIOD) next.delete('period');
    else next.set('period', id);
    return next;
  }, { replace: true });

  const rows = overview?.families ?? NO_ROWS;
  const savingsByFamily = useMemo(
    () => new Map((savings?.families ?? NO_ROWS).map((entry) => [entry.family, entry])),
    [savings],
  );
  const quotaByFamily = useMemo(
    () => new Map((quotas ?? NO_ROWS).map((entry) => [entry.family, entry])),
    [quotas],
  );

  const withBusy = async (family, fn) => {
    setBusyFamilies((prev) => new Set(prev).add(family));
    await fn();
    setBusyFamilies((prev) => {
      const next = new Set(prev);
      next.delete(family);
      return next;
    });
  };

  const onDraft = (family, key, value) => setDrafts((prev) => ({
    ...prev,
    [family]: { ...prev[family], [key]: value },
  }));

  const onSave = (row, patch) => withBusy(row.family, async () => {
    // Two independent stored maps, so two calls — and both are awaited before
    // the refetch, or the rows would repaint from a half-applied save.
    if (patch.cost !== undefined) {
      await api.updateSubscriptionCosts({ [row.family]: patch.cost }, { silent: true }).catch(() => null);
    }
    if (patch.tier !== undefined) {
      await api.updateSubscriptionPlanTiers({ [row.family]: patch.tier }, { silent: true }).catch(() => null);
    }
    await Promise.all([loadPlans(), loadSavings()]);
    // Cleared only after the refetch lands: dropping the draft first would
    // flash the pre-save value back onto the row in between.
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[row.family];
      return next;
    });
  });

  const onToggle = (row) => withBusy(row.family, async () => {
    const result = await api.setSubscriptionEnabled(
      { family: row.family, enabled: !row.enabled },
      { silent: true },
    ).catch(() => null);
    if (!result) return;
    // Re-read rather than patching state locally: enablement is derived from
    // the provider records, so the server's answer is the only one that can't
    // drift from what `resolveEnabledFamilies` will report next.
    await Promise.all([loadPlans(), loadSavings()]);
    // The quota card set follows enablement — a family that just went off has
    // no reading to show, and one that came on needs its first scrape.
    loadQuotas();
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-2">
            <CreditCard size={20} className="text-port-accent" /> Subscriptions
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Which AI plans this install pays for, whether each is switched on, and what each costs against what it did.
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadQuotas(true)}
          className="flex items-center gap-1.5 self-start px-2 sm:px-3 py-1.5 text-xs sm:text-sm text-gray-400 hover:text-white"
          title="Re-read every plan's quota"
        >
          <RefreshCw size={15} className="will-change-transform" /> Refresh quota
        </button>
      </div>

      <Banner tone="info">
        PortOS tracking only. Switching a subscription off here stops this install dispatching work to that plan — it
        does not change, pause or cancel anything with the provider. Manage real billing on the provider&rsquo;s own site.
      </Banner>

      <div className="flex flex-wrap gap-2">
        {PERIOD_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setPeriod(option.id)}
            className={`px-3 py-1 rounded-full text-xs sm:text-sm border ${period === option.id
              ? 'border-port-accent text-white bg-port-accent/20'
              : 'border-port-border text-gray-400 hover:text-white'}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading && (
        <PageSkeleton header="none" label="Loading subscriptions" layout="grid" gridColsClass="grid-cols-1 lg:grid-cols-2" cards={4} />
      )}

      {!loading && rows.length === 0 && (
        <p className="text-sm text-gray-500">
          No subscriptions to manage — configure a Claude, Codex, Antigravity or Grok provider, or record a plan price,
          and it will appear here.
        </p>
      )}

      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start" aria-label="AI subscriptions">
          {rows.map((row) => (
            <SubscriptionRow
              key={row.family}
              row={row}
              savingsRow={savingsByFamily.get(row.family)}
              quota={quotaByFamily.get(row.family)}
              draft={drafts[row.family]}
              busy={busyFamilies.has(row.family)}
              onDraft={onDraft}
              onSave={onSave}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
