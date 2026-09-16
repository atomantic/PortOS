import { useCallback, useEffect, useMemo, useState } from 'react';
import { CreditCard, RefreshCw, Save } from 'lucide-react';
import * as api from '../../services/api';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import PageSkeleton from '../ui/PageSkeleton';
import Pill from '../ui/Pill';
import ToggleSwitch from '../ToggleSwitch';
import ProviderQuotaBody from '../usage/ProviderQuotaBody';
import {
  CellValue,
  CostInput,
  parseCostInput,
  rowCells,
} from '../usage/SubscriptionSavingsCard';
import useUrlParams from '../../hooks/useUrlParams';
import { USAGE_PERIOD_OPTIONS, resolveUsagePeriod, DEFAULT_USAGE_PERIOD } from '../../lib/usagePeriods';

/**
 * Subscriptions — which AI plans this install pays for, whether each is on, and
 * what each is costing against what it did.
 *
 * The answer used to be spread across three places: enable/disable lived on the
 * Providers page (per provider, not per plan), the price lived in an editor
 * buried inside the Usage report, and the quota meters lived on a third card.
 * This tab is the one row per plan that joins them (#7403). The money cells,
 * the price widget and the quota ladder are the Usage page's own components, so
 * the two surfaces cannot come to disagree about the same reading.
 *
 * METADATA ONLY — the toggle flips PortOS-side enablement and never reaches a
 * vendor's billing system. The contract lives with the write that implements it
 * (`server/services/subscriptions.js`); the on-page Banner states it for the
 * user.
 *
 * Two reads on two different clocks: the plan rows and the quota scrape do not
 * depend on the report window, so a period click refetches ONLY the spend
 * figures — re-running `getProviderUsage` would respawn a multi-second CLI
 * scrape per family for numbers that never moved.
 */

const NO_ROWS = [];

/**
 * Parse a tier input to the patch value the API expects: a trimmed label, or
 * `null` to CLEAR it. Empty means "I'm not recording a tier", which must be
 * SENT (as null) rather than omitted — omitting it would leave the old tier in
 * place, so a user who moved off a named plan could never remove the label.
 */
export function parseTierInput(raw) {
  const trimmed = String(raw ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The per-family patch a row's drafts represent, or `null` when nothing
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
// fresh figures) can't clobber something the user is mid-way through typing.
const draftValue = (draft, key, stored) => (draft?.[key] !== undefined ? draft[key] : stored);

/**
 * The tier to SHOW for a plan: what the user recorded, else what the install
 * already scraped out of the CLI (`quota.plan`, the same value the Usage page
 * pills). Without the fallback a user would type "Max 20x" for a plan PortOS
 * already reports, and the two pages could pill different answers for one plan.
 * The stored value stays the override — a scrape that reads `unknown` is
 * exactly why the field exists.
 */
export const resolvePlanTier = (row, quota) => {
  if (row.planTier) return row.planTier;
  const scraped = quota?.plan;
  return scraped && scraped !== 'unknown' ? scraped : null;
};

function SubscriptionRow({ row, savingsRow, quota, draft, busy, onDraft, onSave, onToggle }) {
  const patch = buildRowPatch(row, draft);
  const toggleable = row.providers.length > 0;
  const shownTier = resolvePlanTier(row, quota);
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm sm:text-base font-semibold text-white truncate">
            {row.label}
            {shownTier && <Pill tone="context" size="xs" className="ml-2 align-middle">{shownTier}</Pill>}
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
            // The scraped plan name, when there is one, so the field shows what
            // it would record rather than an invented example.
            placeholder={quota?.plan && quota.plan !== 'unknown' ? quota.plan : 'e.g. Max 20x'}
            aria-label={`Plan tier for ${row.label}`}
            value={draftValue(draft, 'tier', row.planTier ?? '')}
            onChange={(e) => onDraft(row.family, 'tier', e.target.value)}
            className="w-36 sm:w-44 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white outline-none focus:border-port-accent"
          />
        </div>
        <div>
          <label htmlFor={`subscriptions-subscription-cost-${row.family}`} className="block text-[10px] sm:text-xs text-gray-400 mb-1">
            Monthly cost
          </label>
          <CostInput
            row={row}
            idPrefix="subscriptions"
            value={draftValue(draft, 'cost', row.monthlyCost > 0 ? String(row.monthlyCost) : '')}
            onChange={(family, value) => onDraft(family, 'cost', value)}
          />
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

      {savingsRow && (
        <div className="grid grid-cols-3 gap-2 text-[11px] sm:text-xs">
          {rowCells(savingsRow).map((cell) => (
            <div key={cell.key}>
              <span className="text-gray-500 block">{cell.label}</span>
              <CellValue cell={cell} />
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-port-border pt-2">
        {quota
          ? <ProviderQuotaBody quota={quota} showActivity={false} showNote={false} />
          : <p className="text-xs text-gray-500">No quota reading — the plan is off, or its CLI reports no usage surface.</p>}
      </div>
    </div>
  );
}

export default function SubscriptionsTab() {
  const [searchParams, updateParams] = useUrlParams();
  const period = resolveUsagePeriod(searchParams.get('period'));

  const [rows, setRows] = useState(null);
  const [savings, setSavings] = useState(null);
  const [quotas, setQuotas] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [busyFamily, setBusyFamily] = useState(null);

  const loadPlans = useCallback(async () => {
    const data = await api.getSubscriptions({ silent: true }).catch(() => null);
    if (data?.families) setRows(data.families);
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

  // Window-INDEPENDENT reads, once. `loadQuotas` is deliberately not awaited
  // with the rows: it is a CLI scrape per family and must never gate the page.
  useEffect(() => {
    loadPlans();
    loadQuotas();
  }, [loadPlans, loadQuotas]);

  // Window-dependent read, re-run per period click — and only this one.
  useEffect(() => { loadSavings(); }, [loadSavings]);

  const setPeriod = (id) => updateParams(
    { period: id === DEFAULT_USAGE_PERIOD ? null : id },
    { replace: true },
  );

  const savingsByFamily = useMemo(
    () => new Map((savings?.families ?? NO_ROWS).map((entry) => [entry.family, entry])),
    [savings],
  );
  const quotaByFamily = useMemo(
    () => new Map((quotas ?? NO_ROWS).map((entry) => [entry.family, entry])),
    [quotas],
  );

  const onDraft = (family, key, value) => setDrafts((prev) => ({
    ...prev,
    [family]: { ...prev[family], [key]: value },
  }));

  // One row saves at a time — each row's own controls are disabled while it is
  // in flight, so a single slot says everything a set would.
  const withBusy = async (family, fn) => {
    setBusyFamily(family);
    await fn();
    setBusyFamily(null);
  };

  const onSave = (row, patch) => withBusy(row.family, async () => {
    // One request for both maps, and its response IS the refreshed row set —
    // no follow-up GET. Only a PRICE moves the savings figures, so a tier-only
    // edit must not trigger a full report + fleet rebuild.
    const body = {};
    if (patch.cost !== undefined) body.costs = { [row.family]: patch.cost };
    if (patch.tier !== undefined) body.tiers = { [row.family]: patch.tier };
    const result = await api.updateSubscriptions(body, { silent: true }).catch(() => null);
    if (result?.families) setRows(result.families);
    if (patch.cost !== undefined) await loadSavings();
    // Cleared only after the new rows land: dropping the draft first would
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
    if (!result?.families) return;
    // The handler's own re-read, not a local patch: enablement is DERIVED from
    // the provider records, so the server's answer is the only one that can't
    // drift from what `resolveEnabledFamilies` will report next.
    setRows(result.families);
    await loadSavings();
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
        {USAGE_PERIOD_OPTIONS.map((option) => (
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

      {!rows && (
        <PageSkeleton header="none" label="Loading subscriptions" layout="grid" gridColsClass="grid-cols-1 lg:grid-cols-2" cards={4} />
      )}

      {rows?.length === 0 && (
        <p className="text-sm text-gray-500">
          No subscriptions to manage — configure a Claude, Codex, Antigravity or Grok provider, or record a plan price,
          and it will appear here.
        </p>
      )}

      {rows?.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start" aria-label="AI subscriptions">
          {rows.map((row) => (
            <SubscriptionRow
              key={row.family}
              row={row}
              savingsRow={savingsByFamily.get(row.family)}
              quota={quotaByFamily.get(row.family)}
              draft={drafts[row.family]}
              busy={busyFamily === row.family}
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
